import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { parseArguments, makePlan, childEnvironment, processIdentityEnvironment, parseProcessIdentity, verifyRecord, recordSpawnedChild, run } from '../scripts/macos-launcher.mjs';

const fixtureId = '00000000-0000-4000-8000-000000000001';
const base = { root: path.join(tmpdir(), 'sync-fixture-repo'), home: tmpdir(), env: {}, platform: 'darwin' };
function plan() { return makePlan({ command: 'start', threadId: fixtureId, dataDir: path.join(tmpdir(), 'sync-fixture-data'), ipcSocket: '/tmp/synthetic/ipc.sock' }, base); }

test('Mac argument parsing rejects unknown flags and missing/invalid values', () => {
  assert.equal(parseArguments(['status', '--data-dir', '/tmp/private']).command, 'status');
  assert.throws(() => parseArguments(['start', '--unknown']), /Unknown/);
  assert.throws(() => parseArguments(['start', '--thread-id']), /Missing/);
  assert.throws(() => makePlan({ command: 'start', ipcSocket: '/tmp/synthetic/ipc.sock' }, base), /conversation UUID/);
  assert.throws(() => makePlan({ command: 'start', threadId: fixtureId, port: '1e3', ipcSocket: '/tmp/synthetic/ipc.sock' }, base), /Port/);
});
test('private runtime cannot be inside or above the checkout', () => {
  assert.throws(() => makePlan({ command: 'status', dataDir: base.root, ipcSocket: '/tmp/synthetic/ipc.sock' }, base), /dedicated/);
  assert.throws(() => makePlan({ command: 'status', dataDir: path.join(base.root, 'data'), ipcSocket: '/tmp/synthetic/ipc.sock' }, base), /dedicated/);
});
test('Mac child environment has explicit isolated settings and no inherited channel credentials', () => {
  const p = plan(), env = childEnvironment(p, 'a'.repeat(64), { COMOTE_FEISHU_APP_SECRET: 'synthetic', COMOTE_CONTEXT_MANAGEMENT_DIR: '/irrelevant', COMOTE_UNKNOWN: 'x', NODE_OPTIONS: '--inspect', PATH: 'synthetic-path' });
  assert.equal(env.COMOTE_FEISHU_APP_SECRET, undefined);
  assert.equal(env.COMOTE_CONTEXT_MANAGEMENT_DIR, undefined);
  assert.equal(env.COMOTE_UNKNOWN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.COMOTE_CODEX_DESKTOP_IPC_ENDPOINT, p.ipcSocket);
  assert.equal(env.COMOTE_STATE_PATH, p.statePath);
});
test('PID verification requires UID, birth time, exact daemon command and cookie', () => {
  const p = plan();
  const record = { app: 'codex-feishuRemote-macos', root: p.root, serverScript: p.serverScript, nodePath: '/synthetic/node', pid: 123, instanceId: fixtureId, started: 'Thu Oct 22 09:10:11 2026' };
  const identity = { uid: 501, started: record.started, command: `${record.nodePath} ${record.serverScript} --launcher-instance=${record.instanceId}` };
  assert.equal(verifyRecord(record, identity, p, 501), true);
  assert.throws(() => verifyRecord(record, { ...identity, uid: 502 }, p, 501), /mismatch/);
  assert.throws(() => verifyRecord(record, { ...identity, started: 'different birth' }, p, 501), /mismatch/);
  assert.throws(() => verifyRecord(record, { ...identity, command: identity.command.replace(fixtureId, 'different-cookie') }, p, 501), /mismatch/);
  assert.equal(verifyRecord(record, null, p, 501), false);
});
test('ps parser preserves exact command while normalizing date spacing', () => {
  assert.deepEqual(parseProcessIdentity('  501 Thu Oct  2 09:10:11 2026 /node /中文 path with spaces/server cookie\n'), { uid: 501, started: 'Thu Oct 2 09:10:11 2026', command: '/node /中文 path with spaces/server cookie' });
  assert.throws(() => parseProcessIdentity('unrecognized'), /Could not parse/);
});
test('macOS ps uses UTF-8 characters with C dates regardless of inherited locale', () => {
  const env = processIdentityEnvironment({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8', LC_CTYPE: 'C', LC_TIME: 'zh_CN.UTF-8', PATH: '/synthetic' }, 'darwin');
  assert.equal(env.LC_ALL, undefined);
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(env.LC_TIME, 'C');
  assert.equal(env.PATH, '/synthetic');
});
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, signals: [], refs: 0, ref() { this.refs++; }, unref() { this.refs--; } });
  child.kill = signal => { child.signals.push(signal); queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return true; };
  return child;
}
function childIdentity(p) {
  return { uid: process.getuid?.(), started: 'Thu Oct 22 09:10:11 2026', command: `${p.nodePath} ${p.serverScript} --launcher-instance=${fixtureId}` };
}
test('failed initial identity or record write reaps only this invocation\'s child handle', async () => {
  const p = plan();
  for (const failure of ['ps', 'identity', 'save']) {
    const child = fakeChild(); let saved = 0;
    const identify = async () => {
      if (failure === 'ps') throw new Error('Synthetic ps failure');
      return failure === 'identity' ? { ...childIdentity(p), command: 'different command' } : childIdentity(p);
    };
    const save = async () => { saved++; throw new Error('Synthetic record failure'); };
    await assert.rejects(recordSpawnedChild(child, p, fixtureId, { identify, save }), /Synthetic|mismatch/);
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(child.refs, 0);
    assert.equal(saved, failure === 'save' ? 1 : 0);
  }
});
test('successful record and already exited child never trigger cleanup signals', async () => {
  const p = plan(), child = fakeChild(); let saved;
  const record = await recordSpawnedChild(child, p, fixtureId, { identify: async () => childIdentity(p), save: async (_file, value) => { saved = value; } });
  assert.equal(record, saved);
  assert.deepEqual(child.signals, []);
  child.exitCode = 1;
  await assert.rejects(recordSpawnedChild(child, p, fixtureId, { identify: async () => null }), /exited immediately/);
  assert.deepEqual(child.signals, []);
});
test('failed child cleanup releases its process reference before returning the error', async () => {
  const child = fakeChild();
  child.kill = () => false;
  await assert.rejects(recordSpawnedChild(child, plan(), fixtureId, { identify: async () => { throw new Error('Synthetic ps failure'); } }), /Could not stop the child/);
  assert.equal(child.refs, 0);
  assert.equal(child.listenerCount('exit'), 0);
});
test('Mac validation-only runs on Windows without probing IPC or files', async () => {
  const result = await run(['start', '--thread-id', fixtureId, '--data-dir', path.join(tmpdir(), 'sync-validation-data'), '--ipc-socket', '/tmp/synthetic/ipc.sock', '--validate-only'], { root: base.root, env: {} });
  assert.equal(result.result, 'validation-only');
  assert.equal(result.contextMonitoring, false);
});
