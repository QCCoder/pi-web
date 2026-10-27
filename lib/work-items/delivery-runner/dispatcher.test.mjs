// Phase-2 Task 7: DeliveryDispatcher（dispatcher.ts + background 装配）。
// Phase-5 T2 增补：四角色合并队列分派验证（release-preparer 排首 →
// launchRoleSession 按其角色起会话——dispatcher 零机制变化）。
// final-arch step-3 T3 增补（system 检查步）：tickWorkspace 变 reap → runChecksStep
// （首个 due 项，占槽 + 本拍 return 不起 LLM 轮）→ dispatch → attend；deps 注入
// checksDue / checksCandidates / runChecksStep（默认 checks-step 真实现）。
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
//  13. 检查步：有 due 项 → runChecksStep 调用且不 launch（占槽）；活动执行在场 /
//      无 due / 扫描炸 → 原派发路径；runChecksStep 抛 → tick 不中断
// 真实现的链路（facade/claim 服务/role-session 装配/checks-step 事务）由各自测试覆盖。
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
// final-arch step-3 T3：verifier 不再从池子投影（system 检查步接手）——分派
// 队列的第三活角色是 reviewer（池投影自带 role，dispatcher 仍零机制透传）。
const READY_REV_P0 = { key: "REQ-0004", title: "审查项", priority: "P0", requirementDigest: "d4", ready: true, reasons: [], role: "reviewer" };
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
    // final-arch step-3 T3：检查步三件的假件（默认空候选零副作用——既有用例
    // 不碰检查步；检查步用例覆写后经 calls 断言）。
    checksDue: () => ({ due: false, reasons: ["checks-empty"] }),
    checksCandidates: async () => [],
    runChecksStep: async () => "skipped",
    // final-arch step-2 Task 5：attend 三步的假件（默认空投影零副作用——既有
    // 用例不碰 attend；个别用例覆写后经 calls / 自带 events 数组断言）。
    collectAttention: async () => [],
    appendEvent: async (itemPath, event) => {
      calls.push(["event", itemPath, event]);
    },
    writePaused: (itemPath, info) => {
      calls.push(["paused", itemPath, info]);
    },
    readItemPath: async (_workspacePath, key) => `/items/${key}`,
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

// final-arch step-3 T3：reviewer ready 项被正确分派——P0 reviewer 优先于 P1
// designer 时 launchRoleSession(role=reviewer)（同一合并队列/单槽位，机制零变化）。
test("合并队列：P0 reviewer 排在 P1 designer 前 → launchRoleSession(role=reviewer)", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [READY_REV_P0, READY_B], blocked: [] }),
  });
  await new DeliveryDispatcher(deps).tick();
  const launches = calls.filter((c) => c[0] === "launch");
  assert.equal(launches.length, 1, "单槽位：一次只 launch 队首一条");
  const opts = launches[0][1];
  assert.equal(opts.role, "reviewer");
  assert.deepEqual(opts.task, { key: "REQ-0004", title: "审查项" });
  assert.deepEqual(opts.claim, {});
});

// Phase-5 T2：四角色合并队列——P0 release-preparer 排首时 launchRoleSession
// (role=release-preparer)（dispatcher 零机制变化，DeliveryRole 扩值自动流过；
// 四角色共用同一合并队列/单槽位）。
test("合并队列（四角色）：P0 release-preparer 排首 → launchRoleSession(role=release-preparer)", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({
      // 池子已按 P0→P3→key 排好：release-preparer P0 在首，其余三角色垫后。
      ready: [READY_REL_P0, { ...READY_DEV_P0, priority: "P1" }, { ...READY_REV_P0, priority: "P1" }, READY_B],
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

// final-arch step-2 Task 3：上一轮 ask 的人工答复随任务包进 launch——只透传
// 已答条目（未答项被池谓词 awaiting-answer 挡在 ready 外，此过滤是防御性钉子）。
test("launch 携带条目的已答澄清（未答条目不透传）", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({
      ready: [{
        ...READY_A,
        clarifications: [
          { question: "已答的？", answer: "答案", askedAt: "2026-10-26T00:00:00Z" },
          { question: "未答的？", askedAt: "2026-10-26T00:01:00Z" },
        ],
      }],
      blocked: [],
    }),
  });
  await new DeliveryDispatcher(deps).tick();
  const launches = calls.filter((c) => c[0] === "launch");
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0][1].clarifications, [
    { question: "已答的？", answer: "答案", askedAt: "2026-10-26T00:00:00Z" },
  ]);
});

test("条目无澄清 → launch clarifications 为空数组（开场 prompt 不出问答段）", async () => {
  const { deps, calls } = makeDeps();
  await new DeliveryDispatcher(deps).tick();
  const opts = calls.filter((c) => c[0] === "launch")[0][1];
  assert.deepEqual(opts.clarifications, []);
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

// final-arch step-3 Task 3：系统检查步（reap → checks → dispatch → attend）。
//   20. 有 due 项 → runChecksStep(workspacePath, key) 调用且本拍不 launch（占槽）
//   21. 无 due → 原派发路径照常
//   22. 活动执行在场 → 检查步不并发（单槽位闸先行）
//   23. due 扫描炸 → 记日志让路，派发照常
//   24. runChecksStep 拒绝 → tick 不中断（fire-and-forget catch 记日志）
//   25. 多条 due 只开首条（P0→P3→key 序由 checksCandidatesFor 保证，此处假序透传）
test("检查步：有 due 项 → runChecksStep 调用且不 launch（本拍占槽返回）", async () => {
  const dueItem = { key: "REQ-0004", priority: "P0", item: { key: "REQ-0004", phase: "verification" }, ctx: { enabled: true } };
  const { deps, calls } = makeDeps({
    checksCandidates: async () => [dueItem],
    checksDue: () => ({ due: true, reasons: [] }),
    runChecksStep: async (workspacePath, key) => {
      calls.push(["checks", workspacePath, key]);
      return "verified";
    },
  });
  await new DeliveryDispatcher(deps).tick();
  const checks = calls.filter((c) => c[0] === "checks");
  assert.equal(checks.length, 1);
  assert.equal(checks[0][1], WS_PATH);
  assert.equal(checks[0][2], "REQ-0004");
  assert.equal(calls.filter((c) => c[0] === "launch").length, 0, "checks step occupies the slot this tick");
});

test("检查步：无 due → 原派发路径照常 launch", async () => {
  const dueItem = { key: "REQ-0004", priority: "P0", item: { key: "REQ-0004", phase: "verification" }, ctx: { enabled: true } };
  const { deps, calls } = makeDeps({
    checksCandidates: async () => [dueItem],
    checksDue: () => ({ due: false, reasons: ["checks-done"] }),
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "launch").length, 1);
});

test("检查步：活动执行在场 → 不并发开跑（也不 launch）", async () => {
  let checksRuns = 0;
  const { deps, calls } = makeDeps({
    activeExecution: async () => true,
    checksCandidates: async () => [{ key: "REQ-0004", priority: "P0", item: {}, ctx: {} }],
    checksDue: () => ({ due: true, reasons: [] }),
    runChecksStep: async () => {
      checksRuns += 1;
      return "verified";
    },
    scanClaims: async () => [],
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(checksRuns, 0, "single-slot gate comes first");
  assert.equal(calls.filter((c) => c[0] === "launch").length, 0);
});

test("检查步：due 扫描炸 → 记日志让路，派发照常", async () => {
  const { deps, calls } = makeDeps({
    checksCandidates: async () => {
      throw new Error("scan boom");
    },
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "launch").length, 1, "dispatch survives a broken scan");
});

test("检查步：runChecksStep 拒绝 → tick 不中断（fire-and-forget 已 catch）", async () => {
  const { deps } = makeDeps({
    checksCandidates: async () => [{ key: "REQ-0004", priority: "P0", item: {}, ctx: {} }],
    checksDue: () => ({ due: true, reasons: [] }),
    runChecksStep: async () => {
      throw new Error("checks boom");
    },
  });
  await new DeliveryDispatcher(deps).tick();
  await new Promise((resolve) => setImmediate(resolve)); // rejection 已被 catch，不产生 unhandled
});

test("检查步：多条 due 只开首条（checksCandidates 序即优先级序）", async () => {
  const calls = [];
  const { deps } = makeDeps({
    checksCandidates: async () => [
      { key: "REQ-0004", priority: "P0", item: {}, ctx: {} },
      { key: "REQ-0005", priority: "P1", item: {}, ctx: {} },
    ],
    checksDue: () => ({ due: true, reasons: [] }),
    runChecksStep: async (_workspacePath, key) => {
      calls.push(key);
      return "verified";
    },
    launch: async (opts) => {
      calls.push(`launch:${opts.task.key}`);
      return "s";
    },
  });
  await new DeliveryDispatcher(deps).tick();
  assert.deepEqual(calls, ["REQ-0004"]);
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

// final-arch step-2 Task 5：attend 第三步——催办/泊车（全假 deps）。
//   13. 过催办线且未催 → 恰一条 delivery.nudged（actor agent，data {kind,
//       ageDays, since}）；投影反映事件（nudged 翻真）后二拍不重复
//   14. 过泊车线且未泊 → writePaused(reason=attention-parked) + 一条
//       delivery.parked，二拍不重复；泊车不再催办（parked=true 不出 nudged）
//   15. 已催未泊且过泊车线 → 照样泊（泊车不要求未催）
//   16. 未过线零调用；恰好过线（>=）生效
//   17. config 缺 attention 块 → 默认 3/7 生效
//   18. attend 整体异常（collectAttention 抛）→ tick 不抛，后续 workspace 照常
//   19. 单条事件追加异常 → 该项记日志跳过，其余条目照常处理
test("attend：过催办线且未催 → 恰一条 delivery.nudged；投影翻真后二拍不重复", async () => {
  const attention = makeFlippableAttention([{ key: "REQ-0001", title: "问号项", kind: "question", since: "2026-10-20T12:00:00.000Z", ageDays: 4, nudged: false, parked: false, detail: "Q?" }]);
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [], blocked: [] }),
    ...attention,
  });
  await new DeliveryDispatcher(deps).tick();
  const nudges = attention.events.filter(([, evt]) => evt.type === "delivery.nudged");
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0][0], "/items/REQ-0001");
  assert.equal(nudges[0][1].actor, "agent");
  assert.deepEqual(nudges[0][1].data, { kind: "question", ageDays: 4, since: "2026-10-20T12:00:00.000Z" });
  assert.equal(calls.filter((c) => c[0] === "paused").length, 0, "未过泊车线不写 paused");
  await new DeliveryDispatcher(deps).tick();
  assert.equal(attention.events.filter(([, evt]) => evt.type === "delivery.nudged").length, 1, "二拍不重复");
});

test("attend：过泊车线且未泊 → writePaused(attention-parked) + delivery.parked 各一次，二拍不重复", async () => {
  const attention = makeFlippableAttention([{ key: "REQ-0002", title: "搁置项", kind: "blocked", since: "2026-10-15T12:00:00.000Z", ageDays: 9, nudged: false, parked: false, detail: "自动化已暂停待恢复" }]);
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [], blocked: [] }),
    ...attention,
  });
  await new DeliveryDispatcher(deps).tick();
  const pauses = calls.filter((c) => c[0] === "paused");
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0][1], "/items/REQ-0002");
  assert.deepEqual(pauses[0][2], { at: new Date(NOW).toISOString(), reason: "attention-parked", count: 0 });
  const parks = attention.events.filter(([, evt]) => evt.type === "delivery.parked");
  assert.equal(parks.length, 1);
  assert.equal(parks[0][1].actor, "agent");
  assert.equal(parks[0][1].data.kind, "blocked");
  assert.equal(attention.events.some(([, evt]) => evt.type === "delivery.nudged"), false, "泊车不催办");
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "paused").length, 1, "二拍不重复");
  assert.equal(attention.events.filter(([, evt]) => evt.type === "delivery.parked").length, 1);
});

test("attend：已催未泊且过泊车线 → 照样泊车（泊车不要求未催）", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [], blocked: [] }),
    collectAttention: async () => [{ key: "REQ-0003", title: "催过项", kind: "confirm", since: "2026-10-17T12:00:00.000Z", ageDays: 7, nudged: true, parked: false, detail: "设计待确认" }],
    readItemPath: async (_workspacePath, key) => `/items/${key}`,
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "paused").length, 1);
  assert.equal(calls.filter((c) => c[0] === "event" && c[2].type === "delivery.parked").length, 1);
});

test("attend：parked=true → 零调用（泊过不再催也不再泊）", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [], blocked: [] }),
    collectAttention: async () => [{ key: "REQ-0004", title: "已泊", kind: "question", since: "2026-10-01T12:00:00.000Z", ageDays: 23, nudged: true, parked: true, detail: "Q?" }],
    readItemPath: async () => {
      calls.push(["itemPath"]);
      return "/items/x";
    },
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "event").length, 0);
  assert.equal(calls.filter((c) => c[0] === "paused").length, 0);
  assert.equal(calls.filter((c) => c[0] === "itemPath").length, 0, "parked 项连 itemPath 都不读");
});

// step-7 backlog-clearing T1：泊车抑制的 attend 面契约——blocked 投影在「晚于
// since 存在任意 kind 的 delivery.parked」时翻 parked 位（attention.ts 的
// hasAnyParkedSince），attend 两分支都以 !parked 为门 → 催办与泊车双双跳过
// （即使已过泊车线）。此处以投影产物形状（parked=true 的 blocked 条目）钉死。
test("attend：blocked 条目带跨 kind 泊车抑制（parked=true 形状）→ 过泊车线也不催不泊", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [], blocked: [] }),
    collectAttention: async () => [{
      key: "REQ-0011",
      title: "抑制项",
      kind: "blocked",
      since: "2026-10-15T12:00:00.000Z",
      ageDays: 9,
      nudged: false,
      parked: true,
      detail: "上游接口未定",
    }],
    readItemPath: async () => {
      calls.push(["itemPath"]);
      return "/items/x";
    },
  });
  await new DeliveryDispatcher(deps).tick();
  assert.equal(calls.filter((c) => c[0] === "paused").length, 0, "已过泊车线但抑制生效：不泊");
  assert.equal(
    calls.filter((c) => c[0] === "event" && c[2].type === "delivery.nudged").length,
    0,
    "不催",
  );
  assert.equal(calls.filter((c) => c[0] === "itemPath").length, 0, "抑制条目连 itemPath 都不读");
});

test("attend：未过线零调用；恰好过线（>=）生效", async () => {
  {
    const { deps, calls } = makeDeps({
      pool: async () => ({ ready: [], blocked: [] }),
      collectAttention: async () => [{ key: "REQ-0005", title: "新鲜项", kind: "release", since: "2026-10-25T12:00:00.000Z", ageDays: 1, nudged: false, parked: false, detail: "待登记发布" }],
      readItemPath: async () => "/items/x",
    });
    await new DeliveryDispatcher(deps).tick();
    assert.equal(calls.filter((c) => c[0] === "event").length, 0, "1 天 < 3 天不催");
  }
  {
    const { deps, calls } = makeDeps({
      pool: async () => ({ ready: [], blocked: [] }),
      collectAttention: async () => [{ key: "REQ-0006", title: "整线项", kind: "release", since: "2026-10-23T12:00:00.000Z", ageDays: 3, nudged: false, parked: false, detail: "待登记发布" }],
      readItemPath: async () => "/items/x",
    });
    await new DeliveryDispatcher(deps).tick();
    assert.equal(calls.filter((c) => c[0] === "event" && c[2].type === "delivery.nudged").length, 1, "恰好 3 天 ≥ nudge 线 → 催");
  }
});

test("attend：config 缺 attention 块 → 默认 3/7 生效", async () => {
  {
    const { deps, calls } = makeDeps({
      pool: async () => ({ ready: [], blocked: [] }),
      collectAttention: async () => [{ key: "REQ-0007", title: "默认线", kind: "question", since: "2026-10-18T12:00:00.000Z", ageDays: 6, nudged: false, parked: false, detail: "Q?" }],
      readItemPath: async () => "/items/x",
    });
    await new DeliveryDispatcher(deps).tick();
    assert.equal(calls.filter((c) => c[0] === "event" && c[2].type === "delivery.nudged").length, 1, "6 天 ≥ 默认 nudge 3");
    assert.equal(calls.filter((c) => c[0] === "paused").length, 0, "6 天 < 默认 park 7");
  }
  {
    const { deps, calls } = makeDeps({
      pool: async () => ({ ready: [], blocked: [] }),
      collectAttention: async () => [{ key: "REQ-0008", title: "默认泊", kind: "question", since: "2026-10-15T12:00:00.000Z", ageDays: 9, nudged: false, parked: false, detail: "Q?" }],
      readItemPath: async () => "/items/x",
    });
    await new DeliveryDispatcher(deps).tick();
    assert.equal(calls.filter((c) => c[0] === "paused").length, 1, "9 天 ≥ 默认 park 7");
  }
});

test("attend：collectAttention 抛 → tick 不抛，后续 workspace 照常 dispatch", async () => {
  const launches = [];
  const { deps } = makeDeps({
    discover: async () => [
      { id: "ws-bad", path: "/tmp/ws-bad", available: true },
      { id: "ws-good", path: "/tmp/ws-good", available: true },
    ],
    // ws-bad 池子空（隔离 attend 抛错的效果——dispatch 在 attend 之前）。
    pool: async (workspacePath) =>
      workspacePath === "/tmp/ws-good" ? { ready: [READY_A], blocked: [] } : { ready: [], blocked: [] },
    collectAttention: async (workspacePath) => {
      if (workspacePath === "/tmp/ws-bad") throw new Error("attention boom");
      return [];
    },
    launch: async (opts) => {
      launches.push(opts.workspaceId);
      return "s";
    },
  });
  await new DeliveryDispatcher(deps).tick(); // 不 reject
  assert.deepEqual(launches, ["ws-good"]);
});

test("attend：单条事件追加异常 → 记日志跳过该项，其余条目照常", async () => {
  const { deps, calls } = makeDeps({
    pool: async () => ({ ready: [], blocked: [] }),
    collectAttention: async () => [
      { key: "REQ-0009", title: "会炸", kind: "question", since: "2026-10-18T12:00:00.000Z", ageDays: 6, nudged: false, parked: false, detail: "Q?" },
      { key: "REQ-0010", title: "正常", kind: "question", since: "2026-10-18T12:00:00.000Z", ageDays: 6, nudged: false, parked: false, detail: "Q?" },
    ],
    readItemPath: async (_workspacePath, key) => `/items/${key}`,
    appendEvent: async (itemPath, event) => {
      if (itemPath === "/items/REQ-0009") throw new Error("append boom");
      calls.push(["event", itemPath, event]);
    },
  });
  await new DeliveryDispatcher(deps).tick();
  const nudgedKeys = calls.filter((c) => c[0] === "event").map((c) => c[1]);
  assert.deepEqual(nudgedKeys, ["/items/REQ-0010"], "炸的那条跳过，正常的照常");
});

// attend 假件：投影 + 事件追加成对注入——事件写进去 nudged/parked 才翻真，
// 第二拍才能看到「幂等由构造保证」（静态假件测不出二拍不重复）。itemPath 末
// 段即 key（与默认 readItemPath 的 /items/<key> 配套）。
function makeFlippableAttention(entries) {
  const state = entries.map((entry) => ({ entry, nudged: entry.nudged, parked: entry.parked }));
  const events = [];
  return {
    events,
    collectAttention: async () =>
      state.map((slot) => ({ ...slot.entry, nudged: slot.nudged, parked: slot.parked })),
    appendEvent: async (itemPath, event) => {
      events.push([itemPath, event]);
      const slot = state.find((candidate) => candidate.entry.key === itemPath.split("/").at(-1));
      if (slot === undefined) return;
      if (event.type === "delivery.nudged") slot.nudged = true;
      if (event.type === "delivery.parked") slot.parked = true;
    },
  };
}

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
