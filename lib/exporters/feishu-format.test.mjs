import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldNotify, formatPhaseChangeCard, REASON_TEMPLATE } = await jiti.import("./feishu-format.ts");

function item(overrides = {}) {
  return {
    schemaVersion: 1, id: "i1", key: "BUG-0008", revision: 1, type: "bug", title: "航线部门带出",
    status: "in_progress", phase: "implementation", priority: "P2", repositories: ["r1"], tags: [],
    conversations: [], relatedItems: [], designs: [], plans: [], archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function event(type, data = {}) {
  return { id: "e1", at: "2026-01-01T00:00:00.000Z", type, actor: "agent", data };
}

test("shouldNotify: phase -> verification => review-ready", () => {
  const e = event("work_item.updated", { changes: { phase: { from: "implementation", to: "verification" } } });
  assert.equal(shouldNotify(e, item()), "review-ready");
});

test("shouldNotify: phase -> complete => complete", () => {
  const e = event("work_item.updated", { changes: { phase: { from: "verification", to: "complete" } } });
  assert.equal(shouldNotify(e, item()), "complete");
});

test("shouldNotify: status -> blocked => blocked", () => {
  const e = event("work_item.updated", { changes: { status: { from: "in_progress", to: "blocked" } } });
  assert.equal(shouldNotify(e, item()), "blocked");
});

test("shouldNotify: non-phase, non-status update => null (silent)", () => {
  const e = event("work_item.updated", { changes: { priority: { from: "P2", to: "P1" } } });
  assert.equal(shouldNotify(e, item()), null);
});

test("shouldNotify: milestone/imported event => null", () => {
  assert.equal(shouldNotify(event("work_item.created"), item()), null);
  assert.equal(shouldNotify(event("imported"), item()), null);
});

test("shouldNotify: update without changes data => null", () => {
  assert.equal(shouldNotify(event("work_item.updated"), item()), null);
});

test("REASON_TEMPLATE colors reasons distinctly", () => {
  assert.equal(REASON_TEMPLATE["review-ready"], "blue");
  assert.equal(REASON_TEMPLATE.complete, "green");
  assert.equal(REASON_TEMPLATE.blocked, "red");
});

test("formatPhaseChangeCard: review-ready includes key + branch hint", () => {
  const card = formatPhaseChangeCard(item({ external: { source: "chandao", sourceId: "123", lastSyncedAt: "x" } }), "review-ready");
  assert.match(card.title, /BUG-0008/);
  assert.match(card.markdown, /已就绪评审/);
  assert.match(card.markdown, /航线部门带出/);
  assert.match(card.markdown, /chandao#123/);
  assert.equal(card.template, "blue");
});

test("formatPhaseChangeCard: complete uses green", () => {
  const card = formatPhaseChangeCard(item(), "complete");
  assert.match(card.markdown, /已完成/);
  assert.equal(card.template, "green");
});

test("formatPhaseChangeCard: blocked uses red and mentions intervention", () => {
  const card = formatPhaseChangeCard(item(), "blocked");
  assert.match(card.markdown, /受阻/);
  assert.match(card.markdown, /人工介入/);
  assert.equal(card.template, "red");
});
