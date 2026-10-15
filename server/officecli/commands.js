const VERBS = new Set(['help', 'load_skill', 'create', 'view', 'get', 'query', 'set', 'add', 'remove', 'move', 'swap',
    'validate', 'batch', 'dump', 'merge', 'raw', 'raw-set', 'add-part']);
// No shell. The managed process lifetime belongs to Pi, not OfficeCLI's installers/residents/watchers.
function commandError(input) {
    const command = input?.command;
    if (!Array.isArray(command) || !command.length || command.length > 256 || command.some(arg => typeof arg !== 'string' || arg.includes('\0'))
        || Buffer.byteLength(JSON.stringify(command)) > 128 * 1024) return 'OfficeCLI 请使用 command 字符串数组，参数总量不超过 128 KiB。';
    if (!VERBS.has(command[0])) return '此 OfficeCLI 命令不属于受管文档操作；连接、安装、更新与后台进程由白泽灵台管理。';
    if (!['help', 'load_skill'].includes(command[0]) && !/\.(?:docx|xlsx|pptx)$/i.test(command[1] || '')) return '受管 OfficeCLI 仅处理 DOCX、XLSX、PPTX。';
    if (command[0] === 'view' && command[2] && !['text', 'annotated', 'outline', 'stats', 'issues', 'html', 'svg', 'screenshot'].includes(command[2])) return '此 OfficeCLI 预览模式不在受管范围内。';
    return null;
}
module.exports = { commandError };
