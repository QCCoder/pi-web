import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { WeComNotifier } = await jiti.import("./wecom-notifier.ts");

function item(key = "REQ-0001", overrides = {}) {
  return {
    schemaVersion: 1, id: "i1", key, revision: 1, type: "requirement", title: "改造",
    status: "in_progress", phase: "implementation", priority: "P1", repositories: ["web"], tags: [],
    conversations: [], relatedItems: [], designs: [], plans: [], archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

function reviewReadyEvent() {
  return { id: "e1", at: "x", type: "work_item.updated", actor: "a", data: { changes: { phase: { to: "verification" } } } };
}

function nonNotifyEvent() {
  return { id: "e1", at: "x", type: "work_item.updated", actor: "a", data: { changes: { priority: { to: "P1" } } } };
}

/** A fake config reader returning a config with wecom enabled + a webhook. */
function configWith(opts = {}) {
  return async () => ({
    mode: "failover",
    channels: [
      { kind: "feishu", enabled: true, priority: 1 },
      { kind: "wecom", enabled: true, priority: 2, webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K" },
    ],
    ...opts,
  });
}

test("non-notifiable event => skipped (no send)", async () => {
  const sent = [];
  const notifier = new WeComNotifier(() => {}, (w) => ({ sendMarkdown: async (c) => { sent.push({ w, c }); return { ok: true }; } }), configWith());
  const out = await notifier.onWorkItemEvent({ workspaceId: "ws" }, nonNotifyEvent(), item());
  assert.equal(out.delivered, false);
  assert.equal(out.skipped, true);
  assert.equal(sent.length, 0);
});

test("wecom disabled => skipped, no send", async () => {
  const sent = [];
  const notifier = new WeComNotifier(() => {}, (w) => ({ sendMarkdown: async (c) => { sent.push({ w, c }); return { ok: true }; } }), async () => ({ mode: "failover", channels: [{ kind: "wecom", enabled: false, priority: 2 }] }));
  const out = await notifier.onWorkItemEvent({ workspaceId: "ws" }, reviewReadyEvent(), item());
  assert.equal(out.skipped, true);
  assert.equal(sent.length, 0);
});

test("no webhook configured => skipped", async () => {
  const sent = [];
  const notifier = new WeComNotifier(() => {}, () => ({ sendMarkdown: async () => { sent.push(1); return { ok: true }; } }), async () => ({ mode: "failover", channels: [{ kind: "wecom", enabled: true, priority: 2 }] }));
  const out = await notifier.onWorkItemEvent({ workspaceId: "ws" }, reviewReadyEvent(), item());
  assert.equal(out.skipped, true);
  assert.equal(sent.length, 0);
});

test("configured + send ok => delivered, markdown body sent", async () => {
  let body;
  const notifier = new WeComNotifier(() => {}, () => ({ sendMarkdown: async (c) => { body = c; return { ok: true }; } }), configWith());
  const out = await notifier.onWorkItemEvent({ workspaceId: "ws" }, reviewReadyEvent(), item());
  assert.equal(out.delivered, true);
  assert.match(body, /REQ-0001 已就绪评审/);
});

test("configured + send fails => not delivered, error surfaced", async () => {
  const notifier = new WeComNotifier(() => {}, () => ({ sendMarkdown: async () => ({ ok: false, error: "errcode 93000" }) }), configWith());
  const out = await notifier.onWorkItemEvent({ workspaceId: "ws" }, reviewReadyEvent(), item());
  assert.equal(out.delivered, false);
  assert.equal(out.skipped, undefined);
  assert.match(out.error, /93000/);
});
