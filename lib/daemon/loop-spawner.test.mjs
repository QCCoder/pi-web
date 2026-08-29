import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

// NOTE (repo pattern, cf. lib/loop/seed.test.mjs): loop-spawner statically
// imports lib/rpc-manager.ts, which uses a TypeScript parameter property —
// Node's strip-only TS mode cannot load it, so the module graph is loaded
// through jiti (a dev dependency, same as the seed tests).
const jiti = createJiti(import.meta.url);
const { buildRoundPrompt, waitForRoundSettle, runKitRound } = await jiti.import("./loop-spawner.ts");

const DECL = {
  workspacePath: "/ws", loopName: "dev-loop", dir: "/ws/loops/dev-loop",
  pattern: "dev-loop", cron: "0 8 * * 1-5", timezone: "Asia/Shanghai",
  level: "L2", maxMinutes: 45, body: "# 合同指针\n1. 读宪法文件",
};

test("buildRoundPrompt embeds skill pointer, session id, level rules, protocol files", () => {
  const prompt = buildRoundPrompt(DECL, "sess-123");
  assert.ok(prompt.includes("/skill:dev-loop"));
  assert.ok(prompt.includes("sess-123"));
  assert.ok(prompt.includes("loop-constraints.md"));
  assert.ok(prompt.includes("loop-budget.md"));
  assert.ok(prompt.includes("loop-ledger.json"));
  assert.ok(prompt.includes("STATE.md"));
  assert.ok(prompt.includes("L2"));
  assert.ok(prompt.includes("loop-pause-all"));
});

/** Minimal AgentSessionWrapper fake — the trio the spawner uses. */
function makeFakeSession({ doneDelayMs = 0 } = {}) {
  const listeners = new Set();
  const destroyListeners = new Set();
  const calls = [];
  const session = {
    sentCommands: calls,
    send: async (command) => {
      calls.push(command);
      if (command.type === "prompt") {
        // unref: the timeout test's 10s done-timer must not hold the test
        // process open after the round already rejected at 300ms.
        setTimeout(() => {
          for (const cb of listeners) cb({ type: "prompt_done" });
        }, doneDelayMs).unref?.();
      }
      return null;
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onDestroy(cb) {
      destroyListeners.add(cb);
      return () => destroyListeners.delete(cb);
    },
    destroy() {
      calls.push({ type: "__destroy__" });
      for (const cb of destroyListeners) cb();
    },
  };
  return session;
}

test("runKitRound happy path: creates one-shot session, names it, settles", async () => {
  const fake = makeFakeSession();
  const started = [];
  const sid = await runKitRound(DECL, {
    starter: async (sessionId, file, cwd) => {
      started.push({ sessionId, file, cwd });
      return { session: fake, realSessionId: "real-1" };
    },
    reaper: async () => ({ workspacePath: "/ws", killedPids: [], targetRoots: [] }),
  });
  assert.equal(sid, "real-1");
  assert.deepEqual(started, [{ sessionId: "", file: "", cwd: "/ws" }]);
  const nameCmd = fake.sentCommands.find((c) => c.type === "set_session_name");
  assert.ok(nameCmd && nameCmd.name.startsWith("dev-loop · "));
  assert.ok(fake.sentCommands.some((c) => c.type === "prompt" && c.message.includes("/skill:dev-loop")));
});

test("timeout path: destroy + reap, and the error propagates", async () => {
  const fake = makeFakeSession({ doneDelayMs: 10_000 });
  const reaped = [];
  await assert.rejects(
    runKitRound({ ...DECL, maxMinutes: 0.005 }, { // 0.005min = 300ms
      starter: async () => ({ session: fake, realSessionId: "real-2" }),
      reaper: async (ws) => { reaped.push(ws); return { workspacePath: ws, killedPids: [], targetRoots: [] }; },
    }),
    /timed out/,
  );
  assert.ok(fake.sentCommands.some((c) => c.type === "__destroy__"));
  assert.deepEqual(reaped, ["/ws"]);
});

test("prompt_error rejects the round", async () => {
  const fake = makeFakeSession();
  const listeners = [];
  fake.send = async (command) => {
    if (command.type === "prompt") {
      setTimeout(() => {
        for (const cb of listeners) cb({ type: "prompt_error", errorMessage: "boom" });
      }, 0);
    }
    return null;
  };
  fake.onEvent = (cb) => { listeners.push(cb); return () => {}; };
  const reaped = [];
  await assert.rejects(
    runKitRound(DECL, {
      starter: async () => ({ session: fake, realSessionId: "real-3" }),
      reaper: async (ws) => { reaped.push(ws); return { workspacePath: ws, killedPids: [], targetRoots: [] }; },
    }),
    /boom/,
  );
  assert.deepEqual(reaped, ["/ws"]);
});
