const path = require('node:path');

// Use the OS tar rather than a different implementation earlier in Windows PATH.
function tarInvocation(args) {
    const file = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe')
        : process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
    // USTAR names are UTF-8; BSD tar otherwise uses the Windows local code page.
    const encoding = ['win32', 'darwin'].includes(process.platform) ? ['--options', 'hdrcharset=UTF-8'] : [];
    return { file, args: [...encoding, ...args] };
}

module.exports = { tarInvocation };
