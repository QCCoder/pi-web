import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { computeCacheHitRatePercent } = await jiti.import("./session-stats.ts");

test("no cache traffic reports no rate", () => {
  assert.equal(computeCacheHitRatePercent({ input: 500, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(computeCacheHitRatePercent({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test("rate covers all input-class tokens in the denominator", () => {
  // reads / (input + writes + reads) = 700 / (100 + 200 + 700) = 70%
  assert.equal(
    computeCacheHitRatePercent({ input: 100, cacheRead: 700, cacheWrite: 200 }),
    70,
  );
});

test("all-cached input yields 100%", () => {
  assert.equal(
    computeCacheHitRatePercent({ input: 0, cacheRead: 900, cacheWrite: 0 }),
    100,
  );
});

test("fractional rates keep one-decimal precision upstream of the UI", () => {
  // 1 / 3 ≈ 33.333…% — the component rounds to one decimal for display.
  const rate = computeCacheHitRatePercent({ input: 1, cacheRead: 1, cacheWrite: 1 });
  assert.ok(Math.abs(rate - 33.33333333333333) < 1e-9);
});

// ---------------------------------------------------------------------------
// Cumulative file stats across compaction (upstream 93633c8)
// ---------------------------------------------------------------------------

const { computeSessionFileStats, mergeSessionStats } = await jiti.import("./session-stats.ts");

function usage(over = {}) {
  return {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    cost: { input: 0.1, output: 0.05, cacheRead: 0.01, cacheWrite: 0.02, total: 0.18 },
    ...over,
  };
}

function userEntry(id, parentId, content = "hi") {
  return { type: "message", id, parentId, message: { role: "user", content } };
}

function assistantEntry(id, parentId, text = "ok", u = usage()) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text }], usage: u },
  };
}

function toolResultEntry(id, parentId, u) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "result" }], ...(u ? { usage: u } : {}) },
  };
}

test("file stats sum usage across ALL entries, including history compacted away", () => {
  const entries = [
    userEntry("u1", null),
    assistantEntry("a1", "u1", "old"),
    {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      summary: "summary of old history",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
      usage: usage({ input: 1, output: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 } }),
    },
    userEntry("u2", "c1"),
    assistantEntry("a2", "u2", "new", usage({ input: 20, cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 } })),
    toolResultEntry("t1", "a2", usage({ input: 3, output: 0, cost: { input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 } })),
  ];

  const stats = computeSessionFileStats(entries);
  assert.equal(stats.tokens.input, 10 + 1 + 20 + 3);
  assert.equal(stats.tokens.output, 5 + 1 + 5 + 0);
  assert.equal(stats.tokens.cacheRead, 2 + 2 + 2 + 2);
  assert.equal(stats.tokens.cacheWrite, 1 + 1 + 1 + 1);
  assert.equal(stats.tokens.total, stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite);
  assert.ok(Math.abs(stats.cost - (0.18 + 0.05 + 0.3 + 0.03)) < 1e-9);
  assert.equal(stats.userMessages, 2);
  assert.equal(stats.assistantMessages, 2);
  assert.equal(stats.toolResults, 1);
  assert.equal(stats.totalMessages, 5); // message entries only — the compaction entry is not one
});

test("branch-summary usage is counted and usage-less entries are tolerated", () => {
  const entries = [
    userEntry("u1", null),
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", provider: "test", model: "m", content: [{ type: "text", text: "old" }] } },
    { type: "branch_summary", id: "b1", parentId: "a1", summary: "branch", usage: usage({ input: 7 }) },
  ];
  const stats = computeSessionFileStats(entries);
  assert.equal(stats.tokens.input, 7);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(stats.toolCalls, 0);
});

test("merge keeps counters monotonic when compaction shrinks the visible context", () => {
  // Cumulative file stats (post-compaction reload) exceed the shrunken
  // visible-message sum: the file side must win — no visible reset.
  const fileStats = computeSessionFileStats([
    userEntry("u1", null),
    assistantEntry("a1", "u1", "old"),
    { type: "compaction", id: "c1", parentId: "a1", summary: "s", usage: usage() },
    userEntry("u2", "c1"),
    assistantEntry("a2", "u2", "new"),
  ]);
  assert.equal(fileStats.assistantMessages, 2);
  const shrunkenLive = {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
    cost: 0.18,
  };
  const merged = mergeSessionStats(fileStats, shrunkenLive);
  assert.equal(merged.tokens.input, fileStats.tokens.input);
  assert.equal(merged.assistantMessages, 2);
  assert.ok(merged.cost >= fileStats.cost);
  assert.ok(merged.tokens.total >= shrunkenLive.tokens.total);
});

test("merge lets live streaming usage win while it runs past the persisted totals", () => {
  const fileStats = computeSessionFileStats([userEntry("u1", null), assistantEntry("a1", "u1")]);
  const live = {
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 4,
    tokens: { input: 500, output: 50, cacheRead: 20, cacheWrite: 10, total: 580 },
    cost: 1.5,
  };
  const merged = mergeSessionStats(fileStats, live);
  assert.equal(merged.tokens.input, 500);
  assert.equal(merged.tokens.output, 50);
  assert.equal(merged.cost, 1.5);
  assert.equal(merged.assistantMessages, 2);
});

test("merge falls back to the live sum before any file stats exist", () => {
  const live = {
    userMessages: 1,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  assert.equal(mergeSessionStats(undefined, live), live);
});
