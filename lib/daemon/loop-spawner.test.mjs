import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// NOTE (repo pattern, cf. lib/loop/seed.test.mjs): loop-spawner statically
// imports lib/rpc-manager.ts, which uses a TypeScript parameter property —
// Node's strip-only TS mode cannot load it, so the module graph is loaded
// through jiti (a dev dependency, same as the seed tests).
const jiti = createJiti(import.meta.url);
const { buildRoundPrompt, waitForRoundSettle, runKitRound, inspectRoundImpact, settleRoundBookkeeping, LoopKitSpawner } =
  await jiti.import("./loop-spawner.ts");

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

test("prompt_error rejects the round; a failing reaper does not mask the original error", async () => {
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
  await assert.rejects(
    runKitRound(DECL, {
      starter: async () => ({ session: fake, realSessionId: "real-3" }),
      // F4: 收割器自己炸了也不得吞掉/替换原始轮错误
      reaper: async () => { throw new Error("reaper blew up"); },
    }),
    /boom/, // 原始 prompt_error，而非 reaper 的错
  );
});

// --- Task 5: settleRoundBookkeeping + inspectRoundImpact (D9) ---

/** 真实 work-item fixture（requirements/REQ-0001-test）。
 *  字段名对照 lib/work-items/service.ts 的 parseWorkItem/parseEvent：
 *  - item.yaml 必填 id/revision；related_items/designs/plans 可省略但写全保持真实
 *  - events.jsonl 磁盘格式用 conversation_id（snake_case）
 *  - readWorkItem 总是同时读 README.md + events.jsonl → 都要存在 */
function makeItemWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "kit-items-"));
  const itemDir = join(ws, "requirements", "REQ-0001-test");
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, "item.yaml"), [
    "schema_version: 1",
    "id: 01TESTITEM0000000000000000",
    "key: REQ-0001",
    "revision: 3",
    "type: requirement",
    "title: test item",
    "status: open",
    "phase: intake",
    "priority: P2",
    "repositories: []",
    "conversations: []",
    "related_items: []",
    "designs: []",
    "plans: []",
    "tags: []",
    "created_at: 2026-09-01T00:00:00.000Z",
    "updated_at: 2026-09-01T00:00:00.000Z",
  ].join("\n"));
  writeFileSync(join(itemDir, "README.md"), "# test item\n");
  writeFileSync(join(itemDir, "events.jsonl"), "");
  return { ws, itemDir };
}

test("inspectRoundImpact: links items whose events cite the round session; detects pending gate", async () => {
  const { ws, itemDir } = makeItemWorkspace();
  try {
    writeFileSync(join(itemDir, "events.jsonl"), [
      JSON.stringify({ id: "e1", at: "...", type: "loop.started", actor: "agent", conversation_id: "sess-9" }),
      JSON.stringify({ id: "e2", at: "...", type: "loop.gate", actor: "agent", conversation_id: "sess-9" }),
      JSON.stringify({ id: "e3", at: "...", type: "loop.started", actor: "agent", conversation_id: "other" }),
    ].join("\n"));
    const impact = await inspectRoundImpact(ws, "sess-9");
    assert.equal(impact.itemsToLink.length, 1);
    assert.equal(impact.itemsToLink[0].key, "REQ-0001");
    assert.equal(impact.itemsToLink[0].revision, 3);
    assert.equal(impact.hasPendingGate, true);

    writeFileSync(join(itemDir, "events.jsonl"),
      JSON.stringify({ id: "e1", at: "...", type: "loop.started", actor: "agent", conversation_id: "sess-9" }) + "\n");
    const impact2 = await inspectRoundImpact(ws, "sess-9");
    assert.equal(impact2.hasPendingGate, false);

    const impact3 = await inspectRoundImpact(ws, "unrelated");
    assert.deepEqual(impact3.itemsToLink, []);
    assert.equal(impact3.hasPendingGate, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("settleRoundBookkeeping: backfills conversations, archives only without pending gate, never throws", async () => {
  const { ws, itemDir } = makeItemWorkspace();
  try {
    writeFileSync(join(itemDir, "events.jsonl"),
      JSON.stringify({ id: "e2", at: "...", type: "loop.gate", actor: "agent", conversation_id: "sess-9" }) + "\n");
    const updates = [];
    const archives = [];
    const run = () => settleRoundBookkeeping(ws, "sess-9", {
      manifestReader: async () => ({ id: "ws-1" }),
      updater: async (workspaceId, key, input) => {
        updates.push({ workspaceId, key, input });
        return null;
      },
      archiver: async (sessionId) => { archives.push(sessionId); return { archivedPath: "/x" }; },
      // pendingGate 由事件文件决定，无需注入 — 两次场景由上方写入控制
    });
    await run(); // gate pending → 不归档
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].input.conversations, ["sess-9"]);
    assert.equal(updates[0].workspaceId, "ws-1");
    assert.equal(updates[0].key, "REQ-0001");
    assert.equal(updates[0].input.expectedRevision, 3);
    assert.equal(archives.length, 0);

    writeFileSync(join(itemDir, "events.jsonl"),
      JSON.stringify({ id: "e1", at: "...", type: "loop.started", actor: "agent", conversation_id: "sess-9" }) + "\n");
    // conversations 已含 sess-9（updater 是假的不会真写盘）→ inspect 仍报未含 → 再推一次也无害
    await settleRoundBookkeeping(ws, "sess-9", {
      manifestReader: async () => ({ id: "ws-1" }),
      updater: async () => null,
      archiver: async (sessionId) => { archives.push(sessionId); return { archivedPath: "/x" }; },
    });
    assert.equal(archives.length, 1); // 无 pending gate → 归档
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- Task 6: LoopKitSpawner tick (heartbeat job) ---

function makeSpawnerWithLoops(loopFixtures, overrides = {}) {
  const rounds = [];
  const spawner = new LoopKitSpawner({
    discover: async () => [{ id: "ws-1", name: "w1", path: "/ws/a", available: true }],
    discoverLoops: async () => loopFixtures,
    runRound: async (declaration) => { rounds.push(declaration); },
    now: () => new Date("2026-09-12T00:08:00.000Z"),
    ...overrides,
  });
  return { spawner, rounds };
}

const EVERY_MIN = { workspacePath: "/ws/a", loopName: "l1", dir: "/ws/a/loops/l1", pattern: "l1", cron: "* * * * *", timezone: "UTC", level: "L1", maxMinutes: 30, body: "" };

test("cron match fires once per minute slot (dedup; fresh slots are never wiped wholesale)", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN]);
  await spawner.tick();
  await spawner.tick(); // 同一分钟 → 去重
  assert.equal(rounds.length, 1);
  // F3: 槽位表是时间戳 Map —— 新鲜槽跨 tick 保留，不存在「超限一次 clear」的回退
  assert.equal(spawner.emittedSlots.size, 1);
  const [[slot, stamped]] = [...spawner.emittedSlots.entries()];
  assert.equal(slot, "ws-1:l1:2026-09-12T00:08");
  assert.equal(typeof stamped, "number");
});

test("stale slots are evicted by timestamp after TTL, fresh ones kept", async () => {
  mock.timers.enable({ now: Date.parse("2026-09-12T00:08:00.000Z") });
  try {
    const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN], { now: () => new Date() });
    await spawner.tick();
    assert.equal(rounds.length, 1);
    assert.equal(spawner.emittedSlots.size, 1);
    mock.timers.tick(11 * 60_000); // 超过 10 分钟 TTL → 旧槽过期；分钟也变了 → 新槽
    await spawner.tick();
    assert.equal(rounds.length, 2);
    assert.equal(spawner.emittedSlots.size, 1); // 只剩新槽，旧槽被逐条清除
    const [slot] = [...spawner.emittedSlots.keys()];
    assert.equal(slot, "ws-1:l1:2026-09-12T00:19");
  } finally {
    mock.timers.reset();
  }
});

test("invalid timezone declaration is skipped, later workspaces still fire (tick never throws)", async () => {
  const rounds = [];
  const spawner = new LoopKitSpawner({
    discover: async () => [
      { id: "ws-bad", name: "bad", path: "/ws/bad", available: true },
      { id: "ws-good", name: "good", path: "/ws/good", available: true },
    ],
    discoverLoops: async (path) => (path === "/ws/bad"
      ? [{ ...EVERY_MIN, workspacePath: "/ws/bad", loopName: "l-bad", dir: "/ws/bad/loops/l-bad", timezone: "Asia/Shanghao" }]
      : [{ ...EVERY_MIN, workspacePath: "/ws/good", loopName: "l-good", dir: "/ws/good/loops/l-good", timezone: "UTC" }]),
    runRound: async (declaration) => { rounds.push(declaration.loopName); },
    now: () => new Date("2026-09-12T00:08:00.000Z"),
  });
  await spawner.tick(); // 坏时区声明不得炸 tick
  assert.deepEqual(rounds, ["l-good"]); // 后注册的 workspace 照常起轮
});

test("busy workspace is skipped (phase 1 serial)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signalRoundStarted;
  const roundStarted = new Promise((resolve) => { signalRoundStarted = resolve; });
  let discoverCalls = 0;
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN], {
    runRound: async () => { rounds.push(1); signalRoundStarted(); await gate; },
    // 第二次 discover（tick2）先等 tick1 的 round 真正起跑（busy 集合已含 ws-1）
    // —— 通过注入依赖显式定序，不依赖微任务排空时序。now 每次跨分钟，确保
    // 拦住第二轮的是 busy 跳过而非 minute-slot 去重。
    discover: async () => {
      discoverCalls += 1;
      if (discoverCalls >= 2) await roundStarted;
      return [{ id: "ws-1", name: "w1", path: "/ws/a", available: true }];
    },
    now: (() => {
      let minute = 0;
      return () => { minute += 1; return new Date(Date.parse("2026-09-12T00:08:00.000Z") + minute * 60_000); };
    })(),
  });
  const first = spawner.tick(); // 占住 ws-1
  await spawner.tick();         // ws-1 busy → 跳过
  release();
  await first;
  assert.equal(rounds.length, 1);
});

test("halted workspace never fires", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN], {
    halted: async () => true,
  });
  await spawner.tick();
  assert.equal(rounds.length, 0);
});

test("cron mismatch does not fire", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([{ ...EVERY_MIN, cron: "0 5 * * *" }]);
  await spawner.tick(); // now = 00:08 UTC
  assert.equal(rounds.length, 0);
});

test("round error is swallowed (job keeps ticking)", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN], {
    runRound: async () => { throw new Error("boom"); },
    now: (() => {
      let minute = 0;
      return () => { minute += 1; return new Date(Date.parse("2026-09-12T00:08:00.000Z") + minute * 60_000); };
    })(),
  });
  await spawner.tick();
  await spawner.tick();
  assert.equal(rounds.length, 0); // 两次都炸但 tick 不抛
});
