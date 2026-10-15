const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fork}=require('node:child_process'),{once}=require('node:events');
test('an isolated source upgrade keeps personal settings and old frozen rule behavior while new batches use changed rule content', {timeout:180000}, async()=>{
    const repository=path.resolve(__dirname,'..'),root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pivane-compliance-upgrade-'))),agent=path.join(root,'agent'),cwd=path.join(root,'project'),installation=path.join(root,'installation');
    fs.mkdirSync(agent);fs.mkdirSync(cwd);let child,origin,revision,sequence=0,linked=false;
    const start=async source=>{
        child=fork(path.join(__dirname,'compliance-lifecycle-fixture.cjs'),[],{execArgv:[],env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_PROJECT_ROOTS:root,PI_OFFLINE:'1',...(source?{PIVANE_TEST_UPGRADE_ROOT:source}:{})},stdio:['ignore','inherit','inherit','ipc']});
        origin=(await once(child,'message'))[0].origin;assert.ok(origin);
    };
    const close=async()=>{if(child?.connected){child.send({type:'close'});await once(child,'exit');}};
    const api=async(method,route,body)=>{const response=await fetch(origin+'/api/pi'+route,{method,headers:{Authorization:'Bearer synthetic-lifecycle','Content-Type':'application/json'},body:body&&JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));if(Number.isSafeInteger(data.revision))revision=data.revision;return data;};
    const write=async(route,body={},method='POST')=>{await api('GET','/compliance');return api(method,'/compliance'+route,{requestId:'upgrade-'+ ++sequence,expectedRevision:revision,...body});};
    try{
        fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'text',defaultProjectTrust:'never',enableInstallTelemetry:false}));
        fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic',models:[{id:'text',input:['text'],contextWindow:32000,maxTokens:1000}]}}}));
        await start();await write('/settings',{enabled:true,mainModel:{provider:'fixture',modelId:'text'}},'PUT');
        const profileId=(await api('GET','/compliance')).profileId,registry=await api('GET','/profiles'),profile=registry.profiles.find(p=>p.id===profileId);
        await api('PUT','/profiles',{expectedRevision:registry.revision,profile:{...profile,name:'个人审查名称',soul:'保留个人行为说明。'}});
        fs.mkdirSync(path.join(agent,'extensions'),{recursive:true});const extension='export default function personalFixture() {}\n';fs.writeFileSync(path.join(agent,'extensions','personal.ts'),extension);
        const session=await write('/sessions',{cwd}),nativeBefore=fs.readFileSync(session.path);
        const project=(await write('/projects',{project:{name:'规则升级工程',identityConfirmed:true,applicability:{'documents-identity':true,'contract-deadline':true,'feasibility-numbers':false,'feasibility-order':false}}})).project;
        const docs=(await write(`/projects/${project.id}/documents`,{sources:['2026-08-01','2026-08-21'].map((d,i)=>({kind:'upload',name:i+'.csv',base64:Buffer.from('项目名称,日期\n规则升级工程,'+d+'\n').toString('base64')}))})).documents;
        for(const [i,role] of ['award-notice','contract'].entries())await write(`/documents/${docs[i].id}/assignment`,{role,identityConfirmed:true,selected:true},'PUT');
        const old=(await write(`/projects/${project.id}/batches`)).batch;assert.equal(old.results.find(r=>r.id==='contract-deadline').conclusion,'passed');
        await close();
        // This is an actual isolated installation with revised source, not a
        // mocked RULE_PACKAGE or an edited persisted batch.
        fs.mkdirSync(installation);
        for(const folder of ['server','native','config','pi-packages'])fs.cpSync(path.join(repository,folder),path.join(installation,folder),{recursive:true});
        fs.mkdirSync(path.join(installation,'public'));for(const name of fs.readdirSync(path.join(repository,'public')))if(name.endsWith('.js'))fs.copyFileSync(path.join(repository,'public',name),path.join(installation,'public',name));
        fs.copyFileSync(path.join(repository,'package.json'),path.join(installation,'package.json'));
        fs.symlinkSync(fs.realpathSync.native(path.join(repository,'node_modules')),path.join(installation,'node_modules'),'junction');linked=true;
        const rules=path.join(installation,'server','pi-compliance-rules.js'),source=fs.readFileSync(rules,'utf8');assert.ok(source.includes('maximum: 30'));
        fs.writeFileSync(rules,source.replace("version: '1.0.0'","version: 'fixture-2.0.0'").replace('maximum: 30','maximum: 10'));
        await start(installation);
        const reopened=await api('GET','/compliance');assert.equal(reopened.profileId,profileId);const personal=(await api('GET','/profiles')).profiles.find(p=>p.id===profileId);assert.equal(personal.name,'个人审查名称');assert.equal(personal.soul,'保留个人行为说明。');assert.equal(fs.readFileSync(path.join(agent,'extensions','personal.ts'),'utf8'),extension);assert.deepEqual(fs.readFileSync(session.path),nativeBefore);
        assert.deepEqual((await api('GET',`/compliance/batches/${old.id}`)).batch,old);
        const prepared=(await write(`/batches/${old.id}/review-proposals`,{cwd,sessionId:session.id,batchRevision:old.revision,change:{kind:'field',documentId:docs[1].id,key:'date',raw:'2026-08-20',location:{sheet:'CSV',row:2,column:2,excerpt:'合同日期列'},reason:'升级后核对原件日期'}})).proposal;
        const corrected=(await write(`/review-proposals/${prepared.id}/confirm`,{cwd,sessionId:session.id,contentHash:prepared.contentHash})).batch;
        assert.equal(corrected.results.find(r=>r.id==='contract-deadline').conclusion,'passed');assert.equal(corrected.rulePackage.rules.find(r=>r.id==='contract-deadline').maximum,30);
        const fresh=(await write(`/projects/${project.id}/batches`)).batch,deadline=fresh.results.find(r=>r.id==='contract-deadline');
        assert.equal(fresh.rulePackage.version,'fixture-2.0.0');assert.equal(fresh.rulePackage.rules.find(r=>r.id==='contract-deadline').maximum,10);assert.equal(deadline.conclusion,'issue');assert.match(deadline.reason,/10/,'explanation must describe the frozen ten-day rule, not a hard-coded thirty-day policy');
        assert.equal((await api('GET',`/compliance/batches/${old.id}`)).batch.rulePackage.rules.find(r=>r.id==='contract-deadline').maximum,30);
    }finally{await close();if(linked){const link=path.join(installation,'node_modules');assert.equal(fs.lstatSync(link).isSymbolicLink(),true);fs.unlinkSync(link);}fs.rmSync(root,{recursive:true,force:true});}
});
