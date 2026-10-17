// Shared scenario selection. Filter before running a scenario, never resize a
// phone fixture and then call its phone assertions desktop coverage.
function target(value = process.env.PIVANE_BROWSER_TARGET || 'all') {
    if (!['all', 'desktop'].includes(value)) throw Error('Unknown browser target: ' + value);
    return value;
}
function widthOf(value) {
    if (typeof value === 'number') return value;
    if (value && typeof value.width === 'number') return value.width;
    if (Array.isArray(value)) {
        for (const part of value) { const width = widthOf(part); if (width !== undefined) return width; }
    }
}
function browserTargetEnabled(value, selected = target()) {
    const width = widthOf(value);
    if (width === undefined) throw Error('Browser target requires an explicit viewport width');
    return selected === 'all' || width > 900;
}
function selectBrowserTargets(values, selected = target()) {
    target(selected);
    return values.filter(value => browserTargetEnabled(value, selected));
}
module.exports = { target, selectBrowserTargets, browserTargetEnabled };
