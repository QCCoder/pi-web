import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function makeInner(overrides = {}) {
  return {
    sessionId: "session-1",
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    subscribe: () => () => {},
    dispose() {},
    ...overrides,
  };
}

test("destroy emits session_shutdown before dispose, exactly once, then runs onDestroy", async () => {
  const calls = [];
  const inner = makeInner({
    extensionRunner: {
      async emit(event) {
        calls.push(["emit", event]);
      },
    },
    dispose() {
      calls.push(["dispose"]);
    },
  });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["onDestroy"]));

  wrapper.destroy();
  wrapper.destroy();
  await nextTurn();

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["onDestroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});

test("destroy still disposes when session_shutdown throws synchronously", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const inner = makeInner({
    extensionRunner: {
      emit() {
        throw new Error("shutdown hook failed");
      },
    },
    dispose() {
      calls.push("dispose");
    },
  });
  const wrapper = new AgentSessionWrapper(inner);

  wrapper.destroy();
  await nextTurn();

  assert.deepEqual(calls, ["dispose"]);
  assert.equal(wrapper.isAlive(), false);
});

test("destroy disposes synchronously when the runner cannot emit", () => {
  const calls = [];
  const inner = makeInner({
    extensionRunner: {},
    dispose() {
      calls.push("dispose");
    },
  });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("onDestroy"));

  wrapper.destroy();

  assert.deepEqual(calls, ["dispose", "onDestroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("idle timeout teardown emits session_shutdown and disposes the SDK session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const inner = makeInner({
    extensionRunner: {
      async emit(event) {
        calls.push(["emit", event]);
      },
    },
    dispose() {
      calls.push(["dispose"]);
    },
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();

  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();

  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
  ]);
});
