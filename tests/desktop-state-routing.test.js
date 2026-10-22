import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createComoteState } from "../src/server/state.js";
import { createServer } from "../src/server/app.js";
import { DesktopIpcConnector } from "../src/connectors/codex-desktop/desktop-ipc-connector.js";
import { getVersionStatus } from "../src/core/version-check.js";
import { run as showUpdatePolicy } from "../src/cli/commands/update.js";
import { assertDesktopSyncEnvironment } from "../src/server/startup-config.js";

const threadId = "desktop-thread";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("custom build metadata never recommends an upstream package or download", () => {
  const status = getVersionStatus("1.0.0");
  assert.equal(status.current, "1.0.0");
  assert.equal(status.updatesDisabled, true);
  assert.equal(status.updatePolicy, "manual");
  assert.equal(status.hasUpdate, false);
  assert.equal(status.updateCommand, null);
  assert.equal(status.downloadUrl, null);
  assert.equal(status.checkedAt, null);
  assert.equal(status.repositoryUrl, "https://github.com/Angie4448/codex-feishuRemote");
});

test("daemon requires explicit IPC thread, isolated absolute state path and local API token", () => {
  const valid = {
    COMOTE_CODEX_DESKTOP_IPC: "1",
    COMOTE_CODEX_DESKTOP_IPC_THREAD_ID: "11111111-2222-4333-8444-555555555555",
    COMOTE_STATE_PATH: resolve("synthetic-test-state.json"),
    COMOTE_LOCAL_API_TOKEN: "synthetic-test-token-not-a-secret",
  };
  assert.doesNotThrow(() => assertDesktopSyncEnvironment(valid));
  for (const key of Object.keys(valid)) {
    assert.throws(() => assertDesktopSyncEnvironment({ ...valid, [key]: "" }), /Use this project's Start-Sync.ps1/);
  }
  assert.throws(() => assertDesktopSyncEnvironment({ ...valid, COMOTE_STATE_PATH: "relative/state.json" }), /absolute COMOTE_STATE_PATH/);
});

test("unconfigured daemon invocation exits before reading a profile or connecting", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("COMOTE_")) delete env[key];
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/comote.js", import.meta.url))], {
    env, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Desktop sync refusing to start/);
  assert.match(result.stderr, /Start-Sync.ps1/);
  assert.doesNotMatch(result.stdout, /settings app running|已连接/);
});

test("legacy doctor and file-log commands are rejected before loading upstream state", () => {
  const entry = fileURLToPath(new URL("../bin/comote.js", import.meta.url));
  for (const args of [["doctor"], ["logs", "--file"], ["doctor", "--state-path", "synthetic-state.json"]]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Legacy Comote CLI commands are disabled/);
    assert.match(result.stderr, /Start-Sync.ps1.*Open-Settings.ps1/);
    assert.doesNotMatch(result.stderr, /synthetic-state.json/);
  }
});

test("restricted entrypoint still supports offline help, version and update policy", () => {
  const entry = fileURLToPath(new URL("../bin/comote.js", import.meta.url));
  for (const args of [["help"], ["--version"], ["update", "--json"]]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    if (args[0] === "update") assert.equal(JSON.parse(result.stdout).updatesDisabled, true);
    else if (args[0] === "help") assert.match(result.stdout, /Open-Settings.ps1/);
    else assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  }
});

test("update CLI reports the manual policy without using fetch", async () => {
  const output = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("The update command must remain offline");
  try {
    const code = await showUpdatePolicy({ parsed: { flags: { json: true } }, env: {}, write: text => output.push(text), currentVersion: "1.0.0" });
    assert.equal(code, 0);
    const data = JSON.parse(output.join(""));
    assert.equal(data.updatesDisabled, true);
    assert.equal(data.updateCommand, null);
    assert.doesNotMatch(output.join(""), /npm install|GavinYangAI\/comote\/releases/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("version API ignores stale upstream checkers and returns only local metadata", async t => {
  const state = {
    currentVersion: "1.0.0",
    versionChecker: {
      checkNow() { assert.fail("Must not contact an upstream release service"); },
      getLastResult() { assert.fail("Must not reuse cached upstream upgrade instructions"); },
    },
  };
  // A mock-state HTTP server on an ephemeral loopback port: no connectors or
  // channel runtimes are created and no desktop or phone connection is made.
  const server = createServer(state, { apiToken: null });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [method, path] of [["GET", "/api/version"], ["POST", "/api/version/check"]]) {
    const body = await new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: server.address().port, method, path }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body.version, "1.0.0");
    assert.equal(body.updatesDisabled, true);
    assert.equal(body.updateCommand, null);
    assert.equal(body.downloadUrl, null);
  }
});

function fixture(t, desktop = { getStatus: () => ({ state: "connected" }) }) {
  const state = createComoteState({
    desktop,
    autoStartFeishuRuntime: false,
    autoStartWeChatRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
    versionChecker: { stop() {} },
    persisted: {
      router: {
        threadBindings: [[threadId, { channel: "feishu", conversationId: "owner-chat", projectPath: "C:\\workspace", ownerStableId: "owner" }]],
      },
    },
  });
  const sent = [], updated = [];
  state.runtime.feishu.__setTestDriver({
    sendCard: async payload => { sent.push(payload); return { messageId: `card-${sent.length}` }; },
    updateCard: async payload => { updated.push(payload); },
    stopEventStream() {},
  });
  t.after(() => state.shutdown());
  const emit = event => desktop.onEvent({ threadId, turnId: "turn-1", ...event });
  return { state, emit, sent, updated };
}

test("commentary keeps the live card open until a final answer completes it", async t => {
  const { state, emit, sent, updated } = fixture(t);
  emit({ type: "turnStarted" });
  await tick();
  assert.equal(sent.length, 1);

  emit({ type: "agentMessageDelta", phase: "commentary", text: "Checking the files" });
  emit({ type: "agentMessage", itemId: "progress-1", phase: "commentary", text: "Checking the files", changedPaths: ["C:\\workspace\\progress.txt"] });
  await tick();
  assert.equal(sent.length, 1, "commentary must not send a separate completion reply");
  assert.equal(updated.some(({ card }) => card.header?.template === "green"), false);
  assert.equal(state.outboundReplies.list({ pendingOnly: false }).length, 0);

  emit({ type: "agentMessageDelta", phase: "final_answer", text: "Finished" });
  emit({ type: "agentMessage", itemId: "final-1", phase: "final_answer", text: "Finished", changedPaths: [] });
  emit({ type: "turnCompleted", status: "completed" });
  await tick();
  const finalCards = updated.filter(({ card }) => card.header?.template === "green");
  assert.equal(finalCards.length, 1);
  assert.equal(finalCards[0].messageId, "card-1", "the final answer must complete the original live card");
  assert.match(JSON.stringify(finalCards[0].card), /Finished/);
  assert.equal(sent.length, 1);
  assert.equal(state.transcript.listThread(threadId).total, 2);
});

test("joining an already active desktop turn ignores commentary but still sends the final answer", async t => {
  for (const phase of ["final_answer", undefined]) {
    const { emit, sent, updated } = fixture(t);
    emit({ type: "agentMessage", itemId: "progress", phase: "commentary", text: "Still working", changedPaths: [] });
    await tick();
    assert.equal(sent.length, 0);
    assert.equal(updated.length, 0);

    emit({ type: "agentMessage", itemId: "final", phase, text: "Final desktop result", changedPaths: [] });
    emit({ type: "turnCompleted", status: "completed" });
    await tick();
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0].card), /Final desktop result/);
    assert.equal(updated.length, 0);
  }
});

test("desktop IPC forwards commentary and final as ordinary messages without live card updates", async t => {
  const { state, emit, sent, updated } = fixture(t, { getStatus: () => ({ state: "connected", protocol: "desktop-ipc-experimental" }) });
  emit({ type: "turnStarted" });
  emit({ type: "agentMessage", itemId: "comment", phase: "commentary", text: "Checking your request" });
  emit({ type: "agentMessage", itemId: "final", phase: "final_answer", text: "Here is the result" });
  emit({ type: "turnCompleted", status: "completed" });
  await tick();
  await state.runtime.feishu.deliverQueued();
  const cards = JSON.stringify(sent);
  assert.match(cards, /Checking your request/);
  assert.match(cards, /Here is the result/);
  assert.equal(sent.some(({ card }) => card.header?.template), false);
  assert.equal(updated.length, 0);
});

test("failed or interrupted IPC turns report their outcome without forwarding a partial final or green card", async t => {
  for (const status of ["failed", "interrupted"]) {
    const desktop = new DesktopIpcConnector({ threadId });
    const { state, sent, updated } = fixture(t, desktop);
    desktop.snapshot = { id: threadId, cwd: "C:\\workspace", turns: [], requests: [] };
    desktop.processState();
    desktop.snapshot.turns = [{ turnId: "turn-1", status: "inProgress", completedItemIds: {}, items: [{ id: "partial", type: "agentMessage", phase: "final_answer", text: "UNFINISHED DRAFT" }] }];
    desktop.processState();
    desktop.snapshot.turns[0].status = status;
    desktop.snapshot.turns[0].error = { message: "Test failure" };
    desktop.processState();
    await tick();
    await state.runtime.feishu.deliverQueued();
    const cards = JSON.stringify(sent);
    assert.doesNotMatch(cards, /UNFINISHED DRAFT/);
    assert.match(cards, status === "failed" ? /任务失败.*Test failure/ : /任务已取消/);
    assert.equal(sent.some(({ card }) => card.header?.template === "green"), false);
    assert.equal(updated.length, 0);
  }
});
