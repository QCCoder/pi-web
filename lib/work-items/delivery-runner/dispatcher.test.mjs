// Phase-2 Task 7: DeliveryDispatcher（dispatcher.ts + background 装配）。
// Phase-5 T2 增补：四角色合并队列分派验证（release-preparer 排首 →
// launchRoleSession 按其角色起会话——dispatcher 零机制变化）。
// 全假 deps（不碰真 fs/会话）验证 tick 语义：
//   1. 无启用工作区（配置缺失 / enabled=false）→ 不 launch
//   2. enabled 但已有活动执行（activeExecution）→ 不 launch（单槽位互斥，pool 不读）
//   3. ready 非空且无活动 → launch 一次且只领首条（多条 ready 不重复），config 透传
//   4. capability 门（work-items+workflows 缺一）→ 整个 workspace 分支跳过
//   5. available=false → 跳过（配置都不读）
//   6. 超时活动 claim（claimedAt 起算，严格 >）→ probe 活 → destroy + recordInterruption
//   7. 超时但会话已死（probe → null）→ 不 destroy 仍记中断（宿主重启遗留的陈旧 claim）
//   8. 未超时 / 恰好到达上限的 claim 不动
//   9. tick 异常不抛（discover 抛 / 单 workspace 配置抛 → 后续 workspace 照常）
//  10. launch 失败被 catch（fire-and-forget 不裸奔）
//  11. start：首拍立即 + 30s interval；stop 清定时器
//  12. background source 断言：装配链含 delivery-dispatcher、stop 双覆盖、test 豁免
// 真实现的链路（facade/claim 服务/role-session 装配）由各自测试覆盖。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { DeliveryDispatcher } = await jiti.import("./dispatcher.ts");

const WS_PATH = "/tmp/ws-dispatch";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const CONFIG_ENA = {
  schemaVersion: 1,
  enabled: true,
  roles: { designer: { profile: "architect" } },
  budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
};
const READY_A = { key: "REQ-0001", title: "高优先", priority: "P0", requirementDigest: "d1", ready: true, reasons: [], role: "designer" };
const READY_B = { key: "REQ-0002", title: "次优先", priority: "P1", requirementDigest: "d2", ready: true, reasons: [], role: "designer" };
// Phase-3 T4：合并队列里的 developer 条目（角色由项所处阶段决定——池投影自带）。
const READY_DEV_P0 = { key: "REQ-0003", title: "开发项", priority: "P0", requirementDigest: "d3", ready: true, reasons: [], role: "developer" };
// Phase-4 T4：verifier 为第三角色经同一合并队列分派（零机制变化——role 由池子投影自带）。
const READY_VER_P0 = { key: "REQ-0004", title: "验证项", priority: "P0", requirementDigest: "d4", ready: true, reasons: [], role: "verifier" };
// Phase-5 T2：release-preparer 为第四角色经同一合并队列分派（零机制变化——
// DeliveryRole 扩值自动流过；验证性断言）。
const READY_REL_P0 = { key: "REQ-0005", title: "发布项", priority: "P0", requirementDigest: "d5", ready: true, reasons: [], role: "release-preparer" };

const claimOf = (sessionId, claimedAt, role = "designer") => ({
  attemptId: "att-1",
  generation: 1,
  role,
  sessionId,
  claimedAt,
  lastSeenAt: claimedAt,
  requirementDigest: "d",
  ownerTokenHash: "h",
});

function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    discover: async () => [{ id: "ws-1", path: WS_PATH, available: true }],
    readManifest: async () => ({ capabilities: ["sessions", "explorer", "work-items", "workflows"] }),
    readConfig: async () => CONFIG_ENA,
    pool: async () => ({ ready: [READY_A], blocked: [] }),
    launch: async (opts) => {
      calls.push(["launch", opts]);
      return "s-launch";
    },
    activeExecution: async () => false,
    scanClaims: async () => [],
    probeSession: async (sessionId) => {
      calls.push(["probe", sessionId]);
      return { id: sessionId, running: true };
    },
    destroySession: (sessionId) => {
      calls.push(["destroy", sessionId]);
    },
    recordInterruption: async (workspacePath, key, sessionId, reason) => {
      calls.push(["record", workspacePath, key, sessionId, reason]);
    },
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

test("无启用工作区不 launch（配置缺失 / enabled=false）", async () => {
  {
    const { deps, calls } = makeDeps({ readConfig: async () => null });
    await new DeliveryDispatcher(deps).tick();
    assert.equal(calls.filter((c) => c[0] === "launch").length, 0);
  }
  {
    const { deps, calls } = makeDeps({ readConfig: async () => ({ ...CONFIG_ENA, enabled: false }) });
    await new DeliveryDispatcher(deps).tick();
    assert.equal(calls.filter((c) => c[0] === "launch").length, 0);
  }
});

test("enabled 但已有活动执行不 launch（单槽位互斥；pool 不再读）", async () => {
  let poolCalls = 0;
  const { deps, calls } = makeDeps({
    activeExecution: async () => true,
    pool: async () => {
      poolCalls += 1;
      return { ready: [READY_A], blocked: [] };
    },
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "launch").length, 0);
  assert.equal(poolCalls, 0);
});

test("ready 非空且无活动 → launch 一次：多条 ready 只领首条，config 原样透传，role 随条目流动", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [READY_A, READY_B], blocked: [] }),
  });
  await new DeliveryDispatcher(deps).tick();
  const launches = calls.filter((c) => c[0] === "launch");
  assert.equal(launches.length, 1);
  const opts = launches[0][1];
  assert.equal(opts.workspaceId, "ws-1");
  assert.equal(opts.workspacePath, WS_PATH);
  assert.deepEqual(opts.task, { key: "REQ-0001", title: "高优先" });
  assert.equal(opts.role, "designer", "launch carries the entry's role");
  assert.deepEqual(opts.claim, {}, "launch-time claim is empty (claim happens via the tool)");
  // config 引用同一对象——roles[role].profile 等角色配置由 role-session 消费
  assert.equal(opts.config, CONFIG_ENA);
});

// Phase-3 T4：合并队列取首——P0 developer 优先于 P1 designer 时按条目角色分派
// launchRoleSession（消除 T1 的过渡窗口：developer-ready 项不再被当 designer 起会话）。
test("合并队列：P0 developer 排在 P1 designer 前 → launchRoleSession(role=developer)", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [READY_DEV_P0, READY_B], blocked: [] }),
  });
  await new DeliveryDispatcher(deps).tick();
  const launches = calls.filter((c) => c[0] === "launch");
  assert.equal(launches.length, 1, "单槽位：一次只 launch 队首一条");
  const opts = launches[0][1];
  assert.equal(opts.role, "developer");
  assert.deepEqual(opts.task, { key: "REQ-0003", title: "开发项" });
  assert.deepEqual(opts.claim, {});
});

test("合并队列：同优先级跨角色按 key 交错（角色不作 tiebreaker）→ 首条按其角色分派", async () => {
  const devLater = { ...READY_DEV_P0, key: "REQ-0009", priority: "P1" };
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [READY_B, devLater], blocked: [] }), // 同 P1，REQ-0002 < REQ-0009
  });
  await new DeliveryDispatcher(deps).tick();
  const launches = calls.filter((c) => c[0] === "launch");
  assert.equal(launches.length, 1);
  assert.equal(launches[0][1].role, "designer");
  assert.equal(launches[0][1].task.key, "REQ-0002");
});

// Phase-4 T4：verifier ready 项被正确分派——P0 verifier 优先于 P1 designer 时
// launchRoleSession(role=verifier)（三角色共用同一合并队列/单槽位，机制零变化）。
test("合并队列：P0 verifier 排在 P1 designer 前 → launchRoleSession(role=verifier)", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [READY_VER_P0, READY_B], blocked: [] }),
  });
  await new DeliveryDispatcher(deps).tick();
  const launches = calls.filter((c) => c[0] === "launch");
  assert.equal(launches.length, 1, "单槽位：一次只 launch 队首一条");
  const opts = launches[0][1];
  assert.equal(opts.role, "verifier");
  assert.deepEqual(opts.task, { key: "REQ-0004", title: "验证项" });
  assert.deepEqual(opts.claim, {});
});

// Phase-5 T2：四角色合并队列——P0 release-preparer 排首时 launchRoleSession
// (role=release-preparer)（dispatcher 零机制变化，DeliveryRole 扩值自动流过；
// 四角色共用同一合并队列/单槽位）。
test("合并队列（四角色）：P0 release-preparer 排首 → launchRoleSession(role=release-preparer)", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({
      // 池子已按 P0→P3→key 排好：release-preparer P0 在首，其余三角色垫后。
      ready: [READY_REL_P0, { ...READY_DEV_P0, priority: "P1" }, { ...READY_VER_P0, priority: "P1" }, READY_B],
      blocked: [],
    }),
  });
  await new DeliveryDispatcher(deps).tick();
  const launches = calls.filter((c) => c[0] === "launch");
  assert.equal(launches.length, 1, "单槽位：一次只 launch 队首一条");
  const opts = launches[0][1];
  assert.equal(opts.role, "release-preparer");
  assert.deepEqual(opts.task, { key: "REQ-0005", title: "发布项" });
  assert.deepEqual(opts.claim, {}, "launch-time claim is empty (pure-document role claims via the tool)");
});

test("capability 门：manifest 缺 workflows → 整个 workspace 分支跳过", async () => {
  let scanCalls = 0;
  const { deps, calls } = makeDeps({
    readManifest: async () => ({ capabilities: ["sessions", "explorer", "work-items"] }),
    scanClaims: async () => {
      scanCalls += 1;
      return [];
    },
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "launch").length, 0);
  assert.equal(scanCalls, 0);
});

test("available=false 的 workspace 跳过（配置都不读）", async () => {
  let configCalls = 0;
  const { deps } = makeDeps({
    discover: async () => [{ id: "ws-x", path: "/tmp/ws-x", available: false }],
    readConfig: async () => {
      configCalls += 1;
      return CONFIG_ENA;
    },
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(configCalls, 0);
});

test("超时活动 claim（claimedAt 起算）→ probe 活 → destroy + recordInterruption", async () => {
  const { deps, calls } = makeDeps({
    activeExecution: async () => true, // 清道夫独立于派发：活动执行在场仍要清超时
    scanClaims: async () => [{ key: "REQ-0009", claim: claimOf("s-stale", "2026-10-24T11:00:00.000Z") }], // 60min > 30min
  });
  await new DeliveryDispatcher(deps).tick();
  assert.deepEqual(calls.filter((c) => c[0] === "destroy").map((c) => c[1]), ["s-stale"]);
  const records = calls.filter((c) => c[0] === "record");
  assert.equal(records.length, 1);
  assert.equal(records[0][1], WS_PATH);
  assert.equal(records[0][2], "REQ-0009");
  assert.equal(records[0][3], "s-stale");
  assert.equal(records[0][4], "execution timeout");
  assert.equal(calls.filter((c) => c[0] === "launch").length, 0);
});

test("超时但会话已死（probe → null）→ 不 destroy，仍记中断清陈旧 claim", async () => {
  const { deps, calls } = makeDeps({
    activeExecution: async () => true,
    probeSession: async () => null,
    scanClaims: async () => [{ key: "REQ-0009", claim: claimOf("s-dead", "2026-10-24T10:00:00.000Z") }],
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "destroy").length, 0);
  const records = calls.filter((c) => c[0] === "record");
  assert.equal(records.length, 1);
  assert.equal(records[0][3], "s-dead");
  assert.equal(records[0][4], "execution timeout");
});

test("未超时 / 恰好到达上限（严格 >）的 claim 不动", async () => {
  const { deps, calls } = makeDeps({
    activeExecution: async () => true,
    scanClaims: async () => [
      { key: "REQ-0001", claim: claimOf("s-fresh", "2026-10-24T11:45:00.000Z") }, // 15min
      { key: "REQ-0002", claim: claimOf("s-edge", "2026-10-24T11:30:00.000Z") }, // 恰好 30min，不 >
      { key: "REQ-0003", claim: null },
    ],
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "probe").length, 0);
  assert.equal(calls.filter((c) => c[0] === "destroy").length, 0);
  assert.equal(calls.filter((c) => c[0] === "record").length, 0);
});

// Phase-3 T4：超时清道夫对 developer claim 同样生效（claimedAt 起算不变，
// recordInterruption 已 role 无关——清道夫只看 claim.claimedAt/sessionId）。
test("超时 developer claim（claimedAt 起算）→ probe 活 → destroy + recordInterruption", async () => {
  const { deps, calls } = makeDeps({
    activeExecution: async () => true,
    scanClaims: async () => [
      { key: "REQ-0009", claim: claimOf("s-dev-stale", "2026-10-24T11:00:00.000Z", "developer") }, // 60min > 30min
    ],
  });
  await new DeliveryDispatcher(deps).tick();
  assert.deepEqual(calls.filter((c) => c[0] === "destroy").map((c) => c[1]), ["s-dev-stale"]);
  const records = calls.filter((c) => c[0] === "record");
  assert.equal(records.length, 1);
  assert.equal(records[0][2], "REQ-0009");
  assert.equal(records[0][3], "s-dev-stale");
  assert.equal(records[0][4], "execution timeout");
});

test("tick 异常不抛：discover 抛 / 单 workspace 配置抛 → 后续 workspace 照常 launch", async () => {
  {
    const { deps } = makeDeps({
      discover: async () => {
        throw new Error("discover boom");
      },
    });
    await new DeliveryDispatcher(deps).tick(); // 不 reject
  }
  {
    const launches = [];
    const { deps } = makeDeps({
      discover: async () => [
        { id: "ws-bad", path: "/tmp/ws-bad", available: true },
        { id: "ws-good", path: "/tmp/ws-good", available: true },
      ],
      readConfig: async (workspacePath) => {
        if (workspacePath === "/tmp/ws-bad") throw new Error("config boom");
        return CONFIG_ENA;
      },
      launch: async (opts) => {
        launches.push(opts.workspaceId);
        return "s";
      },
    });
    await new DeliveryDispatcher(deps).tick();
    assert.deepEqual(launches, ["ws-good"]);
  }
});

test("launch 失败被 catch（fire-and-forget 不裸奔，tick 不受影响）", async () => {
  const { deps } = makeDeps({
    launch: async () => {
      throw new Error("launch boom");
    },
  });
  await new DeliveryDispatcher(deps).tick();
  await new Promise((resolve) => setImmediate(resolve)); // rejection 已被 catch，不产生 unhandled
});

test("start：首拍立即 + 30s interval；stop 清定时器", async (t) => {
  const { deps, calls } = makeDeps();
  // 只 mock setInterval（对照 role-session 心跳测试习语：真 clearInterval 对 mock 句柄有效）
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    const dispatcher = new DeliveryDispatcher(deps);
    dispatcher.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((c) => c[0] === "launch").length, 1); // 首拍立即
    t.mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((c) => c[0] === "launch").length, 2);
    dispatcher.stop();
    t.mock.timers.tick(90_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((c) => c[0] === "launch").length, 2); // stop 后不再拍
  } finally {
    t.mock.timers.reset();
  }
});

test("background 装配：delivery-dispatcher 进 boot 链、stop 双覆盖、PI_TEST_NO_BACKGROUND 同豁免", () => {
  const source = readFileSync(new URL("../../session-host/background.ts", import.meta.url), "utf8");
  // 1. 装配链：懒加载 dispatcher（work-item 服务不进 resident bundle）并 start
  assert.ok(
    source.includes('import("../work-items/delivery-runner/dispatcher.ts")'),
    "boot 链必须懒加载 dispatcher",
  );
  assert.ok(/new DeliveryDispatcher\(\)/.test(source), "必须实例化并 start DeliveryDispatcher");
  assert.ok(
    /stopDeliveryDispatcher = \(\) => dispatcher\.stop\(\)/.test(source),
    "stop 引用必须镜像 stopLoopSpawner 的存法",
  );
  // 2. stop 双覆盖：stopBackgroundSafely 同时停 loop spawner 与 delivery dispatcher
  const stopFn = source.match(/function stopBackgroundSafely\(\): void \{[\s\S]*?\n\}/)?.[0];
  assert.ok(stopFn, "stopBackgroundSafely 必须存在");
  assert.ok(stopFn.includes("stopLoopSpawner"), "关停必须停 loop spawner");
  assert.ok(stopFn.includes("stopDeliveryDispatcher"), "关停必须停 delivery dispatcher");
  // 3. test 豁免：PI_TEST_NO_BACKGROUND 下 delivery 链同样不启动（与 loop spawner 同条件）
  assert.ok(
    /if \(!testMode\) \{[\s\S]*?delivery-runner\/dispatcher\.ts/.test(source),
    "delivery 装配链必须在 !testMode 守卫内",
  );
});
