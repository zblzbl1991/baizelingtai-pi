const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registryUrl, skillHubConfig, skillHubInstructions } = require('../server/pi-skillhub');

test('SkillHub config retains the selected registry and deployment subpath without credentials', () => {
    const config = skillHubConfig({ PIVANE_SKILLHUB_URL: 'http://skillhub.example.com/internal/', PIVANE_SKILLHUB_NAMESPACE: 'office' });
    assert.equal(config.registry, 'http://skillhub.example.com/internal');
    assert.equal(config.guideUrl, 'http://skillhub.example.com/internal/registry/skill.md');
    assert.equal(config.detailUrl, 'http://skillhub.example.com/internal/space/office/guizang-ppt-skill');
    assert.equal(config.namespace, 'office');
    assert.equal(skillHubConfig({}).registry, 'https://skill.xfyun.cn');
    for (const url of ['file:///tmp/skills', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com?token=secret', 'https://example.com/#x', 'https://example.com\n']) {
        assert.throws(() => registryUrl(url));
    }
    assert.throws(() => skillHubConfig({ PIVANE_SKILLHUB_URL: 'http://[invalid' }));
    assert.throws(() => skillHubConfig({ PIVANE_SKILLHUB_NAMESPACE: '../other' }));
});

test('SkillHub instructions bind installation to the actual identity and selected project', () => {
    const config = skillHubConfig({ PIVANE_SKILLHUB_URL: 'http://skillhub.example.com' });
    const cwd = path.resolve('synthetic-project'), agentDir = path.resolve('synthetic-identity');
    const facts = scope => JSON.parse(skillHubInstructions({ cwd, agentDir, scope }, config).split('\n')[0].split('): ')[1]);
    assert.equal(facts('global').directory, path.join(agentDir, 'skills'));
    assert.equal(facts('project').directory, path.join(cwd, '.pi', 'skills'));
    assert.equal(facts('global').registry, config.registry);
});
