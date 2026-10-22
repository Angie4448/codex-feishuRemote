import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopIpcConnector, desktopTurns, applyDesktopPatches } from '../src/connectors/codex-desktop/desktop-ipc-connector.js';
import { DesktopIpcClient } from '../src/connectors/codex-desktop/desktop-ipc-client.js';

const ID = 'test-thread';
const finalItem = (id, text) => ({ id, type: 'agentMessage', text, phase: 'final_answer' });
function snapshot(turns = []) { return { id: ID, title: 'Existing desktop chat', cwd: 'C:\\workspace', turns, requests: [], threadRuntimeStatus: { type: 'idle' } }; }
class FakeIpc extends EventEmitter {
  constructor(state = snapshot()) { super(); this.state = state; this.calls = []; this.revision = 1; this.clientId = 'bridge'; }
  async connect() {}
  async request(method, params, options) {
    this.calls.push({ method, params, options });
    if (method === 'thread-owner-discovery') return { handledByClientId: 'owner', result: { supportsUntrustedAppInput: true } };
    if (this.sendError) throw new Error(this.sendError);
    return { result: { result: { turn: { id: 'new-turn' } } } };
  }
  follow(id, owner, following) { if (following) queueMicrotask(() => this.pushSnapshot()); }
  pushSnapshot(state = this.state, revision = this.revision) {
    this.state = state; this.revision = revision;
    this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: { conversationId: ID, change: { type: 'snapshot', revision, conversationState: structuredClone(state) } } });
  }
  patch(patches, baseRevision = this.revision) {
    this.state = applyDesktopPatches(this.state, patches); this.revision = baseRevision + 1;
    this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: { conversationId: ID, change: { type: 'patches', baseRevision, revision: this.revision, patches } } });
  }
  close() {}
}
async function setup(t, initial) {
  const ipc = new FakeIpc(initial), connector = new DesktopIpcConnector({ threadId: ID, ipcFactory: () => ipc });
  const events = []; connector.onEvent = e => events.push(e); t.after(() => connector.close()); await connector.initialize();
  return { connector, ipc, events };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('connects existing owner and sends no app-server/model/permission override', async t => {
  const { connector, ipc } = await setup(t);
  assert.equal((await connector.readThread({ threadId: ID })).thread.cwd, 'C:\\workspace');
  await connector.startTurn({ threadId: ID, text: 'hello', cwd: 'C:\\ignored' });
  const sent = ipc.calls.find(call => call.method === 'thread-follower-start-turn');
  assert.deepEqual(Object.keys(sent.params.turnStart.request).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.deepEqual(sent.params.turnStart.context, { inheritThreadSettings: true });
  assert.equal(sent.options.targetClientId, 'owner');
  assert.equal(sent.params.turnStart.request.input[0].text, 'hello');
  assert.equal(connector.getStatus().protocol, 'desktop-ipc-experimental');
});

test('refuses other threads and new thread creation', async t => {
  const { connector, ipc } = await setup(t);
  await assert.rejects(connector.startTurn({ threadId: 'other', text: 'hello' }), /只绑定/);
  await assert.rejects(connector.startThread({ cwd: '.' }), /只同步/);
  assert.equal(ipc.calls.filter(c => c.method.includes('start')).length, 0);
});

test('queues while desktop busy then sends once when turn finishes', async t => {
  const { connector, ipc } = await setup(t, snapshot([{ turnId: 'old-turn', status: 'inProgress', items: [] }]));
  assert.equal((await connector.startTurn({ threadId: ID, text: 'next' })).queued, true);
  assert.equal(ipc.calls.some(c => c.method === 'thread-follower-start-turn'), false);
  ipc.patch([{ op: 'replace', path: ['turns', 0, 'status'], value: 'completed' }]); await tick();
  assert.equal(ipc.calls.filter(c => c.method === 'thread-follower-start-turn').length, 1);
  await connector.startTurn({ threadId: ID, text: 'after' });
  // Until the accepted turn appears in a snapshot, do not dispatch another turn.
  assert.equal(ipc.calls.filter(c => c.method === 'thread-follower-start-turn').length, 1);
});

test('does not replay historical final; future desktop final emitted once across snapshots', async t => {
  const old = { turnId: 'old', status: 'completed', items: [finalItem('a', 'past')] };
  const { ipc, events } = await setup(t, snapshot([old]));
  assert.deepEqual(events, []);
  const active = { turnId: 'new', status: 'inProgress', items: [finalItem('b', 'new answer')], completedItemIds: {} };
  ipc.pushSnapshot(snapshot([old, active]), 2);
  ipc.patch([{ op: 'add', path: ['turns', 1, 'completedItemIds', 'b'], value: true }]);
  ipc.patch([{ op: 'replace', path: ['turns', 1, 'status'], value: 'completed' }]);
  ipc.pushSnapshot(ipc.state, 5); ipc.pushSnapshot(snapshot([old]), 1);
  assert.equal(events.filter(e => e.type === 'agentMessage').length, 1);
  assert.equal(events.filter(e => e.type === 'agentMessage')[0].text, 'new answer');
  assert.equal(events.filter(e => e.type === 'turnCompleted').length, 1);
});

test('approval remains owned by desktop and receives no automatic decision', async t => {
  const { connector, ipc, events } = await setup(t);
  ipc.patch([{ op: 'add', path: ['requests', 0], value: { id: 'approval1', method: 'item/commandExecution/requestApproval', params: {} } }]);
  assert.equal(connector.listPendingApprovals().length, 1);
  assert.match(events.at(-1).message, /请回电脑处理/);
  await assert.rejects(connector.resolveApproval('approval1', 'approve'), /电脑 Codex/);
  assert.equal(ipc.calls.some(c => c.method.includes('approval')), false);
});

test('baseline pending approval is surfaced in queued phone acknowledgement', async t => {
  const initial = snapshot(); initial.requests = [{ id: 'pending', method: 'item/permissions/requestApproval', params: {} }];
  const { connector, ipc } = await setup(t, initial);
  const reply = await connector.startTurn({ threadId: ID, text: 'next' });
  assert.equal(reply.queued, true); assert.equal(reply.waitingOnApproval, true);
  assert.equal(ipc.calls.some(c => c.method === 'thread-follower-start-turn'), false);
});

test('unknown send outcome is not retried', async t => {
  const { connector, ipc, events } = await setup(t); ipc.sendError = 'timeout';
  await assert.rejects(connector.startTurn({ threadId: ID, text: 'do once' }), /未自动重发/); await connector.flush();
  assert.equal(ipc.calls.filter(c => c.method === 'thread-follower-start-turn').length, 1);
  assert.equal(events.filter(e => e.type === 'error').length, 0);
});

test('queued send failure emits exactly one error and does not reject background flush', async t => {
  const { connector, ipc, events } = await setup(t, snapshot([{ turnId: 'old', status: 'inProgress', items: [] }]));
  await connector.startTurn({ threadId: ID, text: 'next' }); ipc.sendError = 'timeout';
  ipc.patch([{ op: 'replace', path: ['turns', 0, 'status'], value: 'completed' }]); await tick(); await connector.flush();
  assert.equal(events.filter(e => e.type === 'error').length, 1);
  assert.match(events.find(e => e.type === 'error').message, /未自动重发/);
});

test('disconnect cancels unsent in-memory queue and tells user to resend', async t => {
  const { connector, events } = await setup(t, snapshot([{ turnId: 'old', status: 'inProgress', items: [] }]));
  await connector.startTurn({ threadId: ID, text: 'next' }); connector.disconnect(new Error('offline'));
  assert.equal(connector.queue.length, 0);
  assert.match(events.find(e => e.type === 'error').message, /1 条.*已取消/);
});

test('canonical paginated history follows island order and removes duplicate entries', () => {
  const a = { turnId: 'a' }, b = { turnId: 'b' };
  const state = { turnHistory: { kind: 'canonical', history: { entitiesByKey: { a, b }, islands: [{ entries: [{ key: 'b', value: 'b' }, { key: 'a', value: 'a' }, { key: 'b', value: 'b' }] }] } } };
  assert.deepEqual(desktopTurns(state), [b, a]);
});

test('patches are atomic and reject prototype paths', () => {
  const state = { list: [1, 2] };
  assert.deepEqual(applyDesktopPatches(state, [{ op: 'add', path: ['list', 1], value: 3 }]), { list: [1, 3, 2] });
  assert.deepEqual(state, { list: [1, 2] });
  assert.throws(() => applyDesktopPatches(state, [{ op: 'add', path: ['__proto__', 'bad'], value: true }]), /Unsafe/);
  assert.equal({}.bad, undefined);
});

test('IPC framing handles fragmented UTF-8 response and rejects unrestricted methods', async () => {
  const client = new DesktopIpcClient(); let sent;
  client.socket = { writable: true, write(frame) { sent = JSON.parse(frame.subarray(4).toString()); }, end() {} };
  const pending = client.request('initialize', { clientType: 'test' });
  const payload = Buffer.from(JSON.stringify({ type: 'response', requestId: sent.requestId, resultType: 'success', result: { text: '中文' } }));
  const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  client.read(frame.subarray(0, 5)); client.read(frame.subarray(5, frame.length - 2)); client.read(frame.subarray(frame.length - 2));
  assert.equal((await pending).result.text, '中文');
  assert.throws(() => client.request('turn/start', {}), /Unsupported/); client.close();
});
