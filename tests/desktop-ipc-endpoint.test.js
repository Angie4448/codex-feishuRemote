import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WINDOWS_IPC_ENDPOINT, resolveDesktopIpcEndpoint, validateDesktopIpcEndpoint } from '../src/connectors/codex-desktop/desktop-ipc-endpoint.js';
import { DesktopIpcClient } from '../src/connectors/codex-desktop/desktop-ipc-client.js';
import { DesktopIpcConnector } from '../src/connectors/codex-desktop/desktop-ipc-connector.js';

const SOCKET = '/Users/example/.codex/ipc/ipc.sock';
const UID = 501;
const stat = (kind, mode, uid = UID) => ({
  mode, uid,
  isSocket: () => kind === 'socket',
  isDirectory: () => kind === 'directory',
  isSymbolicLink: () => kind === 'symlink',
});
function metadata({ socket = stat('socket', 0o600), directory = stat('directory', 0o700) } = {}) {
  return path => path === SOCKET ? socket : directory;
}

test('Windows keeps its local named pipe and rejects remote pipes', () => {
  assert.equal(resolveDesktopIpcEndpoint({ platform: 'win32', env: {} }), WINDOWS_IPC_ENDPOINT);
  const explicit = '\\\\.\\pipe\\codex-test';
  assert.equal(resolveDesktopIpcEndpoint({ platform: 'win32', env: { COMOTE_CODEX_DESKTOP_IPC_ENDPOINT: explicit } }), explicit);
  assert.throws(() => resolveDesktopIpcEndpoint({ platform: 'win32', endpoint: '\\\\remote-host\\pipe\\codex-ipc' }), /local named pipe/);
  assert.equal(validateDesktopIpcEndpoint(WINDOWS_IPC_ENDPOINT, { platform: 'win32', lstat() { assert.fail('Windows pipes do not use Unix metadata'); } }), WINDOWS_IPC_ENDPOINT);
});

test('macOS default follows the verified Codex home rule without probing /tmp', () => {
  assert.equal(resolveDesktopIpcEndpoint({ platform: 'darwin', env: {}, home: '/Users/example' }), SOCKET);
  assert.equal(resolveDesktopIpcEndpoint({ platform: 'darwin', env: { CODEX_HOME: '/Users/example/custom' } }), '/Users/example/custom/ipc/ipc.sock');
  assert.equal(resolveDesktopIpcEndpoint({ platform: 'darwin', env: { CODEX_HOME: '/ignored', COMOTE_CODEX_DESKTOP_IPC_ENDPOINT: '/verified/custom.sock' } }), '/verified/custom.sock');
  assert.equal(resolveDesktopIpcEndpoint({ platform: 'darwin', endpoint: SOCKET, env: { COMOTE_CODEX_DESKTOP_IPC_ENDPOINT: '/ignored/socket' } }), SOCKET);
  assert.throws(() => resolveDesktopIpcEndpoint({ platform: 'darwin', env: { CODEX_HOME: 'relative' } }), /absolute local path/);
});

test('Unix endpoint validation rejects ambiguous, remote, abstract and oversized paths', () => {
  for (const endpoint of ['relative.sock', 'file:///some/socket', '//server/socket', '/one/../two.sock', '\0abstract']) {
    assert.throws(() => resolveDesktopIpcEndpoint({ platform: 'darwin', endpoint }));
  }
  assert.equal(resolveDesktopIpcEndpoint({ platform: 'darwin', endpoint: '/' + 'x'.repeat(102) }).length, 103);
  assert.throws(() => resolveDesktopIpcEndpoint({ platform: 'darwin', endpoint: '/' + 'x'.repeat(103) }), /103-byte/);
  assert.throws(() => resolveDesktopIpcEndpoint({ platform: 'darwin', endpoint: '/' + '学'.repeat(35) }), /103-byte/);
});

test('only an owned private Unix socket in an owned protected directory is accepted', () => {
  assert.equal(validateDesktopIpcEndpoint(SOCKET, { platform: 'darwin', uid: UID, lstat: metadata() }), SOCKET);
  for (const [overrides, pattern] of [
    [{ socket: stat('file', 0o600) }, /not a Unix socket/],
    [{ socket: stat('symlink', 0o600) }, /not a Unix socket/],
    [{ directory: stat('symlink', 0o700) }, /real directory/],
    [{ socket: stat('socket', 0o600, UID + 1) }, /current user/],
    [{ directory: stat('directory', 0o700, UID + 1) }, /current user/],
    [{ directory: stat('directory', 0o770) }, /writable by other/],
    [{ directory: stat('directory', 0o702) }, /writable by other/],
    [{ socket: stat('socket', 0o660) }, /private owner permissions/],
    [{ socket: stat('socket', 0o604) }, /private owner permissions/],
    [{ socket: stat('socket', 0o400) }, /private owner permissions/],
  ]) {
    assert.throws(() => validateDesktopIpcEndpoint(SOCKET, { platform: 'darwin', uid: UID, lstat: metadata(overrides) }), pattern);
  }
  assert.throws(() => validateDesktopIpcEndpoint(SOCKET, { platform: 'darwin', uid: null, lstat: metadata() }), /current user/);
});

test('missing sockets fail with explicit guidance without trying alternative endpoints', () => {
  const inspected = [];
  assert.throws(() => validateDesktopIpcEndpoint(SOCKET, {
    platform: 'darwin', uid: UID,
    lstat(path) { inspected.push(path); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), /Open Codex Desktop as the same user/);
  assert.deepEqual(inspected, [SOCKET]);
});

test('IPC client refuses insecure sockets before calling the transport', async () => {
  let connects = 0;
  const client = new DesktopIpcClient({ endpoint: SOCKET, platform: 'darwin', uid: UID,
    lstat: metadata({ socket: stat('socket', 0o666) }), connect() { connects++; } });
  await assert.rejects(client.connect(), /private owner permissions/);
  assert.equal(connects, 0);
});

test('validated macOS endpoint reaches the transport and preserves the v11 initialization framing', async () => {
  const socket = new EventEmitter();
  socket.writable = true;
  socket.end = () => {};
  const methods = [];
  socket.write = frame => {
    assert.equal(frame.readUInt32LE(), frame.length - 4);
    const message = JSON.parse(frame.subarray(4));
    methods.push(message.method);
    assert.equal(message.version, 0);
    const bytes = Buffer.from(JSON.stringify({ type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'synthetic-client' } }));
    const reply = Buffer.alloc(bytes.length + 4); reply.writeUInt32LE(bytes.length); bytes.copy(reply, 4);
    queueMicrotask(() => socket.emit('data', reply));
  };
  const endpoints = [];
  const client = new DesktopIpcClient({ endpoint: SOCKET, platform: 'darwin', uid: UID, lstat: metadata(),
    connect(endpoint) { endpoints.push(endpoint); queueMicrotask(() => socket.emit('connect')); return socket; } });
  await client.connect();
  assert.deepEqual(endpoints, [SOCKET]);
  assert.deepEqual(methods, ['initialize']);
  assert.equal(client.clientId, 'synthetic-client');
  client.close();
});

test('status reports the selected endpoint and the active transport endpoint', () => {
  const connector = new DesktopIpcConnector({ threadId: 'synthetic-thread', platform: 'darwin', env: {}, home: '/Users/example' });
  assert.equal(connector.getStatus().endpoint, SOCKET);
  connector.ipc = { endpoint: '/verified/active.sock' };
  assert.equal(connector.getStatus().endpoint, '/verified/active.sock');
});

test('expected cwd retains case on macOS but is normalized case-insensitively on Windows', t => {
  const cases = [
    { platform: 'darwin', expected: '/Users/example/Project', actual: '/Users/example/project', valid: false },
    { platform: 'darwin', expected: '/Users/example/Project', actual: '/Users/example/./Project', valid: true },
    { platform: 'win32', expected: 'C:\\Workspace\\Project', actual: 'c:/workspace/PROJECT', valid: true },
  ];
  for (const { platform, expected, actual, valid } of cases) {
    const connector = new DesktopIpcConnector({ threadId: 'synthetic-thread', expectedCwd: expected, platform, env: {}, home: '/Users/example' });
    t.after(() => connector.close());
    connector.ownerId = 'synthetic-owner';
    connector.receive({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'synthetic-owner', params: {
      conversationId: 'synthetic-thread', change: { type: 'snapshot', revision: 1,
        conversationState: { id: 'synthetic-thread', cwd: actual, turns: [], requests: [] } },
    } });
    if (valid) assert.equal(connector.lastError, null);
    else assert.match(connector.lastError, /工作目录与预期不符/);
  }
});
