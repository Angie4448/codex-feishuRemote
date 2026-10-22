#!/usr/bin/env node
// macOS launcher. No launchd installation, sudo, inherited channel credentials,
// or guesses based only on a PID. Exports permit isolated cross-platform tests.
import { promises as fs, constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { resolveDesktopIpcEndpoint, validateDesktopIpcEndpoint } from '../src/connectors/codex-desktop/desktop-ipc-endpoint.js';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'codex-feishuRemote-macos';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const THREAD = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const HELP = `Usage: node scripts/macos-launcher.mjs <start|stop|status|doctor|open-settings> [options]
  --thread-id UUID   Explicit desktop conversation (required for first start)
  --data-dir PATH    Private directory (default: ~/Library/Application Support/codex-feishuRemote)
  --port NUMBER      Loopback HTTP port (default: 16208)
  --ipc-socket PATH  Explicit desktop Unix socket; otherwise use Codex's default
  --validate-only   Validate parameters only; no files, sockets or processes
  --force           Stop only: skip API submission check, never process checks
  --help            Show this help
Before stop, finish desktop tasks and approvals; the automatic check covers phone submissions only.`;

export function parseArguments(argv) {
  const args = [...argv], command = args[0]?.startsWith('--') ? 'start' : (args.shift() ?? 'start');
  if (!['start', 'stop', 'status', 'doctor', 'open-settings'].includes(command)) throw new Error('Unknown launcher command. Use --help.');
  const result = { command };
  const values = new Map([['--thread-id', 'threadId'], ['--data-dir', 'dataDir'], ['--port', 'port'], ['--ipc-socket', 'ipcSocket']]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--validate-only', '--help', '--force'].includes(flag)) result[flag.slice(2)] = true;
    else if (values.has(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}.`);
      result[values.get(flag)] = args[++i];
    } else throw new Error('Unknown launcher option. Use --help.');
  }
  if (result.force && command !== 'stop') throw new Error('--force is only supported for stop.');
  return result;
}

export function makePlan(options, { root = ROOT, home = homedir(), settings = {}, env = process.env, platform = process.platform } = {}) {
  const expand = value => value?.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  const dataDir = path.resolve(expand(options.dataDir) ?? path.join(home, 'Library', 'Application Support', 'codex-feishuRemote'));
  root = path.resolve(root);
  const relative = path.relative(root, dataDir);
  const ancestor = path.relative(dataDir, root);
  if (dataDir === path.parse(dataDir).root || dataDir === path.resolve(home) ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) ||
      (!ancestor.startsWith('..' + path.sep) && ancestor !== '..' && !path.isAbsolute(ancestor))) {
    throw new Error('Use a dedicated private data directory outside the checkout and its parent directories.');
  }
  const threadId = options.threadId ?? settings.threadId;
  if (options.command === 'start' && (!THREAD.test(threadId ?? '') || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(threadId))) {
    throw new Error('Supply a desktop conversation UUID with --thread-id, or configure local-settings.json.');
  }
  const portText = String(options.port ?? settings.port ?? 16208);
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  const endpoint = expand(options.ipcSocket ?? settings.ipcSocket);
  // Only the documented endpoint override is accepted, never inherited COMOTE_*.
  const socket = resolveDesktopIpcEndpoint({ endpoint, platform: platform === 'win32' ? 'darwin' : platform, env: { CODEX_HOME: env.CODEX_HOME }, home });
  for (const value of [root, dataDir, socket]) if (/[\r\n\0]/.test(value)) throw new Error('Paths cannot contain control characters.');
  return { root, dataDir, threadId, port: Number(portText), ipcSocket: socket,
    serverScript: path.join(root, 'scripts', 'macos-daemon.mjs'), nodePath: process.execPath,
    settingsPath: path.join(dataDir, 'local-settings.json'), recordPath: path.join(dataDir, 'instance.json'),
    tokenPath: path.join(dataDir, 'api-token.txt'), statePath: path.join(dataDir, 'state.json') };
}

export function childEnvironment(plan, token, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^COMOTE_/i.test(key) && !['HOST', 'PORT', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  return { ...env, HOST: '127.0.0.1', PORT: String(plan.port), COMOTE_CODEX_DESKTOP_IPC: '1',
    COMOTE_CODEX_DESKTOP_IPC_THREAD_ID: plan.threadId, COMOTE_CODEX_DESKTOP_IPC_ENDPOINT: plan.ipcSocket,
    COMOTE_STATE_PATH: plan.statePath, COMOTE_LOCAL_API_TOKEN: token };
}

async function readPrivate(file, json = true) {
  let handle;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('A runtime file is not a private regular file owned by this user.');
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const text = await handle.readFile('utf8');
    if (!json) return text.trim();
    try { return JSON.parse(text); } catch { throw new Error('Invalid local runtime JSON; its contents were not logged.'); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

async function savePrivate(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

async function prepareData(plan) {
  await fs.mkdir(plan.dataDir, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(plan.dataDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('Data directory must be a real directory owned by this user.');
  const marker = path.join(plan.dataDir, 'launcher-marker.json');
  const entries = await fs.readdir(plan.dataDir);
  if (entries.length && !entries.includes('launcher-marker.json')) throw new Error('Refusing to adopt a nonempty unmarked data directory. Choose a new dedicated directory.');
  if (entries.includes('launcher-marker.json') && (await readPrivate(marker))?.app !== APP) throw new Error('This data directory belongs to a different application.');
  await fs.chmod(plan.dataDir, 0o700);
  if (!entries.includes('launcher-marker.json')) await savePrivate(marker, { app: APP });
}

async function withLock(plan, callback) {
  const lockPath = path.join(plan.dataDir, 'launcher.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch { throw new Error('Launcher lock exists. Wait for the other command; after a crash, inspect this data directory before removing its stale launcher.lock.'); }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await callback(); }
  finally { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
}

export function parseProcessIdentity(stdout) {
  const match = stdout.trim().match(/^(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) throw new Error('Could not parse process identity; refusing to guess.');
  return { uid: Number(match[1]), started: match[2].replace(/\s+/g, ' '), command: match[3] };
}

export function processIdentityEnvironment(inherited = process.env, platform = process.platform) {
  const env = { ...inherited };
  // LC_ALL=C makes macOS ps escape non-ASCII argv. Keep dates predictable
  // without losing Chinese/Unicode checkout paths in the command column.
  delete env.LC_ALL;
  const utf8 = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return { ...env, LANG: utf8, LC_CTYPE: utf8, LC_TIME: 'C' };
}

async function processIdentity(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; throw new Error('Cannot inspect the recorded process.'); }
  try {
    const { stdout } = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], { env: processIdentityEnvironment(), timeout: 3000, maxBuffer: 64 * 1024 });
    return parseProcessIdentity(stdout);
  } catch (error) {
    try { process.kill(pid, 0); } catch (gone) { if (gone.code === 'ESRCH') return null; }
    throw new Error('Cannot verify process identity with ps; no process was changed.');
  }
}

export function verifyRecord(record, identity, plan, uid = process.getuid?.()) {
  if (record?.app !== APP || record.root !== plan.root || record.serverScript !== plan.serverScript ||
      !Number.isSafeInteger(record.pid) || record.pid < 1 || !/^[0-9a-f-]{36}$/.test(record.instanceId ?? '')) throw new Error('The instance record does not belong to this checkout.');
  if (!identity) return false;
  const expected = [record.nodePath, record.serverScript, `--launcher-instance=${record.instanceId}`].join(' ');
  if (identity.uid !== uid || identity.started !== record.started || identity.command !== expected) throw new Error('PID ownership/start time/command/cookie mismatch; no process was changed.');
  return true;
}

async function ownedProcess(record, plan) {
  verifyRecord(record, null, plan);
  const identity = await processIdentity(record.pid);
  return verifyRecord(record, identity, plan) ? identity : null;
}

async function disposeSpawnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.ref();
  try { await new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer); child.removeListener('exit', exited);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    child.once('exit', exited);
    timer = setTimeout(() => finish(new Error('Startup failed and its newly spawned child has not exited. Inspect the private logs before retrying.')), 5000);
    try {
      // This is the ChildProcess handle returned by this invocation, never a
      // recorded/reused PID. Node closes the handle when that child exits.
      if (!child.kill('SIGTERM')) {
        if (child.exitCode !== null || child.signalCode !== null) finish();
        else finish(new Error('Could not stop the child created by this failed start. No other process was changed.'));
      }
    } catch { finish(new Error('Could not stop the child created by this failed start. No other process was changed.')); }
  }); } finally { child.unref(); }
}

export async function recordSpawnedChild(child, plan, instanceId, { identify = processIdentity, save = savePrivate } = {}) {
  try {
    const identity = await identify(child.pid);
    if (!identity) throw new Error('Server exited immediately. Inspect the private stderr log.');
    const record = { app: APP, root: plan.root, serverScript: plan.serverScript, nodePath: plan.nodePath, pid: child.pid, instanceId, started: identity.started, port: plan.port, threadId: plan.threadId, ipcSocket: plan.ipcSocket };
    verifyRecord(record, identity, plan);
    await save(plan.recordPath, record);
    return record;
  } catch (error) {
    // No durable ownership record exists yet. Clean up exactly the child we
    // just spawned, even if ps or writing the record failed.
    await disposeSpawnedChild(child);
    throw error;
  }
}

async function apiStatus(record, token) {
  if (!/^[0-9a-f]{64}$/.test(token ?? '')) throw new Error('Local API token is missing or invalid.');
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Authenticated loopback API check failed; no response body or token was logged.'));
    const request = http.get({ hostname: '127.0.0.1', port: record.port, path: '/api/status', headers: { Authorization: `Bearer ${token}` } }, response => {
      if (response.statusCode !== 200) { response.resume(); fail(); return; }
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
      response.on('end', () => {
        try {
          const status = JSON.parse(body);
          if (status.bridge !== 'running' || status.connectors?.desktop?.threadId !== record.threadId) return fail();
          resolve(status);
        } catch { fail(); }
      });
      response.on('error', fail);
    });
    request.setTimeout(3000, () => request.destroy()); request.on('error', fail);
  });
}

async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Loopback port is occupied/unavailable. Nothing was stopped; choose another --port.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}

const safeStatus = (record, status, result) => ({ result, pid: record.pid, port: record.port, desktopState: status.connectors.desktop.state, queuedMessages: status.connectors.desktop.queuedMessages ?? 0 });

async function start(plan) {
  validateDesktopIpcEndpoint(plan.ipcSocket);
  await prepareData(plan);
  return withLock(plan, async () => {
    const existing = await readPrivate(plan.recordPath);
    if (existing && await ownedProcess(existing, plan)) {
      if (existing.threadId !== plan.threadId || existing.port !== plan.port || existing.ipcSocket !== plan.ipcSocket) throw new Error('A different binding is already running in this data directory. Stop it explicitly first.');
      return safeStatus(existing, await apiStatus(existing, await readPrivate(plan.tokenPath, false)), 'already-running');
    }
    await assertFreePort(plan.port);
    let token = await readPrivate(plan.tokenPath, false);
    if (token === null) { token = randomBytes(32).toString('hex'); await fs.writeFile(plan.tokenPath, token, { flag: 'wx', mode: 0o600 }); }
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Local API token format is invalid; it was not replaced.');
    await savePrivate(plan.settingsPath, { threadId: plan.threadId, port: plan.port, ipcSocket: plan.ipcSocket });
    const instanceId = randomUUID();
    const logs = [];
    try {
      for (const name of ['server.stdout.log', 'server.stderr.log']) {
        const log = await fs.open(path.join(plan.dataDir, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        await log.chmod(0o600); logs.push(log);
      }
      const child = spawn(plan.nodePath, [plan.serverScript, `--launcher-instance=${instanceId}`], { cwd: plan.root, env: childEnvironment(plan, token), detached: true, stdio: ['ignore', logs[0].fd, logs[1].fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('Failed to spawn the local Node.js server.'))); });
      child.unref();
      const record = await recordSpawnedChild(child, plan, instanceId);
      const deadline = Date.now() + 20000;
      do {
        if (!await ownedProcess(record, plan)) throw new Error('Server exited during startup. Inspect the private stderr log.');
        try { return safeStatus(record, await apiStatus(record, token), 'started'); } catch { await delay(250); }
      } while (Date.now() < deadline);
      throw new Error('Server has not passed its API check. Its ownership record was retained; no other process was stopped.');
    } finally { for (const log of logs) await log.close(); }
  });
}

async function inspect(plan) {
  const record = await readPrivate(plan.recordPath);
  if (!record || !await ownedProcess(record, plan)) return { result: 'not-running' };
  return safeStatus(record, await apiStatus(record, await readPrivate(plan.tokenPath, false)), 'running');
}

async function stop(plan, force) {
  if (!await readPrivate(plan.recordPath)) return { result: 'not-running' };
  return withLock(plan, async () => {
    const record = await readPrivate(plan.recordPath);
    if (!record || !await ownedProcess(record, plan)) return { result: 'not-running' };
    if (!force) {
      const status = await apiStatus(record, await readPrivate(plan.tokenPath, false));
      const desktop = status.connectors.desktop;
      if (desktop.queuedMessages > 0 || desktop.sending || desktop.awaitingTurnId) throw new Error('Phone messages are queued or being submitted. Wait before stopping; finish desktop tasks and approvals too.');
    }
    if (!await ownedProcess(record, plan)) return { result: 'not-running' };
    process.kill(record.pid, 'SIGTERM');
    for (let i = 0; i < 40; i++) {
      if (!await ownedProcess(record, plan)) { await fs.unlink(plan.recordPath); return { result: 'stopped', configurationRetained: true }; }
      await delay(250);
    }
    throw new Error('Verified server has not exited. Record retained; no SIGKILL or other process termination was attempted.');
  });
}

export async function run(argv, dependencies = {}) {
  const options = parseArguments(argv);
  if (options.help) return { help: HELP };
  const platform = dependencies.platform ?? process.platform;
  const base = { root: dependencies.root ?? ROOT, home: dependencies.home ?? homedir(), platform, env: dependencies.env ?? process.env };
  // Stop/status/doctor/open need no thread ID. Start validation remains pure.
  const preliminary = makePlan({ ...options, command: 'status' }, base);
  if (options['validate-only']) {
    const plan = makePlan(options, base);
    return { result: 'validation-only', command: options.command, dataDir: plan.dataDir, port: plan.port, ipcSocket: plan.ipcSocket, contextMonitoring: false };
  }
  if (platform !== 'darwin' && !(dependencies.testOnlyAllowLinux && platform === 'linux')) throw new Error('Use this launcher on macOS. On Windows use the PowerShell scripts; --validate-only is platform independent.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  process.umask(0o077);
  const settings = await readPrivate(preliminary.settingsPath);
  const plan = makePlan(options, { ...base, settings: settings ?? {} });
  if (options.command === 'start') return start(plan);
  if (options.command === 'stop') return stop(plan, options.force);
  if (options.command === 'status') return inspect(plan);
  if (options.command === 'doctor') {
    let socket = 'ready'; try { validateDesktopIpcEndpoint(plan.ipcSocket); } catch { socket = 'missing-or-unsafe'; }
    let instance; try { instance = await inspect(plan); } catch { instance = { result: 'identity-or-api-check-failed' }; }
    return { result: 'diagnostics', platform, node: process.versions.node, ipcSocket: plan.ipcSocket, socket, dataDir: plan.dataDir, instance };
  }
  const record = await readPrivate(plan.recordPath);
  if (!record || !await ownedProcess(record, plan)) throw new Error('Start this instance before opening settings.');
  const token = await readPrivate(plan.tokenPath, false);
  await apiStatus(record, token);
  try { await exec('/usr/bin/open', [`http://127.0.0.1:${record.port}/#token=${token}`], { timeout: 5000 }); }
  catch { throw new Error('Could not open the default browser. No token or launch URL was logged.'); }
  return { result: 'settings-opened' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(result => console.log(result.help ?? JSON.stringify(result, null, 2))).catch(error => { console.error(`Launcher: ${error.message}`); process.exitCode = 1; });
}
