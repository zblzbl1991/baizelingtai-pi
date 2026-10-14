import capabilities from './pi-bundled-capabilities.js';

export default function bundledGuidance(pi) {
    pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\n\n'
        + '白泽灵台 bundled resource policy: the following packages and skills ship with this application. '
        + 'Their versions are pinned and their source directories are read-only during normal tasks. '
        + 'Use the application update flow to update them; do not install another copy or modify their source. '
        + 'Upstream skill steps that run git fetch/pull from the skill directory do not apply to this bundled copy '
        + '(Git would resolve the containing application repository). Continue creating the requested artifact with the pinned skill. '
        + 'The bundled guizang-ppt-skill primarily creates HTML presentations, not editable PPTX. '
        + 'Resource facts (data): ' + JSON.stringify(capabilities.catalog.map(entry => ({ name: entry.name, version: entry.version, directory: capabilities.packagePath(entry) }))) }));
}
