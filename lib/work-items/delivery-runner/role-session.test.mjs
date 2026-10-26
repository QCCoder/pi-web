// Seam-repositioning Task 2（2026-10-26）：角色会话装配改为「引擎不变式合同 +
// 工作区剧本正文」——四段角色专属合同与只读 model 字段的假 profile 读取器
// 删除；appendSystemPrompt = AGENT_INVARIANT_CONTRACT + readRoleProfile 读到的
// 剧本 body（默认剧本名 = 角色名，config.roles[role].profile 覆写）；开场
// prompt 单一通用四步（四角色仅 role 字样不同）。
// 全假 deps（不起真会话）验证：
//   1. 两步创建序：createSession（不带 command）→ grantRole → markDelivery →
//      set_session_name → prompt（sessionId 到手才能 grant/登记/命名）
//   2. 装配：appendSystemPrompt 以不变式标题开头 + 剧本正文注入；不含过期宪法
//      引用（constraints.md / budget.md 回归守卫）；缺剧本 → warn 不打死后照常开场
//   3. 模型优先级：config.roles[role].model ?? 剧本 frontmatter model ?? 默认
//   4. 结束钩子：未清 claim（sessionId 匹配）→ recordInterruption；已清/他人
//      claim/二次触发 → 幂等 no-op（revoke/clear 照做）；fix-round 1 兜底——
//      全活动项扫描把本会话名下挂在【其他项】上的违约 claim 也记中断
//   5. 心跳 interval：20s 一拍（fake timers），session 结束即清
//   6. 装配失败（建会话之后的步骤抛错）→ 收尾（revoke/clear/destroy）后重抛
// 真实现的链路（facade/registry/claim 服务）由各自测试覆盖；本文件只测装配序。
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const roleSession = await jiti.import("./role-session.ts");
const rolesMod = await jiti.import("./roles.ts");

const WORKSPACE_PATH = "/tmp/ws-role-session";
const TASK = { key: "REQ-0001", title: "示例需求" };
const ITEM_PATH = "/tmp/ws-role-session/.pi/work-items/requirements/REQ-0001-x";
const CONFIG = {
  schemaVersion: 1,
  enabled: true,
  roles: {},
  budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
};

// 不变式标题（launch 断言复用）与 makeDeps 默认注入的假剧本正文
const INVARIANT_TITLE = (role, key) => `# 交付回合不变式（${role} · ${key}）`;
const PROFILE_BODY = "示例剧本正文：本角色按此剧本完成各阶段工作。";

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
  // readProfile 读取记录（workspacePath + 剧本名）；默认返回带正文的假剧本
  const profileReads = [];
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
    readProfile: async (workspacePath, profile) => {
      profileReads.push([workspacePath, profile]);
      return { body: PROFILE_BODY };
    },
    now: () => new Date("2026-10-24T00:00:00Z"),
    ...overrides,
  };
  return {
    deps,
    calls,
    getDestroyCb: () => destroyCb,
    setClaims: (next) => { claims = next; },
    profileReads,
  };
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
  // 建会话不带 command（sessionId 到手才能 grant/登记/命名）；系统提示 =
  // 不变式合同（标题开头）+ 注入的剧本正文
  const createInput = calls[0][1];
  assert.equal(createInput.command, undefined);
  assert.equal(createInput.cwd, WORKSPACE_PATH);
  assert.ok(createInput.appendSystemPrompt.startsWith(INVARIANT_TITLE("designer", "REQ-0001")));
  assert.ok(createInput.appendSystemPrompt.includes(PROFILE_BODY));
  assert.equal(createInput.model, undefined);
  // 命名：designer · <KEY>（省略代次——generation 此刻未知）
  assert.equal(calls.find((c) => c[0] === "set_session_name")[1].name, "designer · REQ-0001");
  // 开场指令：列出池子 → 领取指派项（唯一目标，不领其他项）→ 按剧本工作 → 提交
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
  const { deps, calls, profileReads } = makeDeps();
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
  // 未配 profile → 默认剧本名 = 角色名（.pi/agents/designer.md）
  assert.deepEqual(profileReads, [[WORKSPACE_PATH, "designer"]]);
});

// config 省略 model 时，模型从工作区剧本（.pi/agents/<profile>.md frontmatter 的
// model 字段）解析；剧本正文同时注入 appendSystemPrompt。
test("launch resolves the designer model from the workspace profile when config omits model", async () => {
  const { deps, calls } = makeDeps();
  deps.readProfile = async (workspacePath, profile) => {
    assert.equal(workspacePath, WORKSPACE_PATH);
    assert.equal(profile, "designer-pro");
    return { model: { provider: "zai", modelId: "glm-4.7" }, body: "剧本正文" };
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
  assert.ok(calls[0][1].appendSystemPrompt.includes("剧本正文"));
});

test("explicit config model wins over the profile model", async () => {
  const { deps, calls } = makeDeps();
  const model = { modelId: "glm-4.7" };
  deps.readProfile = async () => ({ model: { provider: "zai", modelId: "glm-9.9" }, body: "剧本正文" });
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

test("profile present but model unresolvable falls back to default silently; reader throw does not kill the launch", async (t) => {
  // 剧本在场而 frontmatter 无 model（默认形态）→ 不带 model 建会话
  {
    const { deps, calls } = makeDeps();
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
  // reader 抛错（意外 fs 故障）→ error 记录当缺场，同样回落默认，不打死整个 launch
  {
    const err = t.mock.method(console, "error", () => {});
    const { deps, calls } = makeDeps();
    deps.readProfile = async () => {
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
    assert.equal(err.mock.calls.length, 1);
    assert.ok(calls.some((c) => c[0] === "prompt")); // 会话照常开场
  }
});

// --------------------------------------- 不变式合同 / 剧本 / 开场（纯函数）

test("AGENT_INVARIANT_CONTRACT：六条全文与测试内嵌期望逐字相等（含 role/key 内插）", () => {
  const expected = `# 交付回合不变式（designer · REQ-0001）

1. 先 delivery_claim_task 成功才动手；本轮只领指派项 REQ-0001，不可领取即说明并结束。
2. 只在 claim 返回的 worktree / 目录内写，其余一律只读；不合并、不推送、不碰受保护分支——集成与发布是引擎与人的事。
3. 本轮以 submit / fail 二者之一结束；结束时不得留进行中的领取。
4. 自述不是证据；检查只经 delivery_run_check 触发。
5. 确认、验收、发布登记没有工具——那是人的手。
6. 项目事实（gate 命令、构建环境、分支纪律）查工作区 AGENTS.md 与你的剧本。`;
  assert.equal(
    roleSession.AGENT_INVARIANT_CONTRACT({ role: "designer", key: "REQ-0001" }),
    expected,
  );
  // role/key 是仅有的内插位：标题与规则 1 随之变化
  const verifier = roleSession.AGENT_INVARIANT_CONTRACT({ role: "verifier", key: "REQ-0009" });
  assert.ok(verifier.startsWith("# 交付回合不变式（verifier · REQ-0009）"));
  assert.ok(verifier.includes("本轮只领指派项 REQ-0009"));
});

test("composeRoleSystemPrompt：有剧本 = 不变式 + 空行 + 正文；无/空白剧本 = 仅不变式（无尾分隔）", () => {
  const ctx = { role: "designer", key: "REQ-0001" };
  const invariant = roleSession.AGENT_INVARIANT_CONTRACT(ctx);
  // 有 body：不变式 + "\n\n" + body
  assert.equal(
    roleSession.composeRoleSystemPrompt(ctx, { body: "剧本正文" }),
    `${invariant}\n\n剧本正文`,
  );
  // 无 profile / body 为空或纯空白：仅不变式，无尾分隔符
  assert.equal(roleSession.composeRoleSystemPrompt(ctx), invariant);
  assert.equal(roleSession.composeRoleSystemPrompt(ctx, { body: "" }), invariant);
  assert.equal(roleSession.composeRoleSystemPrompt(ctx, { body: "   \n  " }), invariant);
});

test("resolveRoleProfileName：缺省剧本名 = 角色名；显式配置优先", () => {
  assert.equal(roleSession.resolveRoleProfileName("developer"), "developer");
  assert.equal(roleSession.resolveRoleProfileName("developer", {}), "developer");
  assert.equal(roleSession.resolveRoleProfileName("developer", { profile: "dev-pro" }), "dev-pro");
});

test("openingPromptFor：单一通用四步（四角色仅 role 字样不同），不含角色专属产物名", () => {
  for (const role of rolesMod.DELIVERY_ROLES) {
    const prompt = roleSession.openingPromptFor(role, TASK);
    assert.ok(prompt.includes(`交付 ${role} 会话`), `${role} 首行点明角色`);
    assert.ok(prompt.includes("REQ-0001"), `${role} 含 KEY`);
    assert.ok(prompt.includes("示例需求"), `${role} 含标题`);
    for (const tool of [
      "delivery_list_ready_tasks",
      "delivery_claim_task",
      "delivery_submit_result",
      "delivery_fail_task",
    ]) {
      assert.ok(prompt.includes(tool), `${role} opening mentions ${tool}`);
    }
    // 四步纪律：只领指派项 + 阻塞 fail(blocked)
    assert.ok(prompt.includes("不要领取其他工作项"));
    assert.ok(prompt.includes("blocked=true"));
    // 通用化：不再点名角色专属产物——上下文由剧本与领取返回承载
    assert.ok(!prompt.includes("design.md"));
    assert.ok(!prompt.includes("release_notes"));
    assert.ok(!prompt.includes("worktree 清单"));
  }
  // 去掉 role 字样后四角色文本完全相同（单一通用文案）
  const stripped = rolesMod.DELIVERY_ROLES.map((role) =>
    roleSession.openingPromptFor(role, TASK).split(role).join("@ROLE@"));
  assert.equal(new Set(stripped).size, 1);
});

test("readRoleProfile：frontmatter model 拆分与 body 截取；缺文件/非法名 → undefined", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws = await mkdtemp(join(tmpdir(), "ws-role-profile-"));
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
    "---\nmodel: glm-4.7\n---\n\nbody of bare.\n",
    "utf8",
  );
  await writeFile(
    join(ws, ".pi", "agents", "no-model.md"),
    "---\ndisplay_name: No Model\n---\n\nbody without model.\n",
    "utf8",
  );
  await writeFile(
    join(ws, ".pi", "agents", "no-frontmatter.md"),
    "Plain script body, no frontmatter.\n",
    "utf8",
  );

  const read = roleSession.readRoleProfile;
  // frontmatter model（provider/model 首个 / 拆分，双非空才成 provider 形）+ body
  assert.deepEqual(await read(ws, "designer-pro"), {
    model: { provider: "zai", modelId: "glm-4.7" },
    body: "You design things.",
  });
  // 裸 modelId 形
  assert.deepEqual(await read(ws, "bare-model"), {
    model: { modelId: "glm-4.7" },
    body: "body of bare.",
  });
  // 文件在但无 model 字段 → 只有 body
  assert.deepEqual(await read(ws, "no-model"), { body: "body without model." });
  // 无 frontmatter → body = 全文 trim
  assert.deepEqual(await read(ws, "no-frontmatter"), { body: "Plain script body, no frontmatter." });
  // 文件缺失 → undefined（静默，非异常）
  assert.equal(await read(ws, "ghost"), undefined);
  // 非法 profile 名（路径穿越形态）→ undefined，不触盘外路径
  assert.equal(await read(ws, "../escape"), undefined);
  assert.equal(await read(ws, ".."), undefined);
  // 名字前后空白宽容（与 subagents assertProfileName 的 trim 语义一致）
  assert.deepEqual(await read(ws, " designer-pro "), {
    model: { provider: "zai", modelId: "glm-4.7" },
    body: "You design things.",
  });
});

// Seam-repositioning Task 4（2026-10-26，controller 授权的纯增量）：frontmatter
// seeded_from（Task 3 模板播种标记，spec §13.3 漂移提示依据）透出为
// seededFrom——role-preview.ts 复用同一读取器，不二次读盘。缺席/空串 → 键省略。
test("readRoleProfile：frontmatter seeded_from → seededFrom（缺/空 → 键省略）", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws = await mkdtemp(join(tmpdir(), "ws-role-seeded-"));
  t.after(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  await mkdir(join(ws, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(ws, ".pi", "agents", "seeded.md"),
    '---\nseeded_from: "designer@1"\n---\n\nbody.\n',
    "utf8",
  );
  await writeFile(
    join(ws, ".pi", "agents", "empty-seeded.md"),
    "---\nseeded_from: \"\"\n---\n\nbody.\n",
    "utf8",
  );
  const read = roleSession.readRoleProfile;
  assert.deepEqual(await read(ws, "seeded"), { seededFrom: "designer@1", body: "body." });
  assert.deepEqual(await read(ws, "empty-seeded"), { body: "body." });
});

test("appendSystemPrompt 装配：不变式标题 + 剧本正文；无过期宪法引用；缺剧本 warn 不抛", async (t) => {
  // 过期宪法引用回归守卫：旧 designer 合同点名 .pi/loop/constraints.md /
  // budget.md——不变式不得再引用（宪法文件归 loop 层管，与交付回合无关）
  {
    const { deps, calls } = makeDeps();
    await launch(deps);
    const systemPrompt = calls[0][1].appendSystemPrompt;
    assert.ok(systemPrompt.startsWith(INVARIANT_TITLE("designer", "REQ-0001")));
    assert.ok(systemPrompt.includes(PROFILE_BODY));
    assert.ok(!systemPrompt.includes("constraints.md"));
    assert.ok(!systemPrompt.includes("budget.md"));
  }
  // 缺剧本（readProfile → undefined）：warn 一条 + 仅不变式（无尾分隔），照常开场
  {
    const warn = t.mock.method(console, "warn", () => {});
    const { deps, calls } = makeDeps({ readProfile: async () => undefined });
    const sessionId = await launch(deps);
    assert.equal(sessionId, "s-1");
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(
      warn.mock.calls[0].arguments[0],
      "[delivery-runner] designer has no profile at .pi/agents/designer.md; running with invariant contract only",
    );
    assert.equal(
      calls[0][1].appendSystemPrompt,
      roleSession.AGENT_INVARIANT_CONTRACT({ role: "designer", key: "REQ-0001" }),
    );
    assert.ok(calls.some((c) => c[0] === "prompt")); // 照常开场
  }
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

// fix-round 1：不变式限定只领指派项，但若会话违约领取了其他项（历史会话/模型
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

// ------------------------------------------------- developer 角色

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

test("launchRoleSession(developer)：命名 developer · KEY、grant role、不变式装配与通用开场 prompt", async () => {
  const { deps, calls } = makeDeps();
  const sessionId = await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "developer",
    task: TASK,
    // claim 仅占位（装配不消费——worktree 上下文由领取返回承载，不进系统提示）
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
  // 装配 = 不变式 + 剧本正文（角色差异在剧本，不在引擎文本）；claim.worktrees
  // 不再进系统提示
  const createInput = calls[0][1];
  assert.equal(createInput.cwd, WORKSPACE_PATH);
  assert.ok(createInput.appendSystemPrompt.startsWith(INVARIANT_TITLE("developer", "REQ-0001")));
  assert.ok(createInput.appendSystemPrompt.includes(PROFILE_BODY));
  assert.ok(!createInput.appendSystemPrompt.includes(WORKTREES[0].path));
  // 开场指令：通用四步（领取指派项 → 按剧本工作 → submit/fail 结束）
  const prompt = calls.find((c) => c[0] === "prompt")[1];
  assert.ok(prompt.message.includes("developer"));
  assert.ok(prompt.message.includes("REQ-0001"));
  assert.ok(prompt.message.includes("不要领取其他工作项"));
  assert.ok(prompt.message.includes("delivery_submit_result"));
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

test("launchRoleSession(developer)：config roles.developer 的 model/profile 解析按 role 取", async () => {
  // config.roles[role] 按 role 取：designer 配置不被 developer 消费（剧本读
  // developer 自己的 profile 名，designer 的 model 不透传）
  {
    const { deps, calls, profileReads } = makeDeps();
    await roleSession.launchRoleSession({
      workspaceId: "ws-1",
      workspacePath: WORKSPACE_PATH,
      role: "developer",
      task: TASK,
      claim: {},
      config: { ...CONFIG, roles: { designer: { model: { modelId: "glm-4.7" } }, developer: { profile: "dev-pro" } } },
      deps,
    });
    assert.equal(calls[0][1].model, undefined, "developer launch ignores roles.designer.model");
    assert.deepEqual(profileReads, [[WORKSPACE_PATH, "dev-pro"]]);
  }
  // developer 的显式 model 透传
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

// ------------------------------------------------- verifier 角色

test("launchRoleSession(verifier)：命名 verifier · KEY、grant role、不变式装配与通用开场 prompt", async () => {
  const { deps, calls } = makeDeps();
  const sessionId = await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "verifier",
    task: TASK,
    claim: {},
    config: CONFIG,
    deps,
  });
  assert.equal(sessionId, "s-1");
  assert.deepEqual(calls.map((c) => c[0]), [
    "create", "grant", "mark", "set_session_name", "armEnd", "prompt",
  ]);
  // 命名：verifier · <KEY>
  assert.equal(
    calls.find((c) => c[0] === "set_session_name")[1].name,
    "verifier · REQ-0001",
  );
  // grant role = verifier
  assert.deepEqual(
    calls.find((c) => c[0] === "grant")[2],
    { role: "verifier", workspacePath: WORKSPACE_PATH },
  );
  // 装配 = 不变式 + 剧本正文；不变式规则 4 自带 delivery_run_check 证据纪律
  const createInput = calls[0][1];
  assert.equal(createInput.cwd, WORKSPACE_PATH);
  assert.ok(createInput.appendSystemPrompt.startsWith(INVARIANT_TITLE("verifier", "REQ-0001")));
  assert.ok(createInput.appendSystemPrompt.includes("delivery_run_check"));
  assert.ok(createInput.appendSystemPrompt.includes(PROFILE_BODY));
  // 开场指令：通用四步
  const prompt = calls.find((c) => c[0] === "prompt")[1];
  assert.ok(prompt.message.includes("verifier"));
  assert.ok(prompt.message.includes("REQ-0001"));
  assert.ok(prompt.message.includes("不要领取其他工作项"));
  assert.ok(prompt.message.includes("delivery_submit_result"));
});

test("launchRoleSession(verifier)：roles 配置按 role 取（designer 配置不被 verifier 消费）", async () => {
  const { deps, calls, profileReads } = makeDeps();
  await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "verifier",
    task: TASK,
    claim: {},
    // config.roles 无 verifier 键——默认剧本名 = 角色名，designer 的 model 不被消费
    config: { ...CONFIG, roles: { designer: { model: { modelId: "glm-4.7" } } } },
    deps,
  });
  assert.equal(calls[0][1].model, undefined, "verifier launch ignores roles.designer.model");
  assert.deepEqual(profileReads, [[WORKSPACE_PATH, "verifier"]]);
});

// ------------------------------------------ release-preparer 角色

test("launchRoleSession(release-preparer)：命名 release-preparer · KEY、grant role、不变式装配与通用开场 prompt", async () => {
  const { deps, calls } = makeDeps();
  const sessionId = await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "release-preparer",
    task: TASK,
    claim: {},
    config: CONFIG,
    deps,
  });
  assert.equal(sessionId, "s-1");
  assert.deepEqual(calls.map((c) => c[0]), [
    "create", "grant", "mark", "set_session_name", "armEnd", "prompt",
  ]);
  // 命名：release-preparer · <KEY>（`${role} · ${task.key}` 泛化自动覆盖——验证）
  assert.equal(
    calls.find((c) => c[0] === "set_session_name")[1].name,
    "release-preparer · REQ-0001",
  );
  // grant role = release-preparer
  assert.deepEqual(
    calls.find((c) => c[0] === "grant")[2],
    { role: "release-preparer", workspacePath: WORKSPACE_PATH },
  );
  // 装配 = 不变式 + 剧本正文
  const createInput = calls[0][1];
  assert.equal(createInput.cwd, WORKSPACE_PATH);
  assert.ok(createInput.appendSystemPrompt.startsWith(INVARIANT_TITLE("release-preparer", "REQ-0001")));
  assert.ok(createInput.appendSystemPrompt.includes(PROFILE_BODY));
  // 开场指令：通用四步
  const prompt = calls.find((c) => c[0] === "prompt")[1];
  assert.ok(prompt.message.includes("release-preparer"));
  assert.ok(prompt.message.includes("REQ-0001"));
  assert.ok(prompt.message.includes("不要领取其他工作项"));
  assert.ok(prompt.message.includes("delivery_submit_result"));
});

test("launchRoleSession(release-preparer)：roles 配置按 role 取（designer 配置不被 release-preparer 消费；无配置键 → 默认模型）", async () => {
  const { deps, calls, profileReads } = makeDeps();
  await roleSession.launchRoleSession({
    workspaceId: "ws-1",
    workspacePath: WORKSPACE_PATH,
    role: "release-preparer",
    task: TASK,
    claim: {},
    // 纯文档角色无配置键——默认剧本名 = 角色名，designer 的 model 不被消费。
    config: { ...CONFIG, roles: { designer: { model: { modelId: "glm-4.7" } } } },
    deps,
  });
  assert.equal(calls[0][1].model, undefined, "release-preparer launch ignores roles.designer.model");
  assert.deepEqual(profileReads, [[WORKSPACE_PATH, "release-preparer"]]);
});
