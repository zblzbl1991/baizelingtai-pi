const { xml } = require('../pi-document-parser');
const MAX_CHANGES = 200, MAX_STRING = 240;
const children = node => node.children.filter(child => typeof child === 'object');
const containers = new Set(['pPr', 'rPr', 'sectPr', 'settings']);
const historical = name => /Change$/.test(name) || ['ins', 'del', 'moveFrom', 'moveTo'].includes(name);
const missing = '（无直接定义；由继承或默认值决定）';
const definition = node => ({ ...(Object.keys(node.attrs).length ? { attributes: Object.fromEntries(Object.entries(node.attrs).sort(([a], [b]) => a.localeCompare(b, 'en'))) } : {}),
    ...(children(node).some(child => !historical(child.name)) ? { children: children(node).filter(child => !historical(child.name))
        .map(child => ({ name: child.qualified, ...definition(child) })) } : {}) });

// Only property definitions are compared, never paragraph text. Call before
// textual tracked edits split runs so these XML paths remain stable.
function formatSnapshot(parts) {
    const records = new Map();
    for (const [part, source] of Object.entries(parts)) {
        if (!source) continue;
        const root = xml(Buffer.from(source));
        function visit(node, location) {
            if (historical(node.name)) return;
            if (containers.has(node.name)) {
                const counts = new Map();
                for (const child of children(node)) {
                    if (historical(child.name) || ['pPr', 'rPr', 'sectPr'].includes(child.name)) continue;
                    const n = (counts.get(child.qualified) || 0) + 1; counts.set(child.qualified, n);
                    const where = `${location}/${child.qualified}[${n}]`;
                    // Attribute values are explicit definitions, not a claim
                    // about resolved fonts or the application's rendering.
                    const value = JSON.stringify(definition(child));
                    records.set(where, { where, property: child.qualified, value });
                }
            }
            const counts = new Map();
            for (const child of children(node)) {
                const n = (counts.get(child.qualified) || 0) + 1; counts.set(child.qualified, n);
                const identifier = child.name === 'style' && child.attrs['w:styleId'];
                const step = identifier ? `${child.qualified}[@w:styleId=${JSON.stringify(identifier)}]` : `${child.qualified}[${n}]`;
                visit(child, `${location}/${step}`);
            }
        }
        visit(root, `${part}/${root.qualified}[1]`);
    }
    return records;
}

function formatChanges(before, after) {
    const changes = []; let total = 0, truncated = false;
    const excerpt = value => { if (value.length <= MAX_STRING) return value; truncated = true; return value.slice(0, MAX_STRING - 1) + '…'; };
    for (const where of new Set([...before.keys(), ...after.keys()])) {
        const prior = before.get(where), next = after.get(where);
        if (prior?.value === next?.value) continue;
        total++;
        if (changes.length >= MAX_CHANGES) { truncated = true; continue; }
        const oldValue = prior?.value || missing, newValue = next?.value || missing;
        changes.push({ where: excerpt(where), property: excerpt((next || prior).property), before: excerpt(oldValue), after: excerpt(newValue),
            ...(where.length > MAX_STRING ? { whereTruncated: true } : {}),
            ...(oldValue.length > MAX_STRING ? { beforeTruncated: true } : {}),
            ...(newValue.length > MAX_STRING ? { afterTruncated: true } : {}) });
    }
    return { formatChanges: changes, formatChangesTotal: total, formatChangesTruncated: truncated };
}
module.exports = { formatSnapshot, formatChanges };
