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

test("tools: registers exactly the four claim-side delivery tools", async () => {
  const src = await readToolsSource();
  assert.match(src, /delivery_list_ready_tasks/);
  assert.match(src, /delivery_claim_task/);
  assert.match(src, /delivery_submit_result/);
  assert.match(src, /delivery_fail_task/);
});

test("tools: no human action tools are registered (confirm / record-release / block / unblock / cancel …)", async () => {
  const src = await readToolsSource();
  // 工具面只有领取侧：任何非四工具名的 delivery_* 注册都不允许。
  const registered = [...src.matchAll(/name:\s*"(delivery_[a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    registered.sort(),
    [
      "delivery_claim_task",
      "delivery_fail_task",
      "delivery_list_ready_tasks",
      "delivery_submit_result",
    ],
    "only the four claim-side tools may be registered",
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
  assert.equal(tools.length, 4);
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
