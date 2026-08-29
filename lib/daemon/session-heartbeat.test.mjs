import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { classifyStall, buildStalledSnapshot, stallInterruptMessage, STALL_WARN_MS, STALL_KILL_MS } =
  await jiti.import("./session-heartbeat.ts");

const MIN = 60_000;

test("classifyStall boundaries", () => {
  assert.equal(classifyStall(0), "none");
  assert.equal(classifyStall(STALL_WARN_MS - 1), "none");
  assert.equal(classifyStall(STALL_WARN_MS), "warn");
  assert.equal(classifyStall(STALL_KILL_MS - 1), "warn");
  assert.equal(classifyStall(STALL_KILL_MS), "kill");
  assert.equal(classifyStall(STALL_KILL_MS * 10), "kill");
});

test("classifyStall honors explicit thresholds", () => {
  assert.equal(classifyStall(5 * MIN, 1 * MIN, 10 * MIN), "warn");
  assert.equal(classifyStall(10 * MIN, 1 * MIN, 10 * MIN), "kill");
  assert.equal(classifyStall(30_000, 1 * MIN, 10 * MIN), "none");
});

test("buildStalledSnapshot omits healthy sessions and sorts longest-idle first", () => {
  const snapshot = buildStalledSnapshot(
    [
      { id: "healthy", idleMs: 1000 },
      { id: "warned", idleMs: 12 * MIN },
      { id: "dead", idleMs: 60 * MIN },
      { id: "warned-2", idleMs: 11 * MIN },
    ],
    10 * MIN,
    45 * MIN,
  );
  assert.deepEqual(
    snapshot.map((s) => s.id),
    ["dead", "warned", "warned-2"],
  );
  assert.deepEqual(
    snapshot.map((s) => s.level),
    ["kill", "warn", "warn"],
  );
});

test("buildStalledSnapshot empty for all-healthy input", () => {
  assert.deepEqual(buildStalledSnapshot([{ id: "a", idleMs: 500 }]), []);
});

test("stallInterruptMessage mentions the idle minutes and how to resume", () => {
  const message = stallInterruptMessage(46 * MIN);
  assert.match(message, /46 分钟/);
  assert.match(message, /自动中断/);
  assert.match(message, /重发消息/);
});
