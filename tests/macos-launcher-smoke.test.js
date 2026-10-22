import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { run } from '../scripts/macos-launcher.mjs';

const supported = ['darwin', 'linux'].includes(process.platform);
const fixtureId = '00000000-0000-4000-8000-000000000001';
function request(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/status', headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.setTimeout(4000, () => req.destroy());
  });
}
function frame(message) { const payload = Buffer.from(JSON.stringify(message)); const out = Buffer.alloc(payload.length + 4); out.writeUInt32LE(payload.length); payload.copy(out, 4); return out; }

test('real POSIX launcher/server uses only a private fake IPC socket, supports auth/repeat/stop', { skip: !supported, timeout: 60000 }, async t => {
  // A short /tmp path avoids macOS sun_path limits. Never use the real desktop.
  const temp = await fs.mkdtemp('/tmp/cfr-');
  await fs.chmod(temp, 0o700);
  // CI also checks out the repository under a Chinese + space path, so actual
  // ps ownership checks must preserve both Unicode argv and runtime paths.
  const socketPath = path.join(temp, 'ipc.sock'), dataDir = path.join(temp, '数据 files');
  const sockets = new Set(); let turnCalls = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const n = buffer.readUInt32LE(), message = JSON.parse(buffer.subarray(4, n + 4).toString()); buffer = buffer.subarray(n + 4);
        if (message.type === 'request') {
          if (message.method === 'initialize') socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'fake-follower' } }));
          else if (message.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'success', handledByClientId: 'fake-owner', result: {} }));
          else { turnCalls++; socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'test-does-not-allow-turns' })); }
        } else if (message.method === 'thread-stream-following-changed' && message.params.following) {
          socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'fake-owner', params: { conversationId: fixtureId, change: { type: 'snapshot', revision: 1, conversationState: { id: fixtureId, title: 'Synthetic CI conversation', cwd: temp, turns: [], requests: [], threadRuntimeStatus: { type: 'idle' } } } } }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const deps = { testOnlyAllowLinux: true };
  const args = ['--data-dir', dataDir];
  t.after(async () => {
    // Even a partially failed start may have a verified PID record. Always try
    // the guarded stop; retain evidence rather than deleting a live runtime.
    let cleaned = true;
    try { await run(['stop', ...args, '--force'], deps); } catch { cleaned = false; }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (cleaned) await fs.rm(temp, { recursive: true, force: true });
  });
  const startArgs = ['start', ...args, '--thread-id', fixtureId, '--ipc-socket', socketPath, '--port', String(port)];
  const first = await run(startArgs, deps);
  assert.equal(first.result, 'started');
  assert.equal((await request(port)).code, 401);
  const token = await fs.readFile(path.join(dataDir, 'api-token.txt'), 'utf8');
  let result;
  for (let i = 0; i < 40; i++) { result = await request(port, token); if (result.body.connectors.desktop.state === 'connected') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(result.code, 200);
  assert.equal(result.body.connectors.desktop.threadId, fixtureId);
  assert.equal(result.body.connectors.desktop.endpoint, socketPath);
  assert.equal(result.body.connectors.desktop.state, 'connected');
  assert.equal((await run(startArgs, deps)).result, 'already-running');
  assert.equal((await run(['status', ...args], deps)).pid, first.pid);
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dataDir, 'api-token.txt'))).mode & 0o777, 0o600);
  assert.equal(turnCalls, 0);
  assert.equal((await run(['stop', ...args], deps)).result, 'stopped');
  assert.equal((await run(['status', ...args], deps)).result, 'not-running');
  assert.equal(await fs.readFile(path.join(dataDir, 'api-token.txt'), 'utf8'), token);
  assert.ok((await fs.stat(path.join(dataDir, 'local-settings.json'))).isFile());
});
