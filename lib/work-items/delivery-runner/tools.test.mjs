// Phase-2 Task 5: 角色授权登记（role-grants.ts）+ 领取工具（tools.ts）。
// 三层测试：
//   1. role-grants 单测——grant/revoke/roleGrantOf/setGrantToken/
//      hasAnyActiveExecution + globalThis 单例跨模块实例幂等（jiti/HMR 双载
//      模拟：query-string 强制第二个模块实例，map 必须经 globalThis 共享）。
//   2. tools source 断言——四工具名齐备；不注册 confirm/record-release/
//      block/unblock/cancel 等人工动作工具（工具面只有 领取侧）；凭证
//      （owner_token/attempt_id）绝不出现在参数 schema；身份门文案与 T4
//      carried ruling 的 submit 冲突释放引导在场。
//   3. 行为断言（假 ExtensionAPI 捕获 registerTool，直接调 execute）——
//      无 grant / grant 属他工作区 → 全部工具 400 文本（不抛异常）；
//      有 grant 无领取凭证 → submit/fail 引导先领取。
//   4. extensions.ts 挂载断言——delivery 工具需要 work-items ∧ workflows。
// Phase-3 Task 4：双角色分派——grant.role=developer 时 claim/submit/fail 走
// developer 服务（真 developer 工作区行为断言），submit 联合形状按 role 校验
// （错形状 → validation 文本），list 描述双角色 + blocked 条目带 role。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  grantRole,
  hasAnyActiveExecution,
  revokeRole,
  roleGrantOf,
  setGrantToken,
} from "./role-grants.ts";

// ------------------------------------------------------------- role-grants

test("role-grants: grant / roleGrantOf / revoke round trip", () => {
  const sessionId = "rg-roundtrip";
  assert.equal(roleGrantOf(sessionId), null, "unknown session has no grant");
  grantRole(sessionId, { role: "designer", workspacePath: "/ws/a" });
  const grant = roleGrantOf(sessionId);
  assert.ok(grant, "grant is readable after grantRole");
  assert.equal(grant.role, "designer");
  assert.equal(grant.workspacePath, "/ws/a");
  assert.equal(grant.attemptId, undefined, "bare grant carries no credentials");
  revokeRole(sessionId);
  assert.equal(roleGrantOf(sessionId), null, "revoke removes the grant");
});

// Phase-3 T4：RoleGrant.role 放宽为 DeliveryRole——developer 授权全链路（grant/
// setGrantToken/hasAnyActiveExecution）与 designer 同一登记簿。
test("role-grants: developer role grants share the same registry and slot semantics", () => {
  const sessionId = "rg-developer";
  grantRole(sessionId, { role: "developer", workspacePath: "/ws/dev" });
  const grant = roleGrantOf(sessionId);
  assert.ok(grant);
  assert.equal(grant.role, "developer");
  setGrantToken(sessionId, "attempt-dev", "token-dev", 2);
  assert.equal(roleGrantOf(sessionId).attemptId, "attempt-dev");
  assert.equal(roleGrantOf(sessionId).role, "developer", "role survives the token patch");
  // 跨角色单槽位：developer 授权同样占槽
  assert.equal(hasAnyActiveExecution("/ws/dev"), true);
  revokeRole(sessionId);
  assert.equal(hasAnyActiveExecution("/ws/dev"), false);
});

test("role-grants: setGrantToken patches claim credentials onto the existing grant", () => {
  const sessionId = "rg-token";
  grantRole(sessionId, { role: "designer", workspacePath: "/ws/a" });
  setGrantToken(sessionId, "attempt-1", "token-1", 3);
  const grant = roleGrantOf(sessionId);
  assert.ok(grant);
  assert.equal(grant.attemptId, "attempt-1");
  assert.equal(grant.ownerToken, "token-1");
  assert.equal(grant.generation, 3, "generation is kept for submit/fail service calls");
  assert.equal(grant.role, "designer", "role survives the patch");
  // 再领取（新代）覆盖旧凭证——同会话只持有一份活动凭证。
  setGrantToken(sessionId, "attempt-2", "token-2", 4);
  assert.equal(roleGrantOf(sessionId).attemptId, "attempt-2");
  assert.equal(roleGrantOf(sessionId).ownerToken, "token-2");
  revokeRole(sessionId);
});

test("role-grants: setGrantToken without a grant is a no-op (identity gate owns creation)", () => {
  const sessionId = "rg-noop";
  setGrantToken(sessionId, "attempt-x", "token-x", 1);
  assert.equal(roleGrantOf(sessionId), null);
});

test("role-grants: hasAnyActiveExecution is workspace-scoped and grant-driven", () => {
  assert.equal(hasAnyActiveExecution("/ws/slot"), false, "no grant → no active execution");
  // 裸角色授权即占槽：授予到领取之间的窗口不允许第二个 dispatcher 起会话。
  grantRole("rg-slot-1", { role: "designer", workspacePath: "/ws/slot" });
  assert.equal(hasAnyActiveExecution("/ws/slot"), true, "bare grant occupies the slot");
  assert.equal(hasAnyActiveExecution("/ws/other"), false, "other workspace unaffected");
  setGrantToken("rg-slot-1", "attempt-1", "token-1", 1);
  assert.equal(hasAnyActiveExecution("/ws/slot"), true, "claimed grant still occupies");
  revokeRole("rg-slot-1");
  assert.equal(hasAnyActiveExecution("/ws/slot"), false, "revoke frees the slot");
});

test("role-grants: registry is a globalThis singleton across module loads (jiti/HMR parity)", async () => {
  const sessionId = "rg-reload";
  grantRole(sessionId, { role: "designer", workspacePath: "/ws/a" });
  // query-string 强制第二个模块实例：模块级 Map 会分裂，globalThis 守卫不会。
  const reloaded = await import(new URL("./role-grants.ts?instance=2", import.meta.url).href);
  const grant = reloaded.roleGrantOf(sessionId);
  assert.ok(grant, "second module instance sees the same registry");
  assert.equal(grant.workspacePath, "/ws/a");
  reloaded.revokeRole(sessionId);
  assert.equal(roleGrantOf(sessionId), null, "revoke via the second instance is visible here");
});

// ---------------------------------------------------------- tools: source

async function readToolsSource() {
  return readFile(new URL("./tools.ts", import.meta.url), "utf8");
}

// Phase-4 Task 4：工具族从四扩五——delivery_run_check（verifier 专属的服务端
// 检查执行器）加入；工具面门禁同步更新为恰五件。
test("tools: registers exactly the five claim-side delivery tools", async () => {
  const src = await readToolsSource();
  assert.match(src, /delivery_list_ready_tasks/);
  assert.match(src, /delivery_claim_task/);
  assert.match(src, /delivery_submit_result/);
  assert.match(src, /delivery_fail_task/);
  assert.match(src, /delivery_run_check/);
});

test("tools: no human action tools are registered (confirm / record-release / block / unblock / cancel …)", async () => {
  const src = await readToolsSource();
  // 工具面只有领取侧：任何非五工具名的 delivery_* 注册都不允许。
  const registered = [...src.matchAll(/name:\s*"(delivery_[a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    registered.sort(),
    [
      "delivery_claim_task",
      "delivery_fail_task",
      "delivery_list_ready_tasks",
      "delivery_run_check",
      "delivery_submit_result",
    ],
    "only the five claim-side tools may be registered",
  );
});

test("tools: owner token and attempt id never appear in tool parameters", async () => {
  const src = await readToolsSource();
  assert.doesNotMatch(src, /owner_token/, "ownerToken must never be a tool parameter");
  assert.doesNotMatch(src, /attempt_id/, "attemptId comes from the in-process grant, not params");
});

test("tools: identity gate text is present for non-role sessions", async () => {
  const src = await readToolsSource();
  assert.match(src, /非角色执行会话/);
});

test("tools: submit conflict carries the release-via-fail guidance (T4 carried ruling)", async () => {
  const src = await readToolsSource();
  assert.match(src, /请调用 delivery_fail_task 释放本次领取/);
});

// Phase-3 smoke finding（2026-10-24 controller ruling，binding）：T4 曾把 submit
// 参数改为 Type.Union（designer 形 | developer 形）——该 pi SDK 版本对 anyOf
// 工具参数的调用侧解析不工作（真 LLM 会话十次调用参数全落 {}，schema 校验
// 全拒）。回退为扁平可选字段组；本断言钉死 union/anyOf 永不回潮。
test("tools: submit parameters must never use Type.Union / anyOf (SDK anyOf decoding is broken)", async () => {
  const src = await readToolsSource();
  assert.doesNotMatch(src, /Type\.Union/, "union tool params decode to {} in real LLM sessions");
  assert.doesNotMatch(src, /anyOf/, "anyOf tool params decode to {} in real LLM sessions");
});

// 扁平形状钉子：单个 Type.Object——key 必填，两组角色字段全可选，形状权威
// 在服务端按 grant.role 校验（execute 内 raw 取参直接读可选字段）。
test("tools: submit parameters are ONE flat object — key required, role fields optional", async () => {
  const { createDeliveryRunnerExtension } = await import("./tools.ts");
  const tools = [];
  createDeliveryRunnerExtension("ws-id-flat", "/ws/mine").factory({
    registerTool: (tool) => tools.push(tool),
  });
  const submit = tools.find((t) => t.name === "delivery_submit_result");
  assert.ok(submit, "submit tool is registered");
  const schema = submit.parameters;
  assert.equal(schema.anyOf, undefined, "no anyOf at the schema root");
  assert.equal(schema.oneOf, undefined, "no oneOf at the schema root");
  assert.equal(schema.type, "object", "parameters are a single object schema");
  assert.deepEqual(schema.required, ["key"], "only key is required");
  // 五个属性齐备；key 之外全部 optional（typebox 1.x 以 ~optional 标记）
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ["acceptance_criteria", "candidates", "design_markdown", "key", "notes"],
  );
  for (const field of ["acceptance_criteria", "candidates", "design_markdown", "notes"]) {
    assert.equal(schema.properties[field]["~optional"], true, `${field} is optional`);
  }
  assert.equal(schema.properties.key["~optional"], undefined, "key is required");
  assert.equal(schema.properties.acceptance_criteria.type, "array");
  assert.equal(schema.properties.candidates.type, "array");
  assert.equal(
    schema.properties.candidates.items.type,
    "object",
    "candidates entries are {repositoryId, commit} objects",
  );
  assert.deepEqual(
    Object.keys(schema.properties.candidates.items.properties).sort(),
    ["commit", "repositoryId"],
  );
});

// ------------------------------------------------------- tools: behavior
// 假 ExtensionAPI：捕获 registerTool，直接调 execute（identity 走
// ctx.sessionManager.getSessionId()，与 work-items extension 同款）。

function ctxFor(sessionId) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

async function runTool(tool, sessionId, params = {}) {
  const result = await tool.execute(`call-${sessionId}`, params, undefined, undefined, ctxFor(sessionId));
  return JSON.parse(result.content[0].text);
}

test("tools: every tool returns 400-style text (not a throw) for a session without a grant", async () => {
  const { createDeliveryRunnerExtension } = await import("./tools.ts");
  const tools = [];
  createDeliveryRunnerExtension("ws-id-1", "/ws/mine").factory({
    registerTool: (tool) => tools.push(tool),
  });
  assert.equal(tools.length, 5);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const cases = [
    ["delivery_list_ready_tasks", {}],
    ["delivery_claim_task", { key: "REQ-0001" }],
    ["delivery_submit_result", {
      key: "REQ-0001",
      design_markdown: "# 设计\n…",
      acceptance_criteria: ["登录成功"],
    }],
    ["delivery_fail_task", { key: "REQ-0001", reason: "做不了" }],
    ["delivery_run_check", { name: "build" }],
  ];
  for (const [name, params] of cases) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is registered`);
    const payload = await runTool(tool, "nogrants-session", params);
    assert.equal(payload.ok, false, `${name} rejects without a grant`);
    assert.match(payload.message, /非角色执行会话/, `${name} carries the identity-gate text`);
  }
});

test("tools: identity gate rejects a grant bound to another workspace", async () => {
  const { createDeliveryRunnerExtension } = await import("./tools.ts");
  const tools = [];
  createDeliveryRunnerExtension("ws-id-2", "/ws/mine").factory({
    registerTool: (tool) => tools.push(tool),
  });
  const claim = tools.find((t) => t.name === "delivery_claim_task");
  grantRole("cross-ws-session", { role: "designer", workspacePath: "/ws/other" });
  try {
    const payload = await runTool(claim, "cross-ws-session", { key: "REQ-0001" });
    assert.equal(payload.ok, false);
    assert.match(payload.message, /非角色执行会话/);
  } finally {
    revokeRole("cross-ws-session");
  }
});

test("tools: submit/fail without claim credentials guide the agent to claim first", async () => {
  const { createDeliveryRunnerExtension } = await import("./tools.ts");
  const tools = [];
  createDeliveryRunnerExtension("ws-id-3", "/ws/mine").factory({
    registerTool: (tool) => tools.push(tool),
  });
  grantRole("bare-session", { role: "designer", workspacePath: "/ws/mine" });
  try {
    const submit = tools.find((t) => t.name === "delivery_submit_result");
    const submitted = await runTool(submit, "bare-session", {
      key: "REQ-0001",
      design_markdown: "# 设计",
      acceptance_criteria: ["c1"],
    });
    assert.equal(submitted.ok, false);
    assert.match(submitted.message, /领取/);

    const fail = tools.find((t) => t.name === "delivery_fail_task");
    const failed = await runTool(fail, "bare-session", { key: "REQ-0001", reason: "r" });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /领取/);
  } finally {
    revokeRole("bare-session");
  }
});

// ------------------------------------------------------ extensions mount

test("extensions: delivery runner tools mount requires work-items AND workflows", async () => {
  const src = await readFile(
    new URL("../../workspaces/extensions.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /createDeliveryRunnerExtension/, "the factory is mounted");
  assert.match(
    src,
    /capabilities\.includes\("workflows"\)/,
    "the second capability gate is explicit",
  );
});

// ------------------------------------------- Phase-3 Task 4: dual-role dispatch
// source：claim/submit/fail 按 grant.role 分派到 developer 服务；list 描述双角色；
// blocked 条目也带 role；submit 冲突的 developer 版释放引导在场。

test("tools: claim/submit/fail dispatch to the developer claim services (source)", async () => {
  const src = await readToolsSource();
  for (const service of ["claimDeveloperTask", "submitDeveloperResult", "failDeveloperTask"]) {
    assert.ok(src.includes(service), `${service} must be dispatched from the tools`);
  }
  for (const service of ["claimDesignerTask", "submitDesignerResult", "failDesignerTask"]) {
    assert.ok(src.includes(service), `${service} must still be dispatched from the tools`);
  }
  // submit 冲突的 developer 版引导（沿用 fail 释放话术，语义换成输入变化/设计已推进）
  assert.match(src, /输入已变化\/设计已推进/);
  assert.match(src, /请调用 delivery_fail_task 释放本次领取/);
});

test("tools: list tool describes BOTH roles and blocked entries carry role (source)", async () => {
  const src = await readToolsSource();
  const listDescription = src.match(/name:\s*"delivery_list_ready_tasks",[\s\S]*?description:\s*\n?\s*((?:"[^"]*"\s*\+\s*)*"[^"]*")/)?.[1]
    ?? src.match(/name:\s*"delivery_list_ready_tasks",[\s\S]*?description:\s*([\s\S]*?)promptSnippet/)?.[1]
    ?? "";
  assert.match(listDescription, /designer/, "list description mentions designer");
  assert.match(listDescription, /developer/, "list description mentions developer (T1 minor fix)");
  assert.match(listDescription, /verifier/, "list description mentions verifier (Phase-4 T4)");
  // blocked 条目也带 role（PoolEntry.role 全量透出）
  const blockedMap = src.match(/blocked:\s*pool\.blocked\.map\(\(entry\)\s*=>\s*\(\{[\s\S]*?\}\)\)/)?.[0] ?? "";
  assert.match(blockedMap, /role:\s*entry\.role/, "blocked entries carry role");
});

// ------------------------------------------- Phase-4 Task 4: verifier dispatch
// source：claim/submit/fail 按 grant.role 分派到 verifier 服务；run_check 的服务端
// 执行链（runConfiguredCheck + recordCheckResult）与 verifier 专属门在场；submit
// 描述注明 verifier 无需传检查结果；submit 冲突的 verifier 版释放引导在场。

test("tools: claim/submit/fail dispatch to the verifier claim services; run_check runs server-side (source)", async () => {
  const src = await readToolsSource();
  for (const service of [
    "claimVerifierTask",
    "submitVerifierResult",
    "failVerifierTask",
    "runConfiguredCheck",
    "recordCheckResult",
  ]) {
    assert.ok(src.includes(service), `${service} must be dispatched from the tools`);
  }
  // run_check 是 verifier 专属（他角色 → denied 文本，非异常）
  assert.match(src, /verifier 角色专属/);
  // submit 描述/形状门注明：verifier 无需传检查结果（服务端自 claim.checkResults 取）
  assert.match(src, /verifier 提交只需 key/);
  // submit 冲突的 verifier 版引导（候选变化/阶段推进 → fail 释放）
  assert.match(src, /候选已变化\/阶段已推进/);
  // fix round 1：verifier submit 传 conversationId（会话自链接——与 designer/
  // developer 同款，详情「关联会话」可达）。[^;] 界定在单条语句内——防止懒惰
  // 匹配越过调用终点误命中后文 developer 的同款传参。
  assert.match(
    src,
    /submitVerifierResult\(\{[^;]*?conversationId: sessionId/,
    "verifier submit call site must pass conversationId: sessionId",
  );
});

// --------------------------------------- tools: behavior (developer dispatch)
// 真 developer 工作区（真 git 仓 + designConfirmed 项）驱动工具 execute——
// 证明 grant.role=developer 时 claim/submit/fail 走 developer 服务（claim 成功
// 本身即证明：designer 服务对该项会以 wrong-role 拒绝）。

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitCmd(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

/** developer-ready 工作区（claim.test.mjs 同款手法，压缩版）：真 git 仓 +
 * enabled 配置 + ready_for_implementation 项（designConfirmed + design.md）。 */
async function makeDeveloperWorkspace(t) {
  const { contentDigest } = await import("../delivery-types.ts");
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-tools-dev-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repoDir = join(ws, "repo-a");
  await mkdir(repoDir, { recursive: true });
  await gitCmd(repoDir, ["init", "-q", "--initial-branch=main"]);
  await gitCmd(repoDir, ["config", "user.email", "test@example.com"]);
  await gitCmd(repoDir, ["config", "user.name", "Test"]);
  await writeFile(join(repoDir, "hello.txt"), "hello\n", "utf8");
  await gitCmd(repoDir, ["add", "."]);
  const headSha = await gitCmd(repoDir, ["commit", "-q", "-m", "init"]).then(() =>
    gitCmd(repoDir, ["rev-parse", "HEAD"]));

  await mkdir(join(ws, ".pi"), { recursive: true });
  await writeFile(
    join(ws, ".pi", "workspace.yaml"),
    [
      "schema_version: 1",
      "id: 01TESTWORKSPACE00000000000",
      "slug: test-ws",
      'name: "Test WS"',
      "skills: []",
      "repositories:",
      "  - id: repo-a",
      "    alias: repo-a",
      "    name: REPO-A",
      "    kind: code",
      "    path: repo-a",
      "    status: active",
      "capabilities: [sessions, explorer, work-items, workflows]",
      "work_items:",
      "  next_requirement_number: 2",
      "  next_bug_number: 1",
      'created_at: "2026-10-24T00:00:00Z"',
      'updated_at: "2026-10-24T00:00:00Z"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1,
    enabled: true,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });

  const readme = "Dev body\n";
  const design = "# 设计：Dev item\n\n## 方案\n方案 A\n\n## 验收条件\n- [ ] 冒烟通过\n";
  const itemDir = join(ws, ".pi", "work-items", "requirements", "REQ-0001-dev");
  await mkdir(join(itemDir, "delivery", "artifacts"), { recursive: true });
  await writeFile(
    join(itemDir, "item.yaml"),
    [
      "schema_version: 1",
      "id: REQ-0001-id",
      "key: REQ-0001",
      "type: requirement",
      "revision: 1",
      'title: "Dev item"',
      "status: open",
      "phase: ready_for_implementation",
      "priority: P1",
      "repositories: [repo-a]",
      "tags: []",
      "conversations: []",
      "related_items: []",
      "designs: []",
      "plans: []",
      "archived_at: null",
      'created_at: "2026-10-24T00:00:00Z"',
      'updated_at: "2026-10-24T00:00:00Z"',
      "delivery:",
      "  protocolVersion: 1",
      "  mode: manual",
      "  designConfirmed:",
      '    at: "2026-10-24T00:00:00Z"',
      "    actor: user",
      `    requirementDigest: "${contentDigest(readme)}"`,
      `    designDigest: "${contentDigest(design)}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(itemDir, "README.md"), readme, "utf8");
  await writeFile(join(itemDir, "events.jsonl"), "", "utf8");
  await writeFile(join(itemDir, "delivery", "artifacts", "design.md"), design, "utf8");
  return { ws, itemDir, headSha };
}

async function makeTools(workspacePath) {
  const { createDeliveryRunnerExtension } = await import("./tools.ts");
  const tools = [];
  createDeliveryRunnerExtension("ws-id-dev", workspacePath).factory({
    registerTool: (tool) => tools.push(tool),
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("tools: developer grant → claim 走 claimDeveloperTask（真 worktree 落 claim，结果带 worktree 清单）", async (t) => {
  const { ws, headSha } = await makeDeveloperWorkspace(t);
  const { readWorkItem } = await import("../service.ts");
  const byName = await makeTools(ws);
  void headSha;
  const sessionId = "tools-dev-claim";
  grantRole(sessionId, { role: "developer", workspacePath: ws });
  try {
    const payload = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    // developer 领取的专属产物：worktree 清单（path+branch）随领取返回
    assert.ok(Array.isArray(payload.worktrees) && payload.worktrees.length === 1);
    assert.equal(payload.worktrees[0].repositoryId, "repo-a");
    assert.equal(payload.worktrees[0].branch, "pi-delivery/REQ-0001/gen1");
    assert.ok(payload.worktrees[0].path.includes("worktrees"));
    // 阶段流转 = developer 事务（ready_for_implementation → implementation）
    const detail = await readWorkItem(ws, "REQ-0001");
    assert.equal(detail.item.phase, "implementation");
    assert.equal(detail.item.status, "in_progress");
    // 凭证已入 grant（submit/fail 可用）
    const grant = roleGrantOf(sessionId);
    assert.equal(grant.attemptId, payload.attemptId);
    assert.ok(grant.ownerToken);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: developer grant 对 intake 项 claim → designer 角色拒绝证明分派按 grant.role", async (t) => {
  const { ws } = await makeDeveloperWorkspace(t);
  // 把项改回 intake（developer 谓词 wrong-phase；designer 谓词本可通过——
  // grant.role=developer 必须走 developer 服务并收到拒绝）
  const { readWorkItem, serializeWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, "REQ-0001");
  const next = structuredClone(detail.item);
  next.phase = "intake";
  await writeFile(join(detail.path, "item.yaml"), serializeWorkItem(next), "utf8");

  const byName = await makeTools(ws);
  const sessionId = "tools-dev-wrong-phase";
  grantRole(sessionId, { role: "developer", workspacePath: ws });
  try {
    const payload = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "validation");
    assert.match(payload.message, /designer role, not developer|developer/);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: developer submit 形状按 grant.role 校验——designer 形状 → 400 validation", async (t) => {
  const { ws } = await makeDeveloperWorkspace(t);
  const byName = await makeTools(ws);
  const sessionId = "tools-dev-shape";
  grantRole(sessionId, { role: "developer", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    // developer 会话传 designer 形状（design_markdown+acceptance_criteria）→ 拒绝
    const payload = await runTool(byName.get("delivery_submit_result"), sessionId, {
      key: "REQ-0001",
      design_markdown: "# 设计",
      acceptance_criteria: ["c1"],
    });
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "validation");
    assert.match(payload.message, /candidates/);
    // 空 candidates 同样拒绝
    const empty = await runTool(byName.get("delivery_submit_result"), sessionId, {
      key: "REQ-0001",
      candidates: [],
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, "validation");
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: developer submit（candidates+notes）→ ok、等待人工验证提示、phase→verification、grant 重置", async (t) => {
  const { ws, headSha } = await makeDeveloperWorkspace(t);
  const { readWorkItem } = await import("../service.ts");
  const byName = await makeTools(ws);
  const sessionId = "tools-dev-submit";
  grantRole(sessionId, { role: "developer", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const payload = await runTool(byName.get("delivery_submit_result"), sessionId, {
      key: "REQ-0001",
      candidates: [{ repositoryId: "repo-a", commit: headSha }],
      notes: "实现完成，自测通过",
    });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    // developer 版成功提示：等待人工验证
    assert.match(payload.message, /等待人工验证/);
    const detail = await readWorkItem(ws, "REQ-0001");
    assert.equal(detail.item.phase, "verification");
    assert.deepEqual(
      detail.item.delivery.candidates,
      [{ repositoryId: "repo-a", commit: headSha }],
    );
    // grant 重置回裸授权（凭证不复用）
    const grant = roleGrantOf(sessionId);
    assert.equal(grant.attemptId, undefined);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: developer fail → 释放领取并回退 ready_for_implementation", async (t) => {
  const { ws } = await makeDeveloperWorkspace(t);
  const { readWorkItem } = await import("../service.ts");
  const byName = await makeTools(ws);
  const sessionId = "tools-dev-fail";
  grantRole(sessionId, { role: "developer", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const payload = await runTool(byName.get("delivery_fail_task"), sessionId, {
      key: "REQ-0001",
      reason: "实现阻塞",
    });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    const detail = await readWorkItem(ws, "REQ-0001");
    assert.equal(detail.item.phase, "ready_for_implementation", "developer fail 回退到可重领");
    assert.equal(detail.item.status, "open");
  } finally {
    revokeRole(sessionId);
  }
});

// --------------------------------------- tools: behavior (verifier dispatch)
// 真 verifier 工作区（claim.test.mjs makeVerifierWorkspace 同款手法，压缩版）：
// 真 git 仓 + enabled 配置（含 verification.checks）+ managed verification 项
// （designConfirmed 双 digest + candidates 真 sha + design.md）——驱动工具 execute
// 证明 grant.role=verifier 时 claim/submit/fail 走 verifier 服务、run_check 服务端
// 执行并累积证据（designer 服务对该项会以 wrong-role 拒绝）。

/** verifier-ready 工作区；checks 可注入（null = 不写 verification 键）。 */
async function makeVerifierToolsWorkspace(t, {
  checks = [{ name: "build", command: "echo build-ok" }],
} = {}) {
  const { contentDigest } = await import("../delivery-types.ts");
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-tools-ver-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repoDir = join(ws, "repo-a");
  await mkdir(repoDir, { recursive: true });
  await gitCmd(repoDir, ["init", "-q", "--initial-branch=main"]);
  await gitCmd(repoDir, ["config", "user.email", "test@example.com"]);
  await gitCmd(repoDir, ["config", "user.name", "Test"]);
  await writeFile(join(repoDir, "hello.txt"), "hello\n", "utf8");
  await gitCmd(repoDir, ["add", "."]);
  const headSha = await gitCmd(repoDir, ["commit", "-q", "-m", "init"]).then(() =>
    gitCmd(repoDir, ["rev-parse", "HEAD"]));

  await mkdir(join(ws, ".pi"), { recursive: true });
  await writeFile(
    join(ws, ".pi", "workspace.yaml"),
    [
      "schema_version: 1",
      "id: 01TESTWORKSPACE00000000000",
      "slug: test-ws",
      'name: "Test WS"',
      "skills: []",
      "repositories:",
      "  - id: repo-a",
      "    alias: repo-a",
      "    name: REPO-A",
      "    kind: code",
      "    path: repo-a",
      "    status: active",
      "capabilities: [sessions, explorer, work-items, workflows]",
      "work_items:",
      "  next_requirement_number: 2",
      "  next_bug_number: 1",
      'created_at: "2026-10-24T00:00:00Z"',
      'updated_at: "2026-10-24T00:00:00Z"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1,
    enabled: true,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
    ...(checks !== null ? { verification: { checks } } : {}),
  });

  const readme = "Verify body\n";
  const design = "# 设计：Ver item\n\n## 方案\n方案 A\n\n## 验收条件\n- [ ] 冒烟通过\n";
  const itemDir = join(ws, ".pi", "work-items", "requirements", "REQ-0001-ver");
  await mkdir(join(itemDir, "delivery", "artifacts"), { recursive: true });
  await writeFile(
    join(itemDir, "item.yaml"),
    [
      "schema_version: 1",
      "id: REQ-0001-id",
      "key: REQ-0001",
      "type: requirement",
      "revision: 1",
      'title: "Ver item"',
      "status: open",
      "phase: verification",
      "priority: P1",
      "repositories: [repo-a]",
      "tags: []",
      "conversations: []",
      "related_items: []",
      "designs: []",
      "plans: []",
      "archived_at: null",
      'created_at: "2026-10-24T00:00:00Z"',
      'updated_at: "2026-10-24T00:00:00Z"',
      "delivery:",
      "  protocolVersion: 1",
      "  mode: manual",
      "  designConfirmed:",
      '    at: "2026-10-24T00:00:00Z"',
      "    actor: user",
      `    requirementDigest: "${contentDigest(readme)}"`,
      `    designDigest: "${contentDigest(design)}"`,
      "  candidates:",
      `  - repositoryId: "repo-a"`,
      `    commit: "${headSha}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(itemDir, "README.md"), readme, "utf8");
  await writeFile(join(itemDir, "events.jsonl"), "", "utf8");
  await writeFile(join(itemDir, "delivery", "artifacts", "design.md"), design, "utf8");
  return { ws, itemDir, headSha };
}

test("tools: verifier grant → claim 走 claimVerifierTask（结果带 worktrees+checks 冻结清单，phase 不变）", async (t) => {
  const { ws, itemDir } = await makeVerifierToolsWorkspace(t);
  const { readClaim } = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const byName = await makeTools(ws);
  const sessionId = "tools-ver-claim";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const payload = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    // verifier 领取的专属产物：候选 detached checkout 清单 + checks 冻结快照
    //（repositoryId 缺省已在领取时解析为候选首仓）。
    assert.ok(Array.isArray(payload.worktrees) && payload.worktrees.length === 1);
    assert.equal(payload.worktrees[0].repositoryId, "repo-a");
    assert.deepEqual(payload.checks, [
      { name: "build", repositoryId: "repo-a", command: "echo build-ok" },
    ]);
    // verifier 事务语义：phase 不变（verification）、status in_progress。
    const claim = readClaim(itemDir);
    assert.equal(claim.role, "verifier");
    const detail = await readWorkItem(ws, "REQ-0001");
    assert.equal(detail.item.phase, "verification");
    assert.equal(detail.item.status, "in_progress");
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: run_check 他角色（designer grant）→ denied 文本非异常", async (t) => {
  const { ws } = await makeVerifierToolsWorkspace(t);
  const byName = await makeTools(ws);
  const sessionId = "tools-runcheck-designer";
  grantRole(sessionId, { role: "designer", workspacePath: ws });
  try {
    const payload = await runTool(byName.get("delivery_run_check"), sessionId, { name: "build" });
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "forbidden");
    assert.match(payload.message, /verifier 角色专属/);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: run_check 无领取（裸 verifier grant）→ 引导先领取", async (t) => {
  const { ws } = await makeVerifierToolsWorkspace(t);
  const byName = await makeTools(ws);
  const sessionId = "tools-runcheck-bare";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const payload = await runTool(byName.get("delivery_run_check"), sessionId, { name: "build" });
    assert.equal(payload.ok, false);
    assert.match(payload.message, /领取/);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: verifier run_check → 服务端执行、证据进 claim.checkResults、logDir 按 spec §7 布局", async (t) => {
  const { ws, itemDir } = await makeVerifierToolsWorkspace(t);
  const { readClaim } = await import("./attempts.ts");
  const byName = await makeTools(ws);
  const sessionId = "tools-runcheck-ok";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const payload = await runTool(byName.get("delivery_run_check"), sessionId, { name: "build" });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.name, "build");
    assert.equal(payload.outcome, "passed");
    assert.equal(payload.exitCode, 0);
    assert.ok(typeof payload.durationMs === "number");
    // 证据累积进 claim.checkResults（服务端唯一注入口——LLM 无参可传）
    const claim = readClaim(itemDir);
    assert.equal(claim.checkResults.length, 1);
    assert.equal(claim.checkResults[0].name, "build");
    assert.equal(claim.checkResults[0].outcome, "passed");
    // carried ruling #1：logDir 必须按 spec §7 布局
    // <item>/delivery/artifacts/verification-logs/<attemptId>/（logRef 为相对
    // 工作项根的 POSIX 路径——不是裸文件名）。
    const logPath = join(
      itemDir, "delivery", "artifacts", "verification-logs", claimed.attemptId, "build.log",
    );
    const log = await readFile(logPath, "utf8");
    assert.match(log, /build-ok/);
    assert.equal(
      claim.checkResults[0].logRef,
      `delivery/artifacts/verification-logs/${claimed.attemptId}/build.log`,
    );
    assert.equal(payload.logRef, claim.checkResults[0].logRef);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: run_check 未知名 → validation 文本（带可用名单）", async (t) => {
  const { ws } = await makeVerifierToolsWorkspace(t);
  const byName = await makeTools(ws);
  const sessionId = "tools-runcheck-unknown";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const payload = await runTool(byName.get("delivery_run_check"), sessionId, { name: "nope" });
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "validation");
    assert.match(payload.message, /nope/);
    assert.match(payload.message, /build/);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: run_check 重跑同名覆盖（幂等重试，最新结果胜出）", async (t) => {
  // 首跑建标记退出 1（failed）→ 重跑见标记退出 0（passed）：同名覆盖而非追加。
  const { ws, itemDir } = await makeVerifierToolsWorkspace(t, {
    checks: [{
      name: "gate",
      command: "if [ -f .rc-marker ]; then echo second; exit 0; else touch .rc-marker; exit 1; fi",
    }],
  });
  const { readClaim } = await import("./attempts.ts");
  const byName = await makeTools(ws);
  const sessionId = "tools-runcheck-rerun";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const first = await runTool(byName.get("delivery_run_check"), sessionId, { name: "gate" });
    assert.equal(first.ok, true);
    assert.equal(first.outcome, "failed");
    assert.equal(first.exitCode, 1);
    const second = await runTool(byName.get("delivery_run_check"), sessionId, { name: "gate" });
    assert.equal(second.ok, true);
    assert.equal(second.outcome, "passed");
    assert.equal(second.exitCode, 0);
    const claim = readClaim(itemDir);
    assert.equal(claim.checkResults.length, 1, "同名覆盖——不追加第二条");
    assert.equal(claim.checkResults[0].outcome, "passed");
    assert.equal(claim.checkResults[0].exitCode, 0);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: verifier submit 只需 {key}(+notes)——检查结果服务端自 claim.checkResults 取", async (t) => {
  const { ws } = await makeVerifierToolsWorkspace(t);
  const { readWorkItem } = await import("../service.ts");
  const byName = await makeTools(ws);
  const sessionId = "tools-ver-submit";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const ran = await runTool(byName.get("delivery_run_check"), sessionId, { name: "build" });
    assert.equal(ran.ok, true);
    const payload = await runTool(byName.get("delivery_submit_result"), sessionId, {
      key: "REQ-0001",
      notes: "全部通过",
    });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    const detail = await readWorkItem(ws, "REQ-0001");
    assert.equal(detail.item.phase, "release_ready");
    // 会话自链接（fix round 1）：工具层透传 conversationId=sessionId → 服务端合并
    assert.ok(
      detail.item.conversations.includes(sessionId),
      "verifier submit auto-links the session into conversations",
    );
    // delivery.verification 由服务端组装（actor=agent + 命令取自冻结快照）
    assert.equal(detail.item.delivery.verification.actor, "agent");
    assert.equal(detail.item.delivery.verification.checks[0].evidence.command, "echo build-ok");
    // grant 重置回裸授权（凭证不复用）
    const grant = roleGrantOf(sessionId);
    assert.equal(grant.attemptId, undefined);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: verifier submit 未跑检查 → 服务端 validation（缺名，证据只能来自 run_check）", async (t) => {
  const { ws } = await makeVerifierToolsWorkspace(t);
  const byName = await makeTools(ws);
  const sessionId = "tools-ver-submit-missing";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const payload = await runTool(byName.get("delivery_submit_result"), sessionId, { key: "REQ-0001" });
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "validation");
    assert.match(payload.message, /not run/);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: verifier submit 传其他角色字段 → validation（形状门）", async (t) => {
  const { ws } = await makeVerifierToolsWorkspace(t);
  const byName = await makeTools(ws);
  const sessionId = "tools-ver-submit-shape";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const payload = await runTool(byName.get("delivery_submit_result"), sessionId, {
      key: "REQ-0001",
      candidates: [{ repositoryId: "repo-a", commit: "x" }],
    });
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "validation");
    assert.match(payload.message, /verifier 提交只需 key/);
  } finally {
    revokeRole(sessionId);
  }
});

test("tools: verifier fail → 释放领取，phase 不动（verification→verification）", async (t) => {
  const { ws } = await makeVerifierToolsWorkspace(t);
  const { readWorkItem } = await import("../service.ts");
  const byName = await makeTools(ws);
  const sessionId = "tools-ver-fail";
  grantRole(sessionId, { role: "verifier", workspacePath: ws });
  try {
    const claimed = await runTool(byName.get("delivery_claim_task"), sessionId, { key: "REQ-0001" });
    assert.equal(claimed.ok, true);
    const payload = await runTool(byName.get("delivery_fail_task"), sessionId, {
      key: "REQ-0001",
      reason: "验证环境不可用",
      blocked: true,
    });
    assert.equal(payload.ok, true, JSON.stringify(payload));
    const detail = await readWorkItem(ws, "REQ-0001");
    assert.equal(detail.item.phase, "verification", "verifier fail 不动阶段");
    assert.equal(detail.item.status, "blocked");
  } finally {
    revokeRole(sessionId);
  }
});
