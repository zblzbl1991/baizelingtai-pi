// Explicit native acceptance; not part of npm test. Uses synthetic fixtures only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
const repository = path.resolve(__dirname, '../..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wait = async (predicate, message, milliseconds = 10000) => { const until = Date.now() + milliseconds; while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error(message); };
function privateEnvironment(env) {
    const filtered = require('../../scripts/run-tests.cjs').testEnvironment(env);
    for (const key of Object.keys(filtered)) if (key.startsWith('PI_')) delete filtered[key];
    return filtered;
}
function treeBytes(directory) {
    let bytes = 0, files = 0, directories = 0, transientGaps = 0;
    const visit = dir => { let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (error) { if (['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes(error.code)) { transientGaps++; return; } throw error; }
        for (const item of entries) {
        const name = path.join(dir, item.name); let stat; try { stat = fs.lstatSync(name); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isSymbolicLink()) throw new Error('Unexpected link in native test scratch');
        if (stat.isDirectory()) { directories++; visit(name); } else { files++; bytes += stat.size; }
        assert.ok(files + directories <= 100000 && bytes < 512 * 1024 ** 2, 'native scratch observation remains bounded');
    } };
    visit(directory); return { bytes, files, directories, transientGaps };
}
function powershell(script, options = {}) {
    return spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
async function collect(child) {
    let stdout = '', stderr = ''; child.stdout?.on('data', b => stdout += b); child.stderr?.on('data', b => stderr += b);
    const [code] = await once(child, 'close'); if (code !== 0) throw new Error('Synthetic native helper failed: ' + stderr.slice(0, 2000)); return stdout.replace(/^\uFEFF/, '').trim();
}
async function assertPrivate(directory) {
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        const source = fs.readdirSync(directory).find(n => n.startsWith('source.')); assert.equal(fs.statSync(path.join(directory, source)).mode & 0o777, 0o600); return { mode: '0700/0600' };
    }
    const targets = Buffer.from(JSON.stringify([directory, ...fs.readdirSync(directory).filter(n => n.startsWith('source.')).map(n => path.join(directory, n))]), 'utf8').toString('base64');
    const output = await collect(powershell(`$ErrorActionPreference='Stop';$targets=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targets}')));$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544');$rows=@(foreach($target in $targets){$acl=Get-Acl -LiteralPath $target;$bad=@($acl.Access|Where-Object{$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed});@{private=($bad.Count -eq 0);protected=$acl.AreAccessRulesProtected}});ConvertTo-Json -Compress -InputObject $rows`));
    const rows = JSON.parse(output); assert.ok(rows.length >= 2 && rows.every(r => r.private && r.protected), 'native input and directory have protected private Windows DACLs');
    return { checked: rows.length, private: true, protected: true };
}
async function sampleProcesses(root, phase, samples) {
    if (process.platform !== 'win32') throw new Error('This explicit native sampling target requires Windows');
    const stop = path.join(root, 'sampler.stop'), encoded = Buffer.from(stop, 'utf8').toString('base64'); let ready;
    const started = new Promise(r => ready = r);
    const child = powershell(`$ErrorActionPreference='Stop';$taskRootPid=${process.pid};$stop=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));[Console]::WriteLine('{"ready":true}');while(-not [IO.File]::Exists($stop)){$all=@(Get-CimInstance Win32_Process);$ids=@($taskRootPid);for($level=0;$level -lt 8;$level++){$next=@($all|Where-Object{$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids -and $_.ProcessId -ne $PID}|ForEach-Object{$_.ProcessId});if(-not $next.Count){break};$ids+=$next};$rows=@($all|Where-Object{$_.ProcessId -in $ids -and $_.Name -in @('node.exe','libreoffice-kit.exe','soffice.bin','soffice.com')}|ForEach-Object{@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;rss=[long]$_.WorkingSetSize;handles=[long]$_.HandleCount;created=$_.CreationDate.ToUniversalTime().ToString('o')}});[Console]::WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject $rows));Start-Sleep -Milliseconds 150}`);
    let pending = '', errors = ''; child.stderr.on('data', b => errors += b);
    child.stdout.on('data', b => { pending += b.toString('utf8'); let at; while ((at = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1); if (!line) continue; const value = JSON.parse(line); if (value.ready) ready(); else samples.push({ time: Date.now(), phase: phase.value, processes: value }); } });
    await started;
    return async () => { fs.writeFileSync(stop, 'stop'); const [code] = await once(child, 'close'); assert.equal(code, 0, errors.slice(0, 1000)); };
}
async function nativeSurvivors(samples) {
    const observed = samples.flatMap(sample => sample.processes.filter(row => row.name !== 'node.exe'));
    const identities = new Set(observed.map(row => row.pid + ':' + row.created));
    if (!identities.size) return [];
    const ids = [...new Set(observed.map(row => row.pid))].join(',');
    const output = await collect(powershell(`$rows=@(Get-CimInstance Win32_Process|Where-Object{$_.ProcessId -in @(${ids})}|ForEach-Object{@{pid=[int]$_.ProcessId;name=$_.Name;created=$_.CreationDate.ToUniversalTime().ToString('o')}});ConvertTo-Json -Compress -InputObject $rows`));
    return JSON.parse(output).filter(row => identities.has(row.pid + ':' + row.created));
}
async function authorLegacy(soffice, source, output, profile, temporary) {
    const child = spawn(soffice, ['-env:UserInstallation=' + pathToFileURL(profile).href, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'doc:MS Word 97', '--outdir', output, source], { env: { ...privateEnvironment(process.env), TEMP: temporary, TMP: temporary, TMPDIR: temporary }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await collect(child); const file = path.join(output, path.basename(source, '.docx') + '.doc'); assert.ok(fs.existsSync(file), 'independent legacy export exists');
    return { file, output: result.slice(0, 1000) };
}
async function pdfText(bytes) {
    const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href), task = pdfjs.getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
    try { const document = await task.promise; let text = ''; for (let p = 1; p <= document.numPages; p++) text += (await (await document.getPage(p)).getTextContent()).items.map(i => i.str).join(' '); return { pages: document.numPages, text }; }
    finally { await task.destroy(); }
}
async function main(options = {}) {
    const { privateDir } = require('../../server/pi-maintenance-files');
    const root = privateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-security-'))), project = privateDir(path.join(root, 'project')), operations = privateDir(path.join(root, 'operations'));
    Object.assign(process.env, { PI_CODING_AGENT_DIR: privateDir(path.join(root, 'agent')), PI_PROJECT_ROOTS: project, PI_OFFLINE: '1' });
    const { createOfficePreviewEngine } = require('../../server/office-preview/engine'), { OfficePreviewService } = require('../../server/pi-office-previews');
    const { OfficePreviewSources } = require('../../server/pi-office-preview-sources'), { PiFileService } = require('../../server/pi-file-service'), { PiSessionStore } = require('../../server/pi-session-store');
    const { officeZip } = require('../../server/pi-document-parser'), { zip } = require('../document-fixtures.cjs');
    const phase = { value: 'baseline' }, report = { platform:process.platform, arch:process.arch, node:process.version, inventorySha256:hash(fs.readFileSync(path.join(repository,'config/office-preview-assets.json'))), samples:[], scratchSamples:[], canary:[], conversions:[], errors:[], limitations:['Not an OS network/filesystem sandbox or an RSS hard cap.','Local canary absence in PDF is content evidence, not a filesystem-open audit.','Runnable macro plus positive execution control is not available; macro tests prove admission only.'] };
    let stopSampling, timer, server, engine, service;
    try {
        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'), token = randomUUID();
        const textCanary = 'PIVANE_LOCAL_' + token; fs.writeFileSync(path.join(root,'outside-canary.txt'),textCanary); fs.writeFileSync(path.join(root,'outside-canary.png'),image);
        server = http.createServer((request,response) => { report.canary.push({phase:phase.value,method:request.method,url:request.url}); response.setHeader('Content-Type',request.url.includes('image')?'image/png':'text/plain'); response.end(request.url.includes('image')?image:'PIVANE_HTTP_'+token); });
        server.listen(0,'127.0.0.1'); await once(server,'listening'); const endpoint=`http://127.0.0.1:${server.address().port}/${token}`;
        phase.value='canary-positive-control';
        const control = await new Promise((resolve,reject)=>{http.get(endpoint+'/control',response=>{let body='';response.on('data',bytes=>body+=bytes);response.on('end',()=>resolve(body));}).on('error',reject);});
        assert.equal(control,'PIVANE_HTTP_'+token); assert.equal(report.canary.length,1); report.canaryPositiveControl=true;
        stopSampling = await sampleProcesses(root,phase,report.samples);
        timer = setInterval(()=>{try{report.scratchSamples.push({time:Date.now(),phase:phase.value,rss:process.memoryUsage().rss,...treeBytes(operations)});}catch(error){report.errors.push({message:'Scratch sampler: '+error.message});clearInterval(timer);}},25);
        engine = createOfficePreviewEngine({tempRoot:operations}); let nativeCalls=0; const convert=engine.convert; engine.convert=(...args)=>{nativeCalls++;return convert(...args);};
        const sources = new OfficePreviewSources({files:new PiFileService(new PiSessionStore())}); service = new OfficePreviewService({sources,engine});
        phase.value='cold-health'; let started=Date.now(); assert.equal((await service.status()).available,true); report.coldHealthMs=Date.now()-started;
        const preview=async(name,bytes,format='docx',extra={})=>{fs.writeFileSync(path.join(project,name),bytes);const started=Date.now(),response=await service.preview({source:{type:'project',cwd:project,path:name},...extra});const rendered=Buffer.from(response.preview.base64,'base64');report.conversions.push({phase:phase.value,name,format,sourceSha256:hash(bytes),sourceBytes:bytes.length,outputSha256:hash(rendered),outputBytes:rendered.length,milliseconds:Date.now()-started,warnings:response.warnings});assert.equal(response.source.revision,hash(bytes));return rendered;};
        const original=fs.readFileSync(path.join(__dirname,'../fixtures/office/rich.docx'));
        phase.value='cold-document'; await preview('rich.docx',original); const afterCold=nativeCalls;
        phase.value='cache-hit'; await preview('rich.docx',original); assert.equal(nativeCalls,afterCold); report.cacheShared=true;
        const archive=officeZip(original), files=Object.fromEntries(archive.names.filter(n=>!n.endsWith('/')).map(n=>[n,archive.read(n)]));
        const escape=value=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const fields=[['INCLUDETEXT',endpoint+'/text'],['INCLUDEPICTURE',endpoint+'/image'],['INCLUDETEXT',pathToFileURL(path.join(root,'outside-canary.txt')).href],['INCLUDEPICTURE',pathToFileURL(path.join(root,'outside-canary.png')).href]];
        const fieldXml=fields.map(([kind,target])=>`<w:p><w:fldSimple w:instr="${escape(kind+' "'+target+'" \\d')}" w:dirty="true"><w:r><w:t>FROZEN_FIELD_CACHE</w:t></w:r></w:fldSimple></w:p>`).join('');
        files['word/document.xml']=files['word/document.xml'].toString().replace('</w:body>',fieldXml+'</w:body>');const fieldBytes=zip(files);
        phase.value='native-fields-docx';let output=await preview('fields.docx',fieldBytes), observed=await pdfText(output); assert.ok(observed.text.includes('FROZEN_FIELD_CACHE'));assert.ok(!observed.text.includes('PIVANE_HTTP_'+token)&&!observed.text.includes(textCanary));assert.equal(report.canary.filter(h=>h.phase===phase.value).length,0);
        report.fieldCanaries={httpTargets:2,localOutsideProjectTargets:2,httpReads:0,pdfContainsFreshLocalMarker:false,pdfContainsFrozenCache:true};
        const externalFiles={...files};externalFiles['word/_rels/document.xml.rels']=externalFiles['word/_rels/document.xml.rels'].toString().replace('</Relationships>',`<Relationship Id="external-canary" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="${endpoint}/external-image"/></Relationships>`);
        phase.value='reject-external-modern';const before=nativeCalls;await assert.rejects(preview('external.docx',zip(externalFiles)),{code:'OFFICE_INVALID'});assert.equal(nativeCalls,before);
        phase.value='reject-macro-modern';const macro={...files,'word/vbaProject.bin':Buffer.from('ADMISSION_ONLY_NOT_RUNNABLE_VBA')};await assert.rejects(preview('macro.docx',zip(macro)),{code:'OFFICE_INVALID'});assert.equal(nativeCalls,before);report.macroAdmission={ooxml:true,runnableMacroExecution:'unverified'};
        if(options.authoringSoffice){
            phase.value='authoring-legacy';const authoring=privateDir(path.join(root,'authoring')),authoringTemp=privateDir(path.join(root,'authoring-temp'));const legacy=await authorLegacy(options.authoringSoffice,path.join(project,'fields.docx'),authoring,path.join(root,'authoring-profile'),authoringTemp),bytes=fs.readFileSync(legacy.file);
            phase.value='native-fields-doc';output=await preview('fields.doc',bytes,'doc');observed=await pdfText(output);assert.equal(report.canary.filter(h=>h.phase===phase.value).length,0);assert.ok(!observed.text.includes('PIVANE_HTTP_'+token)&&!observed.text.includes(textCanary));
            report.legacyFields={sourceSha256:hash(bytes),sourceBytes:bytes.length,actualIndependentWord97Export:true,httpReads:0,pdfContainsFreshLocalMarker:false,containsFieldInstruction:bytes.includes(Buffer.from('INCLUDETEXT','utf16le'))||bytes.includes(Buffer.from('INCLUDETEXT'))};assert.equal(report.legacyFields.containsFieldInstruction,true);
        }else report.limitations.push('Legacy linked-field conversion not run: pass --authoring-soffice for independently exported Word97 input.');
        phase.value='missing-font';const missing=fs.readFileSync(path.join(__dirname,'../fixtures/office/missing-font.docx'));await preview('missing.docx',missing);assert.ok(report.conversions.at(-1).warnings.some(w=>w.includes('PivaneFixtureMissingFont2026')));
        const generation=engine.generation;phase.value='missing-font-refresh';await preview('missing.docx',missing,'docx',{refresh:true});assert.notEqual(engine.generation,generation);assert.ok(report.conversions.at(-1).warnings.some(w=>w.includes('PivaneFixtureMissingFont2026')));report.fontRefresh={generationChanged:true,missingFontRetained:true};
        const {Document,Packer,Paragraph}=require('docx'),large=await Packer.toBuffer(new Document({sections:[{children:Array.from({length:2000},(_,i)=>new Paragraph(`Native cancellation fixture ${i} 中文 `+'bounded independent text '.repeat(25)))}]}));
        fs.writeFileSync(path.join(project,'cancel.docx'),large);phase.value='native-cancel';const controller=new AbortController(),pending=service.preview({source:{type:'project',cwd:project,path:'cancel.docx'}},controller.signal),rejection=assert.rejects(pending,{code:'OFFICE_ABORTED'});
        await wait(()=>fs.readdirSync(operations).length,'actual private conversion directory appears');const directory=path.join(operations,fs.readdirSync(operations)[0]);report.dacl=await assertPrivate(directory);
        await wait(()=>report.samples.some(s=>s.phase===phase.value&&s.processes.some(p=>p.name==='libreoffice-kit.exe')),'actual native PID was sampled before cancellation');
        const aborted=Date.now();controller.abort();const busyAfterAbort=service.busy;await rejection;report.cancellation={sourceSha256:hash(large),busyImmediatelyAfterAbort:busyAfterAbort,millisecondsUntilActualSettlement:Date.now()-aborted,remainingOperationDirectories:fs.readdirSync(operations),nativeSurvivors:await nativeSurvivors(report.samples.filter(s=>s.phase==='native-cancel'))};assert.equal(busyAfterAbort,true);assert.deepEqual(report.cancellation.nativeSurvivors,[]);assert.deepEqual(fs.readdirSync(operations),[]);assert.equal(service.busy,false);
        phase.value='settled';await service.dispose();engine=undefined;assert.deepEqual(fs.readdirSync(operations),[]);report.cleanup={operationsEmpty:true,serviceIdle:!service.busy};
    }catch(error){report.errors.push({name:error.name,message:error.message,code:error.code});}
    finally{
        if(timer)clearInterval(timer);await service?.dispose().catch(error=>report.errors.push({message:error.message}));await engine?.dispose().catch(error=>report.errors.push({message:error.message}));
        if(stopSampling)await stopSampling().catch(error=>report.errors.push({message:error.message}));if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
        const native=report.samples.flatMap(s=>s.processes.filter(p=>p.name==='libreoffice-kit.exe'));
        report.resourceSummary={samples:report.samples.length,resolution:'25ms JavaScript scratch/RSS; 150ms sleep plus Windows CIM query overhead; sampled peaks are lower bounds',nativePids:[...new Set(native.map(p=>p.pid))],nativePeakRss:native.length?Math.max(...native.map(p=>p.rss)):0,nativePeakHandles:native.length?Math.max(...native.map(p=>p.handles)):0,ownNodePeakRss:Math.max(0,...report.scratchSamples.map(s=>s.rss)),peakTempBytes:Math.max(0,...report.scratchSamples.map(s=>s.bytes)),peakTempFiles:Math.max(0,...report.scratchSamples.map(s=>s.files)),transientScratchObservationGaps:report.scratchSamples.reduce((sum,s)=>sum+s.transientGaps,0)};
        report.cleanup={...report.cleanup,finalOperationDirectoryCount:fs.readdirSync(operations).length};
        try {
            assert.equal(report.cleanup.finalOperationDirectoryCount,0);
            report.cleanup.nativeSurvivors=await nativeSurvivors(report.samples);assert.deepEqual(report.cleanup.nativeSurvivors,[]);
            fs.rmSync(root,{recursive:true,force:true});report.cleanup.syntheticRootRemoved=!fs.existsSync(root);
        } catch(error) { report.cleanup.retainedSyntheticRoot=root;report.errors.push({message:'Final cleanup: '+error.message}); }
        if(options.report)fs.writeFileSync(options.report,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.errors.length===0,resourceSummary:report.resourceSummary,errors:report.errors,limitations:report.limitations},null,2));
    }
    assert.equal(report.errors.length,0,'native security observations must satisfy each explicit assertion');return report;
}
function argumentsFor(argv){const options={};for(let i=0;i<argv.length;i++){if(argv[i]==='--report')options.report=path.resolve(argv[++i]);else if(argv[i]==='--authoring-soffice')options.authoringSoffice=path.resolve(argv[++i]);else if(argv[i]!=='--isolated')throw new Error('Unknown native security option');}return options;}
if(require.main===module){if(!process.argv.includes('--isolated')){const result=spawnSync(process.execPath,[__filename,'--isolated',...process.argv.slice(2)],{env:privateEnvironment(process.env),stdio:'inherit',windowsHide:true});process.exitCode=result.status??1;}else main(argumentsFor(process.argv.slice(2))).catch(error=>{console.error(error.stack);process.exitCode=1;});}
module.exports={main};
