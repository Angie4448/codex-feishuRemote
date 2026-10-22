import test from "node:test";
import assert from "node:assert/strict";
import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { ProjectStore, isAbsoluteProjectPath } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { t } from "../src/core/i18n/index.js";

// Synthetic UUID and workspace; these do not refer to a real conversation.
const threadId = "11111111-2222-4333-8444-555555555555";
const projectPath = "C:\\test-workspace\\desktop-sync";
const identity = { channel: "feishu", stableId: "owner" };
const conversation = { channel: "feishu", conversationId: "owner-chat", accountId: "bot" };

function fixture(overrides = {}, cwd = projectPath) {
  const calls = [];
  const thread = { id: threadId, cwd, title: "Existing desktop conversation" };
  const connector = {
    getStatus: () => ({ state: "connected" }),
    readThread: async (params) => { calls.push(["read", params]); return { thread }; },
    resumeThread: async (params) => { calls.push(["resume", params]); return { thread }; },
    listThreads: async (params) => { calls.push(["list", params]); return { data: [thread] }; },
    listRecentMessages: async () => ({ messages: [] }),
    startThread: async () => { assert.fail("Selecting a thread must not create one"); },
    startTurn: async (params) => { calls.push(["turn", params]); },
    ...overrides,
  };
  const sessions = new SessionStore();
  const router = new CommandRouter({
    authorization: new AuthorizationStore({ identities: [identity] }),
    projects: new ProjectStore(),
    sessions,
    codexDesktop: connector,
  });
  const send = (text, sender = identity) => router.handleMessageAsync({ identity: sender, conversation, text });
  return { router, sessions, connector, calls, send };
}

test("Windows drive and UNC paths can be opened without a project catalog", () => {
  const projects = new ProjectStore();
  for (const [input, expected, name] of [
    ["C:\\Work\\Lesson Plans\\", "C:\\Work\\Lesson Plans", "Lesson Plans"],
    ["C:/Work/Lesson Plans/", "C:/Work/Lesson Plans", "Lesson Plans"],
    ["C:\\", "C:\\", "C:\\"],
    ["C:/", "C:/", "C:/"],
    ["\\\\server\\share\\lessons\\", "\\\\server\\share\\lessons", "lessons"],
    ["/home/user/work/", "/home/user/work", "work"],
    ["/", "/", "/"],
  ]) {
    assert.equal(isAbsoluteProjectPath(input), true);
    const project = projects.resolveProject(input);
    assert.equal(project.path, expected);
    assert.equal(project.name, name);
  }
  assert.equal(isAbsoluteProjectPath("C:relative"), false);
  assert.equal(isAbsoluteProjectPath("relative/path"), false);
});

test("/open accepts a Windows directory containing spaces", async () => {
  const { send, router, calls } = fixture();
  const path = "C:\\Work\\Lesson Plans";
  const reply = await send(`/open ${path}`);
  assert.equal(reply.kind, "text");
  assert.equal(router.currentProjectByIdentity.get("feishu:owner"), path);
  assert.deepEqual(calls, [["list", { cwd: path }]]);
});

test("macOS paths with spaces and Unicode preserve the existing thread and working directory", async () => {
  const path = "/Users/example/My Projects/课程";
  const { send, router, calls, sessions } = fixture({}, path);
  await send(`/use ${threadId}`);
  await send("Continue from the phone");
  assert.equal(router.currentProjectByIdentity.get("feishu:owner"), path);
  assert.equal(sessions.getActiveSession(path, "feishu:owner").id, threadId);
  assert.deepEqual(calls.find(([name]) => name === "turn")[1], {
    threadId, text: "Continue from the phone", cwd: path, images: [],
  });
  assert.equal(router.getThreadBinding(threadId).projectPath, path);
});

test("an explicit thread ID selects its own cwd without requiring or listing a project", async () => {
  const { send, router, sessions, calls } = fixture();
  const reply = await send(`/use ${threadId}`);
  assert.equal(reply.kind, "text");
  assert.match(reply.text, /Existing desktop conversation/);
  assert.deepEqual(calls, [["read", { threadId }], ["resume", { threadId }]]);
  assert.equal(router.currentProjectByIdentity.get("feishu:owner"), projectPath);
  assert.equal(sessions.getActiveSession(projectPath, "feishu:owner").id, threadId);
  assert.equal(sessions.getActiveSession(projectPath, "feishu:other"), null);
  assert.deepEqual(router.getThreadBinding(threadId), {
    ...conversation,
    projectPath,
    ownerStableId: "owner",
  });
});

test("an explicit thread ID replaces a stale project pointer and later text uses that thread", async () => {
  const { send, router, calls } = fixture();
  router.currentProjectByIdentity.set("feishu:owner", "old-project-id");
  router.pendingByIdentity.set("feishu:owner", { type: "choose_session", projectPath: "old-project-id" });
  await send(`/switch ${threadId}`);
  assert.equal(router.pendingByIdentity.has("feishu:owner"), false);
  await send("Continue the same conversation");
  const turn = calls.find(([name]) => name === "turn")[1];
  assert.deepEqual(turn, { threadId, text: "Continue the same conversation", cwd: projectPath, images: [] });
});

test("unauthorized senders cannot read or bind an explicit thread ID", async () => {
  const { send, router, sessions, calls } = fixture();
  await send(`/use ${threadId}`, { channel: "feishu", stableId: "unknown" });
  assert.deepEqual(calls, []);
  assert.equal(router.threadBindings.size, 0);
  assert.deepEqual(sessions.snapshot().sessions, []);
});

test("failed reads, invalid cwd, and failed resumes leave the previous selection intact", async () => {
  const scenarios = [
    { readThread: async () => { throw new Error("thread not found"); } },
    { readThread: async () => ({ thread: { id: threadId, cwd: "project-id" } }) },
    { readThread: async () => ({ thread: { id: "different-id", cwd: projectPath } }) },
    { resumeThread: async () => { throw new Error("desktop busy"); } },
    { resumeThread: async () => ({ thread: { id: "different-id", cwd: projectPath } }) },
  ];
  for (const overrides of scenarios) {
    const { send, router, sessions } = fixture(overrides);
    router.currentProjectByIdentity.set("feishu:owner", "C:\\Previous");
    const reply = await send(`/use ${threadId}`);
    assert.equal(reply.kind, "error");
    assert.equal(router.currentProjectByIdentity.get("feishu:owner"), "C:\\Previous");
    assert.equal(router.threadBindings.size, 0);
    assert.deepEqual(sessions.snapshot().sessions, []);
  }
});

test("numeric session selection retains the existing project picker behavior", async () => {
  const { send, router, sessions, calls } = fixture();
  router.currentProjectByIdentity.set("feishu:owner", projectPath);
  await send("/use 1");
  assert.deepEqual(calls, [["list", { cwd: projectPath }], ["resume", { threadId, cwd: projectPath }]]);
  assert.equal(sessions.getActiveSession(projectPath, "feishu:owner").id, threadId);
});

test("a queued phone message explicitly says it is waiting for the desktop turn", async () => {
  const { send } = fixture({ startTurn: async () => ({ queued: true, clientUserMessageId: "queued-1" }) });
  await send(`/use ${threadId}`);
  const reply = await send("Continue after the current task");
  assert.equal(reply.text, "电脑正在处理当前任务，这条消息已排队；当前任务结束后会继续同一会话。");
  assert.equal(reply.kind, "text");
});

test("accepted turns keep the existing reply and uncertain failures are not resent", async () => {
  for (const result of [undefined, { queued: false }, { turn: { id: "started" } }]) {
    const { send } = fixture({ startTurn: async () => result });
    await send(`/use ${threadId}`);
    assert.equal((await send("Continue now")).text, t("cmd.send.processing", { id: threadId }));
  }
  let attempts = 0;
  const { send } = fixture({ startTurn: async () => { attempts += 1; throw new Error("delivery may be unknown"); } });
  await send(`/use ${threadId}`);
  const reply = await send("Execute once");
  assert.equal(reply.kind, "error");
  assert.match(reply.text, /delivery may be unknown/);
  assert.equal(attempts, 1);
});

test("queue acknowledgement tells the phone user when desktop approval is required", async () => {
  const { send } = fixture({ startTurn: async () => ({ queued: true, waitingOnApproval: true }) });
  await send(`/use ${threadId}`);
  const reply = await send("Continue after approval");
  assert.match(reply.text, /等待确认.*已排队.*电脑上处理确认/);
});
