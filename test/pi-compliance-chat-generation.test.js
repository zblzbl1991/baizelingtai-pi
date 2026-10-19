const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    const element = tag => ({
        tag, children: [], hidden: false, value: '', classList: { add() {} },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        setAttribute() {}, addEventListener() {}, focus() {}
    });
    const trigger = element('button'), drawer = element('aside'); drawer.hidden = true;
    const scope = { cwd: '/synthetic/project', sessionId: 'session-a', generation: 1, connected: true, profileId: 'compliance' };
    let materials;
    const window = {
        addEventListener() {},
        PiComplianceMaterials: { mount(options) { materials = options; } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pi-compliance.js'), 'utf8'), {
        window,
        document: { createElement: element, getElementById: id => id === 'pi-compliance-open' ? trigger : drawer },
        Option: function (text, value) { this.text = text; this.value = value; }
    });
    const controller = window.PiCompliance.createChat({
        context: () => scope,
        apiFetch: async route => route.endsWith('/projects')
            ? { projects: [{ id: 'project-a', name: 'Synthetic project', applicability: {} }] }
            : { enabled: true, profileId: 'compliance' }
    });
    async function openProject() {
        await controller.update();
        trigger.onclick();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drawer.hidden, false);
        drawer.children.find(child => child.className === 'compliance-project-list').children[0].onclick();
        assert.equal(materials.valid(), true);
        return materials;
    }
    return { controller, drawer, scope, openProject };
}

test('refreshing metadata in the same native session keeps the open compliance editor usable', async () => {
    const { controller, drawer, openProject } = fixture();
    const editor = await openProject();
    await controller.update();
    await controller.update();
    assert.equal(drawer.hidden, false);
    assert.equal(editor.valid(), true, 'a metadata refresh must not silently invalidate every editor action');
});

test('changing the socket generation still closes and invalidates the previous compliance editor', async () => {
    const { controller, drawer, scope, openProject } = fixture();
    const editor = await openProject();
    scope.generation++;
    await controller.update();
    assert.equal(drawer.hidden, true);
    assert.equal(editor.valid(), false);
});
