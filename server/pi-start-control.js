const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { privateDir, atomicJson, readSafe } = require('./pi-maintenance-files');

const recordPath = root => path.join(fs.realpathSync.native(root), '.pivane-runtime', 'start-control.json');
const failed = message => new Error(message);

// This is separate from the installation lock. Only foreground managed starts
// publish it; desktop/service/offline lock owners never accept replacement.
async function openStartControl(root, restart, onStopped = () => {}) {
    root = fs.realpathSync.native(root);
    privateDir(path.join(root, '.pivane-runtime'));
    const file = recordPath(root), token = randomUUID(), sockets = new Set();
    let pending = false, retired = false, retiredClosing;
    const retire = () => {
        if (retired) return;
        retired = true;
        retiredClosing = new Promise(resolve => server.close(resolve));
        fs.unlinkSync(file); // Still under the installation lock; no new owner yet.
        for (const socket of sockets) if (!socket.accepted) socket.destroy();
    };
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.setTimeout(5000, () => socket.destroy());
        let buffer = '';
        socket.on('data', chunk => {
            if (socket.accepted) return;
            buffer += chunk.toString('utf8');
            if (buffer.length > 1024) { socket.destroy(); return; }
            if (!buffer.includes('\n')) return;
            let request;
            try { request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); } catch { socket.destroy(); return; }
            if (!request || typeof request !== 'object' || request.token !== token || request.root !== root || request.action !== 'replace') { socket.destroy(); return; }
            socket.accepted = true;
            if (pending || retired) { socket.end(JSON.stringify({ error: '旧实例正在重启，请等待本次操作完成。' }) + '\n'); return; }
            pending = true; // Reserve before the first await, even across connections.
            socket.setTimeout(0);
            void Promise.resolve().then(() => restart(retire)).then(async () => {
                socket.end(JSON.stringify({ stopped: true, token }) + '\n');
                if (retired) { await retiredClosing; onStopped(); }
            }, async error => {
                // An uncertain outcome is never retried by this client.
                if (!retired) pending = false;
                socket.end(JSON.stringify({ error: '旧实例仍有任务、维护操作或清理状态无法确认；请先处理后再启动。' }) + '\n');
                if (retired) { await retiredClosing; onStopped(error); }
            });
        });
    });
    server.maxConnections = 16;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    try { atomicJson(file, { version: 1, root, port: server.address().port, token }); }
    catch (error) { server.close(); throw error; }
    return { retire };
}

async function replaceManaged(root, { timeoutMs = 60000 } = {}) {
    root = fs.realpathSync.native(root);
    let record;
    try { record = JSON.parse(readSafe(recordPath(root), 4096)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (record.version !== 1 || record.root !== root || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
        || typeof record.token !== 'string' || !/^[a-f0-9-]{36}$/.test(record.token)) throw failed('旧实例的启动控制记录无效，请手动检查。');
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
        let buffer = '', settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timer); socket.destroy();
            if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => finish(failed('等待旧实例停机超时，结果待核对；未强杀进程或启动新实例。')), timeoutMs);
        socket.on('connect', () => socket.write(JSON.stringify({ root, token: record.token, action: 'replace' }) + '\n'));
        socket.on('error', error => {
            // A stale record grants no authority. The actual installation lock
            // still decides whether a fresh start is allowed.
            if (error.code === 'ECONNREFUSED') finish(null, false);
            else finish(failed('无法连接旧实例；未启动新实例。'));
        });
        socket.on('end', () => finish(failed('旧实例停机结果待核对；未启动新实例。')));
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            if (buffer.length > 4096) { finish(failed('旧实例响应无效。')); return; }
            if (!buffer.includes('\n')) return;
            try {
                const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
                if (response.stopped === true && response.token === record.token) finish(null, true);
                else finish(failed(response.error || '旧实例停机未获确认。'));
            } catch { finish(failed('旧实例响应无效。')); }
        });
    });
}

module.exports = { openStartControl, replaceManaged };
