import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { discoverKitLoops } from "../../pi-loop/protocol.ts";

// NOTE (repo pattern, cf. lib/subagent/agents.test.mjs): loop-spawner statically
// imports lib/daemon/rpc-manager.ts, which uses a TypeScript parameter property —
// Node's strip-only TS mode cannot load it, so the module graph is loaded
// through jiti (a dev dependency, same as the seed tests).
const jiti = createJiti(import.meta.url);
const { waitForRoundSettle, runKitRound, inspectRoundImpact, settleRoundBookkeeping, LoopKitSpawner } =
  await jiti.import("./loop-spawner.ts");

const DECL = {
  workspacePath: "/ws", loopName: "dev-loop", dir: "/ws/loops/dev-loop",
  pattern: "dev-loop", cron: "0 8 * * 1-5", timezone: "Asia/Shanghai",
  level: "L2", maxMinutes: 45, body: "# 合同指针\n1. 读宪法文件",
};

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
  const sessionStartEvents = [];
  const sid = await runKitRound(DECL, {
    starter: async (sessionId, file, cwd) => {
      started.push({ sessionId, file, cwd });
      return { session: fake, realSessionId: "real-1" };
    },
    reaper: async () => ({ workspacePath: "/ws", killedPids: [], targetRoots: [] }),
    onSessionStart: (sessionId) => sessionStartEvents.push({ sessionId, sentSoFar: [...fake.sentCommands] }),
  });
  assert.equal(sid, "real-1");
  assert.deepEqual(started, [{ sessionId: "", file: "", cwd: "/ws" }]);
  const nameCmd = fake.sentCommands.find((c) => c.type === "set_session_name");
  assert.ok(nameCmd && nameCmd.name.startsWith("dev-loop · "));
  assert.ok(fake.sentCommands.some((c) => c.type === "prompt" && c.message.includes("/skill:dev-loop")));
  // D13：spawner 走包内 buildRoundPrompt —— ledger 断言 per-loop 路径
  assert.ok(fake.sentCommands.some((c) => c.type === "prompt" && c.message.includes("/ws/loops/dev-loop/loop-ledger.json")));
  assert.ok(fake.sentCommands.some((c) => c.type === "prompt" && c.message.includes("real-1")));
  // onSessionStart 在 startRpcSession 解构出 realSessionId 后、命名/开场合同之前触发
  //（tick 借此把 sessionId 回填进 .round.lock，供 stop 路由用）。
  assert.deepEqual(sessionStartEvents, [{ sessionId: "real-1", sentSoFar: [] }]);
});

test("timeout path: destroy + reap, bookkeeping still runs, and the error propagates", async () => {
  const fake = makeFakeSession({ doneDelayMs: 10_000 });
  const reaped = [];
  const settled = [];
  await assert.rejects(
    runKitRound({ ...DECL, maxMinutes: 0.005 }, { // 0.005min = 300ms
      starter: async () => ({ session: fake, realSessionId: "real-2" }),
      reaper: async (ws) => { reaped.push(ws); return { workspacePath: ws, killedPids: [], targetRoots: [] }; },
      bookkeeper: async (ws, sid) => { settled.push({ ws, sid }); },
    }),
    /timed out/,
  );
  assert.ok(fake.sentCommands.some((c) => c.type === "__destroy__"));
  assert.deepEqual(reaped, ["/ws"]);
  // F2: 失败轮也要跑 D9 事后钩子（归档/回填从盘上事件取，对超时轮正确）
  assert.deepEqual(settled, [{ ws: "/ws", sid: "real-2" }]);
});

test("prompt_error rejects the round (bookkeeping runs, reaper failure does not mask it)", async () => {
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
  const settled = [];
  await assert.rejects(
    runKitRound(DECL, {
      starter: async () => ({ session: fake, realSessionId: "real-3" }),
      // F4: 收割器自己炸了也不得吞掉/替换原始轮错误
      reaper: async () => { throw new Error("reaper blew up"); },
      bookkeeper: async (ws, sid) => { settled.push({ ws, sid }); },
    }),
    /boom/, // 原始 prompt_error，而非 reaper 的错
  );
  assert.deepEqual(settled, [{ ws: "/ws", sid: "real-3" }]); // F2 同覆盖 prompt_error 路径
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

// --- Task 10: LoopKitSpawner tick（pi-loop fire 序列：due + .round.lock 跨宿主互斥）---

/** 真 fs fixture：root/loops/l/LOOP.md（discoverKitLoops 直接消费，锁/.lastrun 落在真盘上）。 */
function makeLoopWorkspace({ cron = "*/30 * * * *", timezone = "UTC" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "spawner-"));
  const dir = join(root, "loops", "l");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), `---\ncron: "${cron}"\ntimezone: ${timezone}\nmax_minutes: 5\n---\nb`);
  return { root, dir };
}

test("tick：due 的 loop 起轮并写 .lastrun 与 daemon 锁（含 sessionId 回填）；未 due 跳过", async () => {
  const { root, dir } = makeLoopWorkspace();
  try {
    const seen = [];
    const spawner = new LoopKitSpawner({
      discover: async () => [{ id: "ws", path: root, available: true }],
      discoverLoops: async (path) => discoverKitLoops(path),
      halted: async () => false,
      runRound: async (decl, hooks) => {
        hooks?.onSessionStart?.("sess-42");
        seen.push(decl.loopName);
        // 锁内回填：onSessionStart 之后锁记录带上 sessionId + daemon 宿主身份
        const lock = JSON.parse(readFileSync(join(dir, ".round.lock"), "utf8"));
        assert.equal(lock.sessionId, "sess-42");
        assert.equal(lock.kind, "daemon");
        return "sess-42";
      },
      now: () => new Date("2024-01-15T10:31:00Z"),
    });
    await spawner.tick();
    assert.deepEqual(seen, ["l"]); // due（.lastrun 缺省 → 立即补跑）
    assert.equal(readFileSync(join(dir, ".lastrun"), "utf8").trim(), "2024-01-15T10:31:00.000Z");
    assert.ok(!existsSync(join(dir, ".round.lock"))); // 轮结束即释放
    // 再 tick 同一时刻 → 未 due（.lastrun=10:31，nextDue=11:00）
    await spawner.tick();
    assert.equal(seen.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("双宿主互斥：beat 锁在场 → tick 跳过该 loop", async () => {
  const { root, dir } = makeLoopWorkspace();
  try {
    writeFileSync(join(dir, ".round.lock"),
      JSON.stringify({ pid: process.pid, host: "beat-host", kind: "beat", startedAt: Date.now() }));
    let ran = 0;
    const spawner = new LoopKitSpawner({
      discover: async () => [{ id: "ws", path: root, available: true }],
      discoverLoops: async (path) => discoverKitLoops(path),
      halted: async () => false,
      runRound: async () => { ran++; return "sess-x"; },
      now: () => new Date("2024-01-15T10:31:00Z"),
    });
    await spawner.tick();
    assert.equal(ran, 0); // beat 活锁在场，daemon 让位
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("双 loop 独立性：a 轮在飞不阻塞 b（per-loop due/锁，跨 spawner 证明）", async () => {
  const root = mkdtempSync(join(tmpdir(), "spawner-dual-"));
  try {
    for (const name of ["a", "b"]) {
      const dir = join(root, "loops", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "LOOP.md"), `---\ncron: "* * * * *"\ntimezone: UTC\nmax_minutes: 5\n---\nbody ${name}`);
    }
    // 声明顺序钉死 a → b（readdir 序不保证，旧实现的整 workspace 串行语义靠顺序复现）
    const discoverLoopsSorted = async (path) =>
      (await discoverKitLoops(path)).sort((x, y) => x.loopName.localeCompare(y.loopName));
    let resolveA;
    let aStarted = false;
    const fired1 = [];
    const spawner1 = new LoopKitSpawner({
      discover: async () => [{ id: "ws", path: root, available: true }],
      discoverLoops: discoverLoopsSorted,
      halted: async () => false,
      runRound: async (declaration) => {
        fired1.push(declaration.loopName);
        if (declaration.loopName === "a") {
          aStarted = true;
          return new Promise((resolve) => { resolveA = () => resolve("sess-a"); }); // a 轮在飞，测试控住放行
        }
        return "sess-b-1";
      },
      now: () => new Date("2026-09-12T00:08:00.000Z"),
    });
    const tick1 = spawner1.tick(); // 不 await —— 卡在 a 轮（fire 序列已写 .lastrun/锁）
    await new Promise((r) => setTimeout(r, 300)); // 等 a 起飞
    assert.ok(aStarted, "a 轮已开始");
    // 第二个 spawner（同 workspace，另一次 tick）：a 已 fire 过（.lastrun 未 due + 锁在飞）→ 跳过；b 独立起轮
    const fired2 = [];
    const spawner2 = new LoopKitSpawner({
      discover: async () => [{ id: "ws", path: root, available: true }],
      discoverLoops: discoverLoopsSorted,
      halted: async () => false,
      runRound: async (declaration) => { fired2.push(declaration.loopName); return "sess-b-2"; },
      now: () => new Date("2026-09-12T00:08:00.000Z"),
    });
    await spawner2.tick();
    assert.deepEqual(fired2, ["b"]); // b 照常 fire
    assert.deepEqual(fired1, ["a"]); // 第一个 tick 仍卡在 a，没轮到 b
    assert.ok(existsSync(join(root, "loops", "a", ".round.lock")), "a 轮仍在飞（锁持有中）");
    assert.ok(existsSync(join(root, "loops", "b", ".lastrun")), "b 已写自己的 .lastrun");
    // 放行 a → 第一个 tick 完成，a 的锁释放；b 因 .lastrun 已写而不再补 fire
    resolveA();
    await tick1;
    assert.deepEqual(fired1, ["a"]);
    assert.ok(existsSync(join(root, "loops", "a", ".lastrun")));
    assert.ok(!existsSync(join(root, "loops", "a", ".round.lock")));
    assert.ok(!existsSync(join(root, "loops", "b", ".round.lock")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid timezone declaration is skipped, later workspaces still fire (tick never throws)", async () => {
  const bad = makeLoopWorkspace({ timezone: "Asia/Shanghao" });
  const good = makeLoopWorkspace();
  try {
    const rounds = [];
    const spawner = new LoopKitSpawner({
      discover: async () => [
        { id: "ws-bad", path: bad.root, available: true },
        { id: "ws-good", path: good.root, available: true },
      ],
      discoverLoops: async (path) => discoverKitLoops(path),
      halted: async () => false,
      runRound: async (declaration) => { rounds.push(declaration.loopName); return "sess"; },
      now: () => new Date("2026-09-12T00:08:00.000Z"),
    });
    await spawner.tick(); // 坏时区声明不得炸 tick（nextDue 畸形输入返回 undefined）
    assert.deepEqual(rounds, ["l"]); // 后注册的 workspace 照常起轮
  } finally {
    rmSync(bad.root, { recursive: true, force: true });
    rmSync(good.root, { recursive: true, force: true });
  }
});

test("halted workspace never fires", async () => {
  const { root } = makeLoopWorkspace();
  try {
    let ran = 0;
    const spawner = new LoopKitSpawner({
      discover: async () => [{ id: "ws", path: root, available: true }],
      discoverLoops: async (path) => discoverKitLoops(path),
      halted: async () => true,
      runRound: async () => { ran++; return "sess"; },
      now: () => new Date("2024-01-15T10:31:00Z"),
    });
    await spawner.tick();
    assert.equal(ran, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("round error is swallowed (job keeps ticking; lock released, next due still fires)", async () => {
  const { root, dir } = makeLoopWorkspace({ cron: "* * * * *" });
  try {
    let attempts = 0;
    const spawner = new LoopKitSpawner({
      discover: async () => [{ id: "ws", path: root, available: true }],
      discoverLoops: async (path) => discoverKitLoops(path),
      halted: async () => false,
      runRound: async () => { attempts++; throw new Error("boom"); },
      now: (() => {
        let minute = 0;
        return () => { minute += 1; return new Date(Date.parse("2026-09-12T00:08:00.000Z") + minute * 60_000); };
      })(),
    });
    await spawner.tick(); // 第一次 due（缺 .lastrun）→ runRound 抛 → tick 吞
    await spawner.tick(); // 锁已释放、下一分钟又 due → 再抛再吞
    assert.equal(attempts, 2);
    assert.ok(!existsSync(join(dir, ".round.lock"))); // fire 的 finally 保证释放
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
