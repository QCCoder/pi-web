import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseLoopSeed, buildSeedPrompt, evaluateSeedGuard, SEED_INACTIVITY_MS } =
  await jiti.import("./seed.ts");

// ---------------------------------------------------------------- parseLoopSeed
test("parseLoopSeed extracts the KEY from the last line", () => {
  assert.equal(parseLoopSeed("分析完成，本轮选品：\n\nLOOP_SEED: REQ-0012"), "REQ-0012");
});

test("parseLoopSeed accepts BUG keys and is case/format tolerant", () => {
  assert.equal(parseLoopSeed("loop_seed: bug-0007"), "BUG-0007");
  assert.equal(parseLoopSeed("LOOP_SEED:  REQ-0026 "), "REQ-0026");
});

test("parseLoopSeed returns undefined for idle / park-all / garbage", () => {
  assert.equal(parseLoopSeed("LOOP_VERDICT: idle\n待人工验证: REQ-0001"), undefined);
  assert.equal(parseLoopSeed("decision=park-all"), undefined);
  assert.equal(parseLoopSeed("LOOP_SEED: REQ"), undefined);
  assert.equal(parseLoopSeed(""), undefined);
});

// -------------------------------------------------------------- buildSeedPrompt
test("buildSeedPrompt renders execute and adopt modes", () => {
  assert.equal(buildSeedPrompt("dev-loop", "REQ-0012", "execute"), "/skill:dev-loop 执行 REQ-0012");
  assert.equal(buildSeedPrompt("dev-loop", "BUG-0007", "adopt"), "/skill:dev-loop 收养 BUG-0007");
});

// ----------------------------------------------------------- evaluateSeedGuard
const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const guard = (overrides = {}) =>
  evaluateSeedGuard({
    stampedSessionId: "sid-1",
    phase: "implementation",
    status: "in_progress",
    wrapperAlive: false,
    lastActivityMs: NOW - 3 * SEED_INACTIVITY_MS, // long-dead by default
    nowMs: NOW,
    ...overrides,
  });

test("no stamp -> allow", () => {
  const verdict = guard({ stampedSessionId: undefined });
  assert.equal(verdict.allowed, true);
});

test("terminal item -> allow regardless of stamp (stale stamp is harmless)", () => {
  for (const overrides of [
    { phase: "complete" },
    { status: "done" },
    { status: "cancelled" },
    { wrapperAlive: true, status: "done" },
  ]) {
    assert.equal(guard(overrides).allowed, true, JSON.stringify(overrides));
  }
});

test("live wrapper -> block", () => {
  const verdict = guard({ wrapperAlive: true });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /live/);
});

test("recently active idle session (gate-paused / human-driven) -> block", () => {
  const verdict = guard({ lastActivityMs: NOW - 30 * 60 * 1000 });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /recent/);
});

test("boundary: exactly at the inactivity window is stale only past it", () => {
  assert.equal(guard({ lastActivityMs: NOW - SEED_INACTIVITY_MS }).allowed, false);
  assert.equal(guard({ lastActivityMs: NOW - SEED_INACTIVITY_MS - 1 }).allowed, true);
});

test("dead wrapper + missing file (archived/deleted) -> allow (zombie adoption)", () => {
  const verdict = guard({ lastActivityMs: undefined });
  assert.equal(verdict.allowed, true);
  assert.match(verdict.reason, /zombie|inactive/i);
});
