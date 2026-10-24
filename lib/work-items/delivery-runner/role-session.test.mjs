// Phase-2 Task 6: designer 会话装配（role-session.ts）。
// Phase-3 Task 4: 泛化 launchRoleSession/buildRoleContract 双角色——designer
// 路径经泛化入口零变化复测（既有断言原样保留），developer 新增：合同（worktree
// 清单 + 不合并不推送 + 验证由人）、命名 developer · KEY、grant role。
// 全假 deps（不起真会话）验证：
//   1. 两步创建序：createSession（不带 command）→ grantRole → markDelivery →
//      set_session_name → prompt（sessionId 到手才能 grant/登记/命名）
//   2. config.roles[role].model 透传建会话 input.model；model 缺省而 profile
//      在场时从工作区 profile 解析模型（final review fix——profile 曾是 inert 字段）
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
  roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "designer",
    task: TASK,
    claim: {},
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
  await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "designer",
    task: TASK,
    claim: {},
    config: { ...CONFIG, roles: { designer: { model } } },
    deps,
  });
  assert.deepEqual(calls[0][1].model, model);
});

// final review fix：config 省略 model 而配置了 profile 时，模型从工作区 subagent
// profile（.pi/agents/<profile>.md frontmatter 的 model 字段）解析——此前 profile
// 字段被持久化、UI  advertised，却无任何消费方（inert input）。
test("launch resolves the designer model from the workspace profile when config omits model", async () => {
  const { deps, calls } = makeDeps();
  deps.readProfileModel = async (workspacePath, profile) => {
    assert.equal(workspacePath, WORKSPACE_PATH);
    assert.equal(profile, "designer-pro");
    return { provider: "zai", modelId: "glm-4.7" };
  };
  await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "designer",
    task: TASK,
    claim: {},
    config: { ...CONFIG, roles: { designer: { profile: "designer-pro" } } },
    deps,
  });
  assert.deepEqual(calls[0][1].model, { provider: "zai", modelId: "glm-4.7" });
});

test("explicit config model wins over the profile resolution (reader not called)", async () => {
  const { deps, calls } = makeDeps();
  const model = { modelId: "glm-4.7" };
  deps.readProfileModel = async () => {
    throw new Error("must not be called when config model is present");
  };
  await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "designer",
    task: TASK,
    claim: {},
    config: { ...CONFIG, roles: { designer: { profile: "designer-pro", model } } },
    deps,
  });
  assert.deepEqual(calls[0][1].model, model);
});

test("profile set but model unresolvable (missing file / no model field) falls back to default silently", async () => {
  // reader 返回 undefined（缺文件 / 无 model 字段的默认形态）→ 不带 model 建会话
  {
    const { deps, calls } = makeDeps();
    deps.readProfileModel = async () => undefined;
    await roleSession.launchRoleSession({
      workspaceId: "ws-1",
      workspacePath: WORKSPACE_PATH,
      role: "designer",
      task: TASK,
      claim: {},
      config: { ...CONFIG, roles: { designer: { profile: "designer-pro" } } },
      deps,
    });
    assert.equal(calls[0][1].model, undefined);
  }
  // reader 抛错（意外 fs 故障）→ 同样回落默认，不打死整个 launch
  {
    const { deps, calls } = makeDeps();
    deps.readProfileModel = async () => {
      throw new Error("fs boom");
    };
    const sessionId = await roleSession.launchRoleSession({
      workspaceId: "ws-1",
      workspacePath: WORKSPACE_PATH,
      role: "designer",
      task: TASK,
      claim: {},
      config: { ...CONFIG, roles: { designer: { profile: "designer-pro" } } },
      deps,
    });
    assert.equal(sessionId, "s-1");
    assert.equal(calls[0][1].model, undefined);
    assert.ok(calls.some((c) => c[0] === "prompt")); // 会话照常开场
  }
});

test("default readProfileModel parses .pi/agents/<profile>.md frontmatter model field", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws = await mkdtemp(join(tmpdir(), "ws-profile-model-"));
  t.after(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  await mkdir(join(ws, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(ws, ".pi", "agents", "designer-pro.md"),
    "---\ndisplay_name: Designer Pro\nmodel: zai/glm-4.7\n---\n\nYou design things.\n",
    "utf8",
  );
  await writeFile(
    join(ws, ".pi", "agents", "bare-model.md"),
    "---\nmodel: glm-4.7\n---\n\nbody\n",
    "utf8",
  );
  await writeFile(
    join(ws, ".pi", "agents", "no-model.md"),
    "---\ndisplay_name: No Model\n---\n\nbody\n",
    "utf8",
  );

  const read = roleSession.readDesignerProfileModel;
  // provider/model 拆分（首个 / 分隔，双非空才成 provider 形）
  assert.deepEqual(await read(ws, "designer-pro"), { provider: "zai", modelId: "glm-4.7" });
  // 裸 modelId 形
  assert.deepEqual(await read(ws, "bare-model"), { modelId: "glm-4.7" });
  // 文件存在但无 model 字段 → undefined
  assert.equal(await read(ws, "no-model"), undefined);
  // 文件缺失 → undefined（静默，非异常）
  assert.equal(await read(ws, "ghost"), undefined);
  // 非法 profile 名（路径穿越形态）→ undefined，不触盘外路径
  assert.equal(await read(ws, "../escape"), undefined);
  assert.equal(await read(ws, ".."), undefined);
  // 名字前后空白宽容（与 subagents assertProfileName 的 trim 语义一致）
  assert.deepEqual(await read(ws, " designer-pro "), { provider: "zai", modelId: "glm-4.7" });
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

// ------------------------------------------------- Phase-3 Task 4: developer

const WORKTREES = [
  {
    repositoryId: "repo-a",
    repoPath: `${WORKSPACE_PATH}/repo-a`,
    path: `${WORKSPACE_PATH}/repo-a-worktrees/pi-delivery__REQ-0001__gen1`,
    branch: "pi-delivery/REQ-0001/gen1",
  },
  {
    repositoryId: "repo-b",
    repoPath: `${WORKSPACE_PATH}/repo-b`,
    path: `${WORKSPACE_PATH}/repo-b-worktrees/pi-delivery__REQ-0001__gen1`,
    branch: "pi-delivery/REQ-0001/gen1",
  },
];

test("buildRoleContract(designer) 与 DESIGNER_CONTRACT 逐字节一致（零变化承诺）", () => {
  assert.equal(
    roleSession.buildRoleContract("designer", TASK),
    roleSession.DESIGNER_CONTRACT(TASK),
  );
});

test("buildRoleContract(developer, claim.worktrees)：逐项列出 worktree path+branch 与硬规则", () => {
  const contract = roleSession.buildRoleContract("developer", TASK, { worktrees: WORKTREES });
  assert.ok(contract.includes("REQ-0001"));
  assert.ok(contract.includes("示例需求"));
  // worktree 清单：每仓 path + branch 逐项在场
  for (const worktree of WORKTREES) {
    assert.ok(contract.includes(worktree.path), `contract lists ${worktree.path}`);
    assert.ok(contract.includes(worktree.branch), `contract lists ${worktree.branch}`);
    assert.ok(contract.includes(worktree.repositoryId), `contract names ${worktree.repositoryId}`);
  }
  // 主区只读 / 不合并不推送（合并由人）/ 候选提交 / 验证由人 / 阻塞 fail(blocked)
  assert.ok(contract.includes("主工作区"));
  assert.ok(contract.includes("只读"));
  assert.ok(contract.includes("不合并不推送"));
  assert.ok(contract.includes("合并"));
  assert.ok(contract.includes("由人"));
  assert.ok(contract.includes("candidates"));
  assert.ok(contract.includes("notes"));
  assert.ok(contract.includes("验证结论由人"));
  assert.ok(contract.includes("blocked=true"));
  // 限定只领指派项（与 designer 合同同款纪律）
  assert.ok(contract.includes("本轮只领取工作项 REQ-0001"));
  assert.ok(contract.includes("不要领取其他工作项"));
  for (const tool of [
    "delivery_list_ready_tasks",
    "delivery_claim_task",
    "delivery_submit_result",
    "delivery_fail_task",
  ]) {
    assert.ok(contract.includes(tool), `developer contract must mention ${tool}`);
  }
  // 不带 designer 专属的「设计与验收条件写好后……」措辞（角色合同不得串台）
  assert.ok(!contract.includes("designer 角色合同"));
});

test("buildRoleContract(developer) 无 claim（launch 时领取未发生）：清单以领取返回为准", () => {
  const contract = roleSession.buildRoleContract("developer", TASK);
  assert.ok(contract.includes("主工作区"));
  assert.ok(contract.includes("只读"));
  assert.ok(contract.includes("delivery_claim_task"));
  // worktree 尚未预建——合同指向领取返回的清单，而不是空白或报错
  assert.match(contract, /delivery_claim_task 返回/);
});

test("launchRoleSession(developer)：命名 developer · KEY、grant role、合同与开场 prompt", async () => {
  const { deps, calls } = makeDeps();
  const sessionId = await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "developer",
    task: TASK,
    claim: { worktrees: WORKTREES },
    config: CONFIG,
    deps,
  });
  assert.equal(sessionId, "s-1");
  assert.deepEqual(calls.map((c) => c[0]), [
    "create", "grant", "mark", "set_session_name", "armEnd", "prompt",
  ]);
  // 命名：developer · <KEY>
  assert.equal(
    calls.find((c) => c[0] === "set_session_name")[1].name,
    "developer · REQ-0001",
  );
  // grant role = developer
  assert.deepEqual(
    calls.find((c) => c[0] === "grant")[2],
    { role: "developer", workspacePath: WORKSPACE_PATH },
  );
  // 合同随 claim.worktrees 注入 appendSystemPrompt（逐项 path+branch）
  const createInput = calls[0][1];
  assert.equal(createInput.cwd, WORKSPACE_PATH);
  assert.ok(createInput.appendSystemPrompt.includes(WORKTREES[0].path));
  assert.ok(createInput.appendSystemPrompt.includes(WORKTREES[0].branch));
  assert.ok(createInput.appendSystemPrompt.includes("不合并不推送"));
  // 开场指令：领取指派项 → worktree 实现 → candidates 提交
  const prompt = calls.find((c) => c[0] === "prompt")[1];
  assert.ok(prompt.message.includes("developer"));
  assert.ok(prompt.message.includes("REQ-0001"));
  assert.ok(prompt.message.includes("不要领取其他工作项"));
  assert.ok(prompt.message.includes("worktree"));
  assert.ok(prompt.message.includes("candidates"));
});

test("launchRoleSession(developer)：结束钩子/心跳/登记 role 无关（与 designer 同一链路）", async () => {
  const { deps, calls, getDestroyCb, setClaims } = makeDeps();
  setClaims({
    "REQ-0001": { ...claimOf("s-1"), role: "developer" },
  });
  await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "developer",
    task: TASK,
    claim: {},
    config: CONFIG,
    deps,
  });
  // 结束钩子对 developer claim 同样记中断 + revoke/clear
  await getDestroyCb()();
  const records = calls.filter((c) => c[0] === "record");
  assert.equal(records.length, 1);
  assert.equal(records[0][2], "REQ-0001");
  assert.ok(calls.some((c) => c[0] === "revoke"));
  assert.ok(calls.some((c) => c[0] === "clear"));
});

test("launchRoleSession(developer)：config roles.developer 的 model/profile 解析（T5 落配置解析前的消费面）", async () => {
  // config.roles[role] 按 role 取：designer 配置不再被 developer 消费
  {
    const { deps, calls } = makeDeps();
    deps.readProfileModel = async () => {
      throw new Error("must not read the designer profile for a developer launch");
    };
    await roleSession.launchRoleSession({
      workspaceId: "ws-1",
      workspacePath: WORKSPACE_PATH,
      role: "developer",
      task: TASK,
      claim: {},
      // roles 形状 T5 落显式双字段；测试直书 developer 键验证消费侧按 role 取
      config: { ...CONFIG, roles: { designer: { model: { modelId: "glm-4.7" } }, developer: { profile: "dev-pro" } } },
      deps,
    });
    assert.equal(calls[0][1].model, undefined, "developer launch ignores roles.designer.model");
  }
  // developer 的显式 model 透传（T5 配置解析落地后即生效）
  {
    const { deps, calls } = makeDeps();
    const model = { provider: "zai", modelId: "glm-4.7" };
    await roleSession.launchRoleSession({
      workspaceId: "ws-1",
      workspacePath: WORKSPACE_PATH,
      role: "developer",
      task: TASK,
      claim: {},
      config: { ...CONFIG, roles: { developer: { model } } },
      deps,
    });
    assert.deepEqual(calls[0][1].model, model);
  }
});
