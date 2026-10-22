import test from "node:test";
import assert from "node:assert/strict";
import { FeishuRuntimeService } from "../src/channels/feishu/runtime.js";
import { t } from "../src/core/i18n/index.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function callback({ code = "a1", decision = "accept", openId = "owner" } = {}) {
  return {
    event: {
      operator: { open_id: openId },
      open_message_id: "card-1",
      action: { value: { kind: "approval", code, decision } },
    },
  };
}

function fixture({ resolveApproval = async () => {}, updateCard = async () => {} } = {}) {
  const calls = [];
  const updates = [];
  const errors = [];
  const router = {
    authorization: { isAuthorized: ({ stableId }) => ["owner", "other"].includes(stableId) },
    findPendingApproval: () => ({ id: "request-1", shortCode: "a1", threadId: "thread-1" }),
    getThreadBinding: () => ({ ownerStableId: "owner" }),
    resolveApproval: (...args) => {
      calls.push(args);
      return resolveApproval(...args);
    },
  };
  const runtime = new FeishuRuntimeService({
    adapter: { commandRouter: router },
    outboundQueue: {},
    driver: {
      updateCard: (...args) => {
        updates.push(args);
        return updateCard(...args);
      },
    },
    eventLog: {
      info() {},
      warn() {},
      error: (...args) => errors.push(args),
    },
  });
  return { runtime, router, calls, updates, errors };
}

test("approval callback acknowledges before the backend and card update finish", async () => {
  const backend = deferred();
  const patch = deferred();
  const { runtime, calls, updates } = fixture({
    resolveApproval: () => backend.promise,
    updateCard: () => patch.promise,
  });

  const reply = await runtime.handleCardAction(callback());
  assert.deepEqual(reply, { toast: { type: "info", content: t("feishu.toast.processing") } });
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 0);
  assert.deepEqual(calls[0], ["a1", "accept", { channel: "feishu", stableId: "owner" }]);

  const work = runtime.approvalActions.get("a1").promise;
  backend.resolve();
  await Promise.resolve();
  assert.equal(updates.length, 1);
  assert.ok(runtime.approvalActions.get("a1").promise);
  patch.resolve();
  await work;
  assert.equal(runtime.approvalActions.get("a1").cardUpdated, true);
});

test("duplicate and conflicting clicks submit exactly one backend decision", async () => {
  const backend = deferred();
  const { runtime, calls, updates, router } = fixture({ resolveApproval: () => backend.promise });
  await runtime.handleCardAction(callback());
  const work = runtime.approvalActions.get("a1").promise;
  const second = await runtime.handleCardAction(callback({ decision: "decline" }));
  assert.equal(second.toast.content, t("feishu.toast.processing"));
  assert.equal(calls.length, 1);
  backend.resolve();
  await work;

  // The connector removes a resolved approval; its callback cache must still
  // know the owner and actual decision for a delayed duplicate delivery.
  router.findPendingApproval = () => null;
  const repeated = await runtime.handleCardAction(callback({ decision: "decline" }));
  assert.equal(repeated.toast.content, t("feishu.toast.approved"));
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 1);
});

test("authorization and ownership checks run before any background work", async () => {
  const { runtime, calls, updates, router } = fixture();
  for (const openId of [null, "unknown", "other"]) {
    const reply = await runtime.handleCardAction(callback({ openId }));
    assert.equal(reply.toast.type, "error");
    assert.equal(reply.toast.content, t("feishu.toast.notAuthorized"));
  }
  router.authorization = null;
  assert.equal((await runtime.handleCardAction(callback())).toast.type, "error");
  assert.equal(calls.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(runtime.approvalActions.size, 0);
});

test("the owner check also guards pending and completed duplicate callbacks", async () => {
  const backend = deferred();
  const { runtime, router, calls } = fixture({ resolveApproval: () => backend.promise });
  await runtime.handleCardAction(callback());
  const work = runtime.approvalActions.get("a1").promise;
  assert.equal((await runtime.handleCardAction(callback({ openId: "other" }))).toast.type, "error");
  backend.resolve();
  await work;
  router.findPendingApproval = () => null;
  router.getThreadBinding = () => null;
  assert.equal((await runtime.handleCardAction(callback({ openId: "other" }))).toast.type, "error");
  assert.equal(calls.length, 1);
});

test("backend failures are logged and release the code for a deliberate retry", async () => {
  let fail = true;
  const { runtime, calls, updates, errors } = fixture({
    resolveApproval: async () => {
      if (fail) throw new Error("backend unavailable");
    },
  });
  await runtime.handleCardAction(callback());
  await runtime.approvalActions.get("a1").promise;
  assert.equal(runtime.approvalActions.has("a1"), false);
  assert.equal(runtime.lastError, "backend unavailable");
  assert.equal(errors.length, 1);
  assert.equal(updates.length, 0);

  fail = false;
  await runtime.handleCardAction(callback({ decision: "decline" }));
  await runtime.approvalActions.get("a1").promise;
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], "decline");
  assert.equal(updates.length, 1);
});

test("card update failures retry only the card, preserving the successful decision", async () => {
  let fail = true;
  const { runtime, calls, updates, errors } = fixture({
    updateCard: async () => {
      if (fail) throw new Error("card network failure");
    },
  });
  await runtime.handleCardAction(callback());
  await runtime.approvalActions.get("a1").promise;
  assert.equal(runtime.approvalActions.get("a1").resolved, true);
  assert.equal(runtime.approvalActions.get("a1").cardUpdated, undefined);
  assert.equal(errors.length, 1);

  fail = false;
  await runtime.handleCardAction(callback({ decision: "decline" }));
  await runtime.approvalActions.get("a1").promise;
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 2);
  assert.equal(updates[1][0].card.header.template, "green");
});

test("a router ownership rejection never marks the card approved", async () => {
  const { runtime, updates, errors } = fixture({
    resolveApproval: async () => {
      throw Object.assign(new Error("ownership changed"), { code: "not_owner" });
    },
  });
  await runtime.handleCardAction(callback());
  await runtime.approvalActions.get("a1").promise;
  assert.equal(runtime.approvalActions.has("a1"), false);
  assert.equal(updates.length, 0);
  assert.equal(errors.length, 1);
});

test("a new request that reuses a completed short code is handled independently", async () => {
  const { runtime, router, calls } = fixture();
  await runtime.handleCardAction(callback());
  await runtime.approvalActions.get("a1").promise;
  router.findPendingApproval = () => ({ id: "request-2", shortCode: "a1", threadId: "thread-1" });
  await runtime.handleCardAction(callback({ decision: "decline" }));
  await runtime.approvalActions.get("a1").promise;
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], "decline");
});
