import { randomUUID } from 'node:crypto';
import { basename, posix, win32 } from 'node:path';
import { EventEmitter } from 'node:events';
import { DesktopIpcClient } from './desktop-ipc-client.js';
import { resolveDesktopIpcEndpoint } from './desktop-ipc-endpoint.js';

const ACTIVE = new Set(['inProgress', 'running', 'active']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function desktopTurns(state) {
  if (state?.turnHistory?.kind === 'canonical') {
    const history = state.turnHistory.history;
    const seen = new Set(); const turns = [];
    for (const island of history?.islands ?? []) for (const entry of island.entries ?? []) {
      const key = typeof entry.value === 'string' ? entry.value : entry.key;
      if (!seen.has(key) && history.entitiesByKey?.[key]) { seen.add(key); turns.push(history.entitiesByKey[key]); }
    }
    return turns;
  }
  if (Array.isArray(state?.turns)) return state.turns;
  throw new Error('Unsupported desktop conversation history format');
}

export function applyDesktopPatches(state, patches) {
  let next = structuredClone(state);
  for (const patch of patches ?? []) {
    if (!['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path)) throw new Error('Unsupported desktop patch');
    if (patch.path.some(key => UNSAFE_KEYS.has(String(key)))) throw new Error('Unsafe desktop patch path');
    if (!patch.path.length) { if (patch.op === 'remove') throw new Error('Cannot remove snapshot root'); next = structuredClone(patch.value); continue; }
    let object = next;
    for (const key of patch.path.slice(0, -1)) {
      if (!object || typeof object !== 'object' || !Object.hasOwn(object, key)) throw new Error('Desktop patch path missing');
      object = object[key];
    }
    const key = patch.path.at(-1);
    if (!object || typeof object !== 'object') throw new Error('Desktop patch target missing');
    if (Array.isArray(object) && key !== 'length') {
      if (!Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) > object.length) throw new Error('Invalid array patch index');
      if (patch.op === 'remove') object.splice(Number(key), 1);
      else if (patch.op === 'add') object.splice(Number(key), 0, structuredClone(patch.value));
      else object[key] = structuredClone(patch.value);
    } else if (patch.op === 'remove') delete object[key];
    else object[key] = structuredClone(patch.value);
  }
  return next;
}

function textContent(item) {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  return (item.content ?? []).map(part => typeof part === 'string' ? part : part.text ?? '').filter(Boolean).join('\n');
}

// Local experimental adapter for one explicitly bound desktop thread.
// All execution and approvals remain in the desktop owner process.
export class DesktopIpcConnector {
  constructor({ threadId = process.env.COMOTE_CODEX_DESKTOP_IPC_THREAD_ID, expectedCwd = null,
    endpoint, platform = process.platform, env = process.env, home,
    ipcFactory = null, snapshotTimeoutMs = 15000, reconnectMs = 5000 } = {}) {
    this.threadId = threadId; this.expectedCwd = expectedCwd; this.platform = platform;
    this.endpoint = resolveDesktopIpcEndpoint({ endpoint, platform, env, home });
    this.ipcFactory = ipcFactory ?? (() => new DesktopIpcClient({ endpoint: this.endpoint, platform }));
    this.snapshotTimeoutMs = snapshotTimeoutMs; this.reconnectMs = reconnectMs;
    this.state = 'not_connected'; this.lastError = null; this.onEvent = null;
    this.ipc = null; this.ownerId = null; this.snapshot = null; this.revision = null;
    this.signals = new EventEmitter(); this.turnSeen = new Map(); this.itemSeen = new Map(); this.requestSeen = new Set();
    this.pendingApprovals = new Map(); this.baselined = false; this.baselineStartedAt = 0; this.queue = []; this.sending = false;
    this.connecting = null; this.reconnecting = null; this.heartbeat = null; this.disposed = false; this.awaitingTurnId = null;
    this.handoffPaused = false;
  }
  emit(event) { try { this.onEvent?.(event); } catch {} }
  assertThread(id) { if (!this.threadId || id !== this.threadId) throw new Error('此本地同步连接只绑定当前电脑会话，请在电脑上切换绑定。'); }
  getStatus() { return { name: 'Codex Desktop IPC (experimental)', role: 'primary', state: this.state,
    protocol: 'desktop-ipc-experimental', endpoint: this.ipc?.endpoint ?? this.endpoint, threadId: this.threadId,
    lastError: this.lastError, command: null, queuedMessages: this.queue.length,
    sending: this.sending, awaitingTurnId: this.awaitingTurnId, handoffPaused: this.handoffPaused }; }
  setHandoffPaused({ threadId, paused }) {
    this.assertThread(threadId);
    if (typeof paused !== 'boolean') throw new Error('paused must be boolean');
    if (paused && (this.sending || this.awaitingTurnId || this.queue.length || this.pendingApprovals.size))
      throw new Error('仍有手机消息正在提交、排队或等待审批，暂不能切换会话。');
    this.handoffPaused = paused;
    if (!paused) this.flush();
    return { threadId: this.threadId, handoffPaused: this.handoffPaused };
  }
  getUsage() { return { tokenUsage: this.snapshot?.latestTokenUsageInfo ?? null, rateLimits: null }; }
  async initialize() {
    if (this.state === 'connected') return this.getStatus();
    if (this.connecting) return this.connecting;
    this.connecting = this.connectNow().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async connectNow() {
    if (!this.threadId) throw new Error('COMOTE_CODEX_DESKTOP_IPC_THREAD_ID is required');
    this.disposed = false; const ipc = this.ipc = this.ipcFactory();
    ipc.on('broadcast', event => { if (this.ipc === ipc) this.receive(event); });
    ipc.on('disconnected', error => { if (this.ipc === ipc) this.disconnect(error); });
    try {
      await ipc.connect();
      const owner = await ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: this.threadId });
      this.ownerId = owner.handledByClientId;
      await this.refresh(); this.state = 'connected'; this.lastError = null;
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.verifyOwner().then(() => this.flush()).catch(error => this.disconnect(error)), 15000); this.heartbeat.unref?.();
      this.flush(); return this.getStatus();
    } catch (error) { this.disconnect(error); throw error; }
  }
  async verifyOwner() {
    const owner = await this.ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: this.threadId });
    if (owner.handledByClientId !== this.ownerId) { this.ownerId = owner.handledByClientId; this.revision = null; await this.refresh(); }
  }
  disconnect(error) {
    if (this.disposed || this.state === 'reconnecting') return;
    this.state = 'reconnecting'; this.lastError = error.message; this.revision = null;
    clearInterval(this.heartbeat); this.heartbeat = null;
    this.ipc?.close(); this.emit({ type: 'connectionLost', threadId: this.threadId });
    if (this.queue.length) {
      const count = this.queue.length; this.queue = [];
      this.emit({ type: 'error', threadId: this.threadId,
        message: `桌面连接中断，${count} 条尚未发送的排队消息已取消。连接恢复后请重新发送；不会自动恢复或重放这些消息。` });
    }
    if (!this.reconnecting) {
      this.reconnecting = setTimeout(() => { this.reconnecting = null; this.state = 'not_connected';
        this.initialize().then(() => this.emit({ type: 'reconnected', threadId: this.threadId })).catch(() => {});
      }, this.reconnectMs); this.reconnecting.unref?.();
    }
  }
  async refresh() {
    const promise = new Promise((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve(this.snapshot); };
      const timer = setTimeout(() => { this.signals.off('snapshot', ready); reject(new Error('等待桌面会话快照超时，请保持该会话在电脑中打开。')); }, this.snapshotTimeoutMs);
      this.signals.once('snapshot', ready);
    });
    this.ipc.follow(this.threadId, this.ownerId, true);
    return promise;
  }
  receive(event) {
    if (event.method === 'client-status-changed' && event.params?.clientId === this.ownerId && event.params.status === 'disconnected') {
      this.disconnect(new Error('电脑会话窗口已关闭或重载，请重新打开该会话。')); return;
    }
    if (event.method === 'thread-stream-following-status-requested' && event.params?.conversationId === this.threadId) {
      this.ipc.follow(this.threadId, this.ownerId, true); return;
    }
    if (event.method !== 'thread-stream-state-changed' || event.params?.conversationId !== this.threadId || event.sourceClientId !== this.ownerId) return;
    try {
      if (event.version !== 11) throw new Error(`桌面同步协议版本已变化 (${event.version})，请更新连接器。`);
      const change = event.params.change;
      if (change.type === 'snapshot') {
        if (change.conversationState?.id !== this.threadId) throw new Error('会话快照标识不匹配');
        if (this.expectedCwd) {
          const normalize = this.platform === 'win32'
            ? value => win32.normalize(String(value)).toLowerCase()
            : value => posix.normalize(String(value));
          if (normalize(change.conversationState.cwd) !== normalize(this.expectedCwd)) throw new Error('电脑会话工作目录与预期不符，连接已停止。');
        }
        if (this.revision != null && change.revision < this.revision) return;
        this.snapshot = change.conversationState; this.revision = change.revision;
        this.processState(); this.signals.emit('snapshot');
      } else if (change.type === 'patches') {
        if (this.revision == null) return;
        if (change.revision <= this.revision) return;
        if (change.baseRevision !== this.revision) { this.revision = null; this.refresh().catch(error => this.disconnect(error)); return; }
        this.snapshot = applyDesktopPatches(this.snapshot, change.patches); this.revision = change.revision; this.processState();
      }
    } catch (error) { this.disconnect(error); }
  }
  processState() {
    const turns = desktopTurns(this.snapshot); const baseline = !this.baselined;
    for (const turn of turns) {
      const id = turn.turnId ?? turn.id; if (!id) continue;
      const before = this.turnSeen.get(id);
      const historical = !before && Number(turn.turnStartedAtMs ?? 0) > 0 && Number(turn.turnStartedAtMs) <= this.baselineStartedAt;
      const suppress = baseline || historical;
      if (!suppress && !before) this.emit({ type: 'turnStarted', threadId: this.threadId, turnId: id, status: turn.status });
      for (const item of turn.items ?? []) {
        if (!item.id) continue;
        const key = `${id}:${item.id}`, previous = this.itemSeen.get(key);
        // An interrupted/failed turn can contain a partial assistant draft.
        // Only an explicitly completed item or a successful turn is final.
        const complete = Boolean(turn.completedItemIds?.[item.id]) || turn.status === 'completed';
        if (item.type === 'agentMessage') {
          const text = textContent(item);
          if (!suppress && text && text !== previous?.text) this.emit({ type: 'agentMessageDelta', threadId: this.threadId, turnId: id, itemId: item.id, phase: item.phase, text });
          if (!suppress && text && complete && !previous?.complete) this.emit({ type: 'agentMessage', threadId: this.threadId, turnId: id, itemId: item.id, phase: item.phase, text, changedPaths: [] });
          this.itemSeen.set(key, { text, complete });
        } else {
          if (!suppress && !previous && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'subAgentActivity'].includes(item.type))
            this.emit({ type: 'progress', threadId: this.threadId, turnId: id, itemType: item.type });
          this.itemSeen.set(key, { complete });
        }
      }
      if (!suppress && (!before || ACTIVE.has(before)) && !ACTIVE.has(turn.status)) this.emit({ type: 'turnCompleted', threadId: this.threadId, turnId: id, status: turn.status, error: turn.error, changedPaths: [] });
      this.turnSeen.set(id, turn.status);
    }
    this.pendingApprovals.clear();
    for (const request of this.snapshot.requests ?? []) {
      const key = String(request.id); this.pendingApprovals.set(key, { ...request, threadId: this.threadId, shortCode: key, method: request.method });
      if (!baseline && !this.requestSeen.has(key)) this.emit({ type: 'error', threadId: this.threadId,
        message: `电脑上的 Codex 正在等待确认（${request.method}）。请回电脑处理；处理后飞书会继续同步。此连接不会自动批准。` });
      this.requestSeen.add(key);
    }
    if (baseline) this.baselineStartedAt = Math.max(0, ...turns.map(turn => Number(turn.turnStartedAtMs ?? 0)));
    if (this.awaitingTurnId && this.turnSeen.has(this.awaitingTurnId)) this.awaitingTurnId = null;
    this.baselined = true; this.signals.emit('state'); this.flush();
  }
  busy() { return Boolean(this.awaitingTurnId) || desktopTurns(this.snapshot).some(turn => ACTIVE.has(turn.status)) || this.snapshot?.threadRuntimeStatus?.type === 'active' || this.pendingApprovals.size > 0; }
  async listThreads({ cwd = null } = {}) {
    await this.initialize(); const s = this.snapshot;
    const data = cwd && cwd !== s.cwd ? [] : [{ id: s.id, name: s.title, title: s.title, cwd: s.cwd, source: 'vscode', threadSource: s.threadSource ?? 'user', updatedAt: s.updatedAt, createdAt: s.createdAt }];
    return { data, nextCursor: null };
  }
  async listProjects() { await this.initialize(); return [{ name: this.snapshot.title || basename(this.snapshot.cwd), path: this.snapshot.cwd, source: 'codex-desktop', status: 'available' }]; }
  async readThread({ threadId }) { this.assertThread(threadId); await this.initialize(); return { thread: { id: threadId, cwd: this.snapshot.cwd, name: this.snapshot.title, title: this.snapshot.title } }; }
  async resumeThread({ threadId }) { this.assertThread(threadId); await this.initialize(); return { thread: { id: threadId, cwd: this.snapshot.cwd, name: this.snapshot.title } }; }
  async startThread() { throw new Error('当前连接只同步已绑定的电脑会话。新建会话请在电脑完成，再切换绑定。'); }
  async listThreadTurns({ threadId }) { this.assertThread(threadId); await this.initialize(); return desktopTurns(this.snapshot).map(turn => ({ ...turn, id: turn.turnId ?? turn.id })); }
  async listRecentMessages({ threadId, limit = 5 }) {
    const turns = await this.listThreadTurns({ threadId }); const messages = [];
    for (const turn of turns) for (const item of turn.items ?? []) {
      if (['userMessage', 'agentMessage'].includes(item.type)) { const text = textContent(item); if (text) messages.push({ role: item.type === 'userMessage' ? 'user' : 'assistant', text }); }
    }
    return { messages: messages.slice(-limit), total: messages.length, _turnCount: turns.length, _rawSample: null };
  }
  async startTurn({ threadId, text, images = [] }) {
    this.assertThread(threadId); await this.initialize();
    if (this.handoffPaused) throw new Error('正在保存并切换到新的会话，请稍后重新发送这条消息；本条尚未提交。');
    if (!text?.trim() && images.length === 0) throw new Error('消息不能为空');
    if (this.queue.length >= 20) throw new Error('待处理消息已达到 20 条，请等待电脑完成当前任务。');
    const input = [{ type: 'text', text, text_elements: [] }, ...images.map(path => ({ type: 'localImage', path }))];
    const message = { id: randomUUID(), input }; this.queue.push(message);
    if (this.busy() || this.sending) return { queued: true, waitingOnApproval: this.pendingApprovals.size > 0, clientUserMessageId: message.id };
    await this.flush({ propagate: true }); return { queued: this.queue.includes(message), clientUserMessageId: message.id };
  }
  async flush({ propagate = false } = {}) {
    if (this.handoffPaused || this.sending || this.state !== 'connected' || this.revision == null || !this.queue.length || this.busy()) return;
    this.sending = true; const message = this.queue.shift();
    try {
      const response = await this.ipc.request('thread-follower-start-turn', { conversationId: this.threadId, turnStart: {
        request: { threadId: this.threadId, input: message.input, clientUserMessageId: message.id },
        context: { inheritThreadSettings: true },
      } }, { targetClientId: this.ownerId });
      // The owner's response contains the normal app-server turn result.
      if (!response.result?.result?.turn?.id) throw new Error('桌面未返回可验证的 turn ID，请到电脑确认消息状态。');
      const acceptedId = response.result.result.turn.id;
      if (!this.turnSeen.has(acceptedId)) this.awaitingTurnId = acceptedId;
    } catch (error) {
      // Never replay an uncertain send. The desktop may already have accepted it.
      this.lastError = error.message;
      const message = `消息发送状态需确认：${error.message}。为避免重复执行，未自动重发，请查看电脑会话。`;
      if (propagate) throw new Error(message, { cause: error });
      this.emit({ type: 'error', threadId: this.threadId, message });
    } finally { this.sending = false; }
  }
  listPendingApprovals() { return [...this.pendingApprovals.values()]; }
  async resolveApproval() { throw new Error('当前实验同步入口不代办审批，请在电脑 Codex 中确认；完成后飞书会继续同步。'); }
  async cancelTurn({ threadId }) {
    this.assertThread(threadId); await this.initialize();
    const turn = desktopTurns(this.snapshot).findLast(t => ACTIVE.has(t.status));
    this.queue = [];
    if (!turn) return { ok: true, queuedMessagesCleared: true };
    return this.ipc.request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', expectedTurnId: turn.turnId ?? turn.id }, { targetClientId: this.ownerId });
  }
  close() { this.disposed = true; clearInterval(this.heartbeat); clearTimeout(this.reconnecting); this.reconnecting = null;
    try { this.ipc?.follow(this.threadId, this.ownerId, false); } catch {} this.ipc?.close(); this.state = 'not_connected'; }
}
