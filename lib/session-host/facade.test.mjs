import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const facade = await jiti.import("./facade.ts");
const registry = await jiti.import("./registry.ts");

function makeWrapper(id, overrides = {}) {
  const inner = {
    sessionId: id, sessionFile: `/tmp/${id}.jsonl`, isBashRunning: false,
    isStreaming: false, isCompacting: false, extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp/ws" },
    agent: { state: {} }, getContextUsage: () => null,
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
    subscribe: () => () => {}, dispose() {},
    ...overrides.inner,
  };
  return new registry.AgentSessionWrapper(inner);
}

test("createSession rejects missing cwd with 400", async () => {
  await assert.rejects(() => facade.createSession({ cwd: "" }), (e) =>
    e instanceof facade.SessionHostError && e.status === 400);
});

test("sendCommand hits live wrapper first, never touches disk", async () => {
  // 不拦截 send（wrapper.send 是类方法分发到 inner 各字段）——用 get_state 的
  // 返回形状证明走了 wrapper：sessionId 字段来自 wrapper.get_state 分支。
  const w = makeWrapper("live-1");
  globalThis.__piSessions = new Map([["live-1", w]]);
  const data = await facade.sendCommand("live-1", { type: "get_state" });
  assert.equal(data.sessionId, "live-1");
  assert.equal(data.isStreaming, false);
  // send() armed the wrapper's 10-min idle timer — destroy clears it so the
  // test process exits (registry-shutdown.test.mjs destroys every wrapper too).
  w.destroy();
  globalThis.__piSessions = undefined;
});

test("sendCommand cold path 404s for unknown session", async () => {
  globalThis.__piSessions = new Map();
  await assert.rejects(() => facade.sendCommand("nope", { type: "get_state" }), (e) =>
    e instanceof facade.SessionHostError && e.status === 404);
  globalThis.__piSessions = undefined;
});

test("probeSession returns null for absent, meta for live", async () => {
  globalThis.__piSessions = new Map();
  assert.equal(await facade.probeSession("absent"), null);
  const w = makeWrapper("p1");
  globalThis.__piSessions = new Map([["p1", w]]);
  const meta = await facade.probeSession("p1");
  assert.equal(meta.id, "p1");
  assert.equal(meta.running, false);
  assert.equal(meta.state.sessionId, "p1");
  w.destroy(); // clear the idle timer armed by the get_state probe
  globalThis.__piSessions = undefined;
});

test("busyForCwd / reloadCwdSessions / runningStatus delegate to registry", () => {
  globalThis.__piSessions = new Map();
  assert.equal(facade.busyForCwd("/tmp/ws"), false);
  assert.deepEqual(facade.runningStatus().ids, []);
  globalThis.__piSessions = undefined;
});
