import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldNotify, renderNotifyBody } = await jiti.import("./notify-rules.ts");

function item(overrides = {}) {
  return {
    schemaVersion: 1, id: "i1", key: "REQ-0001", revision: 1, type: "requirement", title: "登录页改造",
    status: "in_progress", phase: "implementation", priority: "P1", repositories: ["web"], tags: [],
    conversations: [], relatedItems: [], designs: [], plans: [], archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("shouldNotify: review-ready", () => {
  const e = { id: "e1", at: "x", type: "work_item.updated", actor: "a", data: { changes: { phase: { to: "verification" } } } };
  assert.equal(shouldNotify(e, item()), "review-ready");
});

test("renderNotifyBody: review-ready includes key, title, repo", () => {
  const md = renderNotifyBody("review-ready", item());
  assert.match(md, /REQ-0001 已就绪评审/);
  assert.match(md, /登录页改造/);
  assert.match(md, /web/);
});

test("renderNotifyBody: blocked mentions intervention", () => {
  const md = renderNotifyBody("blocked", item());
  assert.match(md, /受阻/);
  assert.match(md, /人工介入/);
});

test("renderNotifyBody: external source line only when present", () => {
  const withExt = renderNotifyBody("complete", item({ external: { source: "chandao", sourceId: "9", lastSyncedAt: "x" } }));
  assert.match(withExt, /chandao#9/);
  const without = renderNotifyBody("complete", item());
  assert.doesNotMatch(without, /来源/);
});

test("renderNotifyBody: no repositories => （未声明）", () => {
  const md = renderNotifyBody("review-ready", item({ repositories: [] }));
  assert.match(md, /仓库：（未声明）/);
});
