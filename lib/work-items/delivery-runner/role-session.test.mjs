// Phase-2 Task 6: designer 会话装配（role-session.ts）。
// 全假 deps（不起真会话）验证：
//   1. 两步创建序：createSession（不带 command）→ grantRole → markDelivery →
//      set_session_name → prompt（sessionId 到手才能 grant/登记/命名）
//   2. config.roles.designer.model 透传建会话 input.model
//   3. 结束钩子：未清 claim（sessionId 匹配）→ recordInterruption；已清/他人
//      claim/二次触发 → 幂等 no-op（revoke/clear 照做）；fix-round 1 兜底——
//      全活动项扫描把本会话名下挂在【其他项】上的违约 claim 也记中断
//   4. 心跳 interval：20s 一拍（fake timers），session 结束即清
//   5. 装配失败（建会话之后的步骤抛错）→ 收尾（revoke/clear/destroy）后重抛
// 真实现的链路（facade/registry/claim 服务）由各自测试覆盖；本文件只测装配序。
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const roleSession = await jiti.import("./role-session.ts");

const WORKSPACE_PATH = "/tmp/ws-role-session";
const TASK = { key: "REQ-0001", title: "示例需求" };
const ITEM_PATH = "/tmp/ws-role-session/.pi/work-items/requirements/REQ-0001-x";
const CONFIG = {
  schemaVersion: 1,
  enabled: true,
  roles: {},
  budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
};

const claimOf = (sessionId) => ({
  attemptId: "att-1",
  generation: 1,
  role: "designer",
  sessionId,
  claimedAt: "2026-10-24T00:00:00Z",
  lastSeenAt: "2026-10-24T00:00:00Z",
  requirementDigest: "d",
  ownerTokenHash: "h",
});

function makeDeps(overrides = {}) {
  const calls = [];
  let destroyCb = null;
  // key → 当前 claim（null = 无）。resolveItem（快路径）与 scanClaims（兜底扫描）
  // 读同一份状态——测试按需摆 claims 即可。
  let claims = {};
  const deps = {
    createSession: async (input) => {
      calls.push(["create", input]);
      return { sessionId: "s-1", cwd: input.cwd, sessionFile: "/tmp/s-1.jsonl", data: null };
    },
    sendCommand: async (_sessionId, command) => {
      calls.push([command.type, command]);
    },
    destroySession: (sessionId) => {
      calls.push(["destroy", sessionId]);
    },
    onSessionDestroy: (sessionId, cb) => {
      destroyCb = cb;
      calls.push(["armEnd", sessionId]);
      return true;
    },
    grantRole: (sessionId, grant) => {
      calls.push(["grant", sessionId, grant]);
    },
    revokeRole: (sessionId) => {
      calls.push(["revoke", sessionId]);
    },
    markActive: (sessionId, info) => {
      calls.push(["mark", sessionId, info]);
    },
    clearActive: (sessionId) => {
      calls.push(["clear", sessionId]);
    },
    resolveItem: async (_workspacePath, key) => ({ path: ITEM_PATH, claim: claims[key] ?? null }),
    scanClaims: async () =>
      Object.entries(claims).map(([key, claim]) => ({ key, claim })),
    heartbeat: async () => true,
    record: async (workspacePath, key, sessionId, reason) => {
      calls.push(["record", workspacePath, key, sessionId, reason]);
    },
    now: () => new Date("2026-10-24T00:00:00Z"),
    ...overrides,
  };
  return { deps, calls, getDestroyCb: () => destroyCb, setClaims: (next) => { claims = next; } };
}

const launch = (deps) =>
  roleSession.launchDesignerSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    task: TASK,
    config: CONFIG,
    deps,
  });

test("launch follows the two-step assembly order: create without command → grant → mark → name → prompt", async () => {
  const { deps, calls } = makeDeps();
  const sessionId = await launch(deps);
  assert.equal(sessionId, "s-1");
  assert.deepEqual(calls.map((c) => c[0]), [
    "create", "grant", "mark", "set_session_name", "armEnd", "prompt",
  ]);
  // 建会话不带 command（sessionId 到手才能 grant/登记/命名）；合同进 appendSystemPrompt
  const createInput = calls[0][1];
  assert.equal(createInput.command, undefined);
  assert.equal(createInput.cwd, WORKSPACE_PATH);
  assert.ok(createInput.appendSystemPrompt.includes("REQ-0001"));
  assert.equal(createInput.model, undefined);
  // 命名：designer · <KEY>（省略代次——generation 此刻未知）
  assert.equal(calls.find((c) => c[0] === "set_session_name")[1].name, "designer · REQ-0001");
  // 开场指令：列出池子 → 领取指派项（唯一目标，不领其他项）→ 工作 → 提交
  const prompt = calls.find((c) => c[0] === "prompt")[1];
  assert.ok(prompt.message.includes("REQ-0001"));
  assert.ok(prompt.message.includes("delivery_list_ready_tasks"));
  assert.ok(prompt.message.includes("delivery_submit_result"));
  // fix-round 1：只领指派项——不得再有「按池内优先级领取其他项」的改领话术
  assert.ok(prompt.message.includes("不要领取其他工作项"));
  assert.ok(!prompt.message.includes("按池内优先级领取"));
  // grant 与 delivery 执行登记的内容
  assert.deepEqual(
    calls.find((c) => c[0] === "grant")[2],
    { role: "designer", workspacePath: WORKSPACE_PATH },
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "mark")[2],
    { workspacePath: WORKSPACE_PATH, itemKey: "REQ-0001" },
  );
});

test("launch passes the configured designer model through to createSession", async () => {
  const { deps, calls } = makeDeps();
  const model = { provider: "zai", modelId: "glm-4.7" };
  await roleSession.launchDesignerSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    task: TASK,
    config: { ...CONFIG, roles: { designer: { model } } },
    deps,
  });
  assert.deepEqual(calls[0][1].model, model);
});

test("end hook records an interruption for an uncleared claim owned by this session", async () => {
  const { deps, calls, getDestroyCb, setClaims } = makeDeps();
  setClaims({ "REQ-0001": claimOf("s-1") });
  await launch(deps);
  await getDestroyCb()();
  const records = calls.filter((c) => c[0] === "record");
  assert.equal(records.length, 1); // 快路径与扫描同名项去重，只记一次
  assert.equal(records[0][1], WORKSPACE_PATH);
  assert.equal(records[0][2], "REQ-0001");
  assert.equal(records[0][3], "s-1");
  assert.equal(records[0][4], "session ended with active claim");
  assert.ok(calls.some((c) => c[0] === "revoke"));
  assert.ok(calls.some((c) => c[0] === "clear"));
});

// fix-round 1：合同限定只领指派项，但若会话违约领取了其他项（历史会话/模型
// 不守约），结束钩子的全活动项扫描兜底必须把那个 claim 也记中断——否则死
// claim 永久卡住该项（重领 409、池子排除、只能手工 fs 手术）。
test("end hook backstop records interruptions for claims on OTHER items held by this session", async () => {
  // 违约领取：launch key 无 claim，另一项 REQ-0002 的 claim 挂在本会话名下
  {
    const { deps, calls, getDestroyCb, setClaims } = makeDeps();
    setClaims({ "REQ-0002": claimOf("s-1") });
    await launch(deps);
    await getDestroyCb()();
    const records = calls.filter((c) => c[0] === "record");
    assert.equal(records.length, 1);
    assert.equal(records[0][2], "REQ-0002");
    assert.equal(records[0][3], "s-1");
    assert.equal(records[0][4], "session ended with active claim");
    assert.ok(calls.some((c) => c[0] === "revoke"));
  }
  // 混合：指派项 + 违约项都挂着本会话的 claim → 两个都记
  {
    const { deps, calls, getDestroyCb, setClaims } = makeDeps();
    setClaims({ "REQ-0001": claimOf("s-1"), "REQ-0002": claimOf("s-1") });
    await launch(deps);
    await getDestroyCb()();
    const keys = calls.filter((c) => c[0] === "record").map((c) => c[2]).sort();
    assert.deepEqual(keys, ["REQ-0001", "REQ-0002"]);
  }
  // 扫描见到的他人 claim 不记（不得清他人的领取）
  {
    const { deps, calls, getDestroyCb, setClaims } = makeDeps();
    setClaims({ "REQ-0002": claimOf("someone-else") });
    await launch(deps);
    await getDestroyCb()();
    assert.equal(calls.some((c) => c[0] === "record"), false);
  }
});

test("end hook is idempotent: cleared claim / foreign claim / double fire record nothing", async () => {
  // claim 已清（submit/fail 之后）——记录不动，revoke/clear 照做
  {
    const { deps, calls, getDestroyCb } = makeDeps();
    await launch(deps);
    await getDestroyCb()();
    await getDestroyCb()(); // 二次触发同样 no-op
    assert.equal(calls.some((c) => c[0] === "record"), false);
    assert.ok(calls.some((c) => c[0] === "revoke"));
    assert.ok(calls.some((c) => c[0] === "clear"));
  }
  // 他人会话的 claim（本会话迟到结束不得记中断、更不得清他人 claim）
  {
    const { deps, calls, getDestroyCb, setClaims } = makeDeps();
    setClaims({ "REQ-0001": claimOf("someone-else") });
    await launch(deps);
    await getDestroyCb()();
    assert.equal(calls.some((c) => c[0] === "record"), false);
  }
});

test("heartbeat interval beats every 20s and is cleared when the session ends", async (t) => {
  const { deps, getDestroyCb } = makeDeps();
  const beats = [];
  deps.heartbeat = async (workspacePath, itemPath, sessionId) => {
    beats.push([workspacePath, itemPath, sessionId]);
    return true;
  };
  // 只 mock setInterval：真实 clearInterval 能清掉 mock 句柄（node mock timers
  // 不支持 clearInterval 作为 mock api，但真实现对 mock 句柄有效——实测）。
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    await launch(deps);
    assert.equal(beats.length, 0);
    t.mock.timers.tick(20_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(beats.length, 1);
    t.mock.timers.tick(20_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(beats.length, 2);
    assert.deepEqual(beats[0], [WORKSPACE_PATH, ITEM_PATH, "s-1"]);
    // 结束钩子清 interval——之后的 tick 不再续约
    await getDestroyCb()();
    t.mock.timers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(beats.length, 2);
  } finally {
    t.mock.timers.reset();
  }
});

test("assembly failure after creation cleans up (revoke/clear/destroy) and rethrows", async () => {
  const { deps, calls } = makeDeps({
    sendCommand: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(() => launch(deps), /boom/);
  assert.ok(calls.some((c) => c[0] === "revoke"));
  assert.ok(calls.some((c) => c[0] === "clear"));
  assert.ok(calls.some((c) => c[0] === "destroy"));
});

test("DESIGNER_CONTRACT carries the task key and the hard rules", () => {
  const contract = roleSession.DESIGNER_CONTRACT(TASK);
  assert.ok(contract.includes("REQ-0001"));
  assert.ok(contract.includes("示例需求"));
  for (const tool of [
    "delivery_list_ready_tasks",
    "delivery_claim_task",
    "delivery_submit_result",
    "delivery_fail_task",
  ]) {
    assert.ok(contract.includes(tool), `contract must mention ${tool}`);
  }
  assert.ok(contract.includes("确认由人"));
  // fix-round 1：合同限定只领指派项，不得有改领话术
  assert.ok(contract.includes("本轮只领取工作项 REQ-0001"));
  assert.ok(contract.includes("不要领取其他工作项"));
  assert.ok(!contract.includes("按池内优先级"));
});
