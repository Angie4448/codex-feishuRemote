// Experimental desktop coordination protocol, observed in Windows app 26.1013.4894.
// This connects to the existing app only. It never launches app-server or a router.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveDesktopIpcEndpoint, validateDesktopIpcEndpoint } from './desktop-ipc-endpoint.js';

const VERSIONS = new Map([
  ['initialize', 0], ['thread-owner-discovery', 1],
  ['thread-follower-read-model-settings', 1],
  ['thread-follower-start-turn', 2], ['thread-follower-interrupt-turn', 4],
]);
const MAX_FRAME = 256 * 1024 * 1024;
export class DesktopIpcClient extends EventEmitter {
  constructor({ endpoint, platform = process.platform, env = process.env, home,
    uid = process.getuid?.(), lstat, timeoutMs = 12000, connect = net.createConnection } = {}) {
    super(); this.endpoint = resolveDesktopIpcEndpoint({ endpoint, platform, env, home });
    this.endpointValidation = { platform, uid, ...(lstat ? { lstat } : {}) };
    this.timeoutMs = timeoutMs; this.connectSocket = connect;
    this.clientId = 'initializing-client'; this.pending = new Map(); this.socket = null;
    this.buffer = Buffer.alloc(0); this.closed = false;
  }
  async connect() {
    if (this.socket) throw new Error('IPC client already connected');
    validateDesktopIpcEndpoint(this.endpoint, this.endpointValidation);
    const socket = this.socket = this.connectSocket(this.endpoint);
    socket.on('data', chunk => this.read(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('desktop IPC connection closed')));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const reply = await this.request('initialize', { clientType: 'comote-feishu-local' });
    this.clientId = reply.result.clientId;
  }
  send(message) {
    if (!this.socket?.writable) throw new Error('desktop IPC not connected');
    const bytes = Buffer.from(JSON.stringify(message));
    if (!bytes.length || bytes.length > MAX_FRAME) throw new Error('invalid IPC frame length');
    const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4);
    this.socket.write(frame);
  }
  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (!size || size > MAX_FRAME) { this.fail(new Error('invalid IPC frame length')); this.socket?.destroy(); return; }
      if (this.buffer.length < size + 4) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')); }
      catch (error) { this.fail(error); this.socket?.destroy(); return; }
      this.buffer = this.buffer.subarray(size + 4);
      if (message.type === 'response') {
        const item = this.pending.get(message.requestId); if (!item) continue;
        clearTimeout(item.timer); this.pending.delete(message.requestId);
        if (message.resultType === 'success') item.resolve(message); else item.reject(new Error(message.error || 'IPC request rejected'));
      } else if (message.type === 'client-discovery-request') {
        this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      } else if (message.type === 'request') {
        this.send({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'comote-does-not-own-threads' });
      } else if (message.type === 'broadcast') {
        if (!message.targetClientIds || message.targetClientIds.includes(this.clientId)) this.emit('broadcast', message);
      }
    }
  }
  request(method, params, { targetClientId, hostId } = {}) {
    if (!VERSIONS.has(method)) throw new Error(`Unsupported desktop IPC method: ${method}`);
    const requestId = randomUUID();
    let version = VERSIONS.get(method); if (hostId && method.startsWith('thread-follower-')) version++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`IPC ${method} timed out; delivery may be unknown`)); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, hostId, timeoutMs: this.timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  follow(conversationId, ownerClientId, following = true) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, targetClientIds: [ownerClientId], params: { conversationId, hostId: 'local', following } });
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (!this.closed) { this.closed = true; this.emit('disconnected', error); }
  }
  close() { this.closed = true; this.fail(new Error('IPC client closed')); this.socket?.end(); this.socket = null; }
}
