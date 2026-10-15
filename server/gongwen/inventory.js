const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const REVIEWED = Object.freeze({ version: '0.3.1', commit: 'd8dfe6a24e20ecaa64c14f3a79159813ad92db70',
    archiveSha256: 'ffd04e959ff3e060e803ddc750bc9b354aca61a18d98626c93297ccc78585be2',
    dependencies: Object.freeze({ docx: '9.7.1', jszip: '3.10.2', sax: '1.6.1' }) });
function verify() {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/manifest.json'), 'utf8'));
    const pkg = manifest.packages.find(item => item.name === 'gongwen-kit');
    if (!pkg || pkg.version !== REVIEWED.version || pkg.sourceRef !== REVIEWED.commit
        || pkg.sha256 !== REVIEWED.archiveSha256
        || !['data/style-words.tsv', 'data/yixingci.tsv', 'lib/gongwen-core.js', 'checks/check-doc.js', 'checks/check-num.js', 'checks/style-scan.js']
            .every(file => pkg.files.some(item => item.path === 'vendor/gongwen-kit/' + file))) throw Error('公文组件不符合审查清单');
    require('../../scripts/vendor-files.cjs').vendorFiles(root, { packageName: 'gongwen-kit' });
    for (const [name, version] of Object.entries(REVIEWED.dependencies)) {
        if (require.resolve(name, { paths: [path.join(root, 'vendor/gongwen-kit')] }) !== require.resolve(name, { paths: [root] })
            || JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version !== version) throw Error('公文依赖版本或解析不一致');
    }
}
module.exports = { verify, REVIEWED };
