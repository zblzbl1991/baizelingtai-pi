// Pivane-owned integration catalog; vendor manifests and source remain upstream originals.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const catalog = Object.freeze([
    Object.freeze({ id: 'subagents', name: 'pi-subagents', version: '0.74.0', directory: 'vendor/pi-subagents',
        repository: 'nicobailon/pi-subagents', mode: 'package' }),
    Object.freeze({ id: 'memory', name: 'pi-hermes-memory', version: '0.9.9', directory: 'vendor/pi-hermes-memory',
        repository: 'chandra447/pi-hermes-memory', mode: 'adapter' }),
    Object.freeze({ id: 'web', name: 'pi-web-access', version: '0.39.0', directory: 'vendor/pi-web-access',
        repository: 'nicobailon/pi-web-access', mode: 'package' }),
    Object.freeze({ id: 'computer', name: '@injaneity/pi-computer-use', version: '0.5.1', directory: 'vendor/pi-computer-use',
        repository: 'injaneity/pi-computer-use', mode: 'package' }),
    Object.freeze({ id: 'presentations', name: 'pivane-presentations', version: '1.0.0', directory: 'pi-packages/presentations',
        repository: 'op7418/guizang-ppt-skill', mode: 'package' }),
    Object.freeze({ id: 'document-review', name: 'pivane-document-review', version: '1.0.0', directory: 'pi-packages/document-review',
        mode: 'package' }),
    Object.freeze({ id: 'gongwen', name: 'pivane-gongwen', version: '1.0.0', directory: 'pi-packages/gongwen',
        repository: 'imhuhe/gongwen-kit', mode: 'package' }),
    Object.freeze({ id: 'officecli', name: 'pivane-officecli', version: '1.0.0', directory: 'pi-packages/officecli', mode: 'package' })
]);
const packagePath = entry => path.join(root, entry.directory);
const memoryBundle = () => path.join(root, 'server/profile-memory/upstream-bundle.mjs');
module.exports = { catalog, packagePath, memoryBundle };
