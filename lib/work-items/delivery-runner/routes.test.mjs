// Phase-2 Task 8: 人工控制路由与执行状态端点（brief Step 1 source 断言）。
// 四条路由的存在与关键语义（同 delivery-route.test.mjs 的源断言风格——路由
// 依赖 facade/session-host 等宿主重模块，行为由各自服务测试覆盖，这里钉住
// 路由层的接线与顺序约定）：
//   1. GET  .../work-items/[key]/delivery-execution   —— 四读拼装 + 剥离
//      ownerTokenHash（token 哈希不出服务端）+ attempts 末 5 条倒序
//   2. POST .../work-items/[key]/delivery-execution/stop —— claim 缺失 →
//      NotFound(404)；probeSession 活 → destroySession → recordInterruption
//      ("stopped by user") 链（顺序即语义：先杀会话再记中断）
//   3. POST .../work-items/[key]/delivery-execution/recover —— 探测作用域 =
//      工作区根（T8 裁定，与 M1 loop recover 同口径）；存活进程 → 409 {error,
//      pids}（manual 也不放行）；干净 → resolveInterruptions(needsAttention:
//      false, manual → actor user) + delivery.exec_recovered 事件
//   4. POST /api/workspaces/[id]/delivery/resume body {key} —— 薄壳直调
//      resumeAutomation（未暂停 → 服务 Validation → 400）
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const GET_ROUTE = "../../../app/api/workspaces/[id]/work-items/[key]/delivery-execution/route.ts";
const STOP_ROUTE = "../../../app/api/workspaces/[id]/work-items/[key]/delivery-execution/stop/route.ts";
const RECOVER_ROUTE = "../../../app/api/workspaces/[id]/work-items/[key]/delivery-execution/recover/route.ts";
const RESUME_ROUTE = "../../../app/api/workspaces/[id]/delivery/resume/route.ts";

test("all four execution-control route files exist", async () => {
  for (const rel of [GET_ROUTE, STOP_ROUTE, RECOVER_ROUTE, RESUME_ROUTE]) {
    const src = await read(rel);
    assert.ok(src.trim().length > 0, `${rel} exists and is non-empty`);
  }
});

test("GET delivery-execution assembles runtime state and strips ownerTokenHash", async () => {
  const src = await read(GET_ROUTE);
  assert.match(src, /readClaim/);
  assert.match(src, /listAttempts/);
  assert.match(src, /listPendingInterruptions/);
  assert.match(src, /readPaused/);
  // itemPath 经 readWorkItem(workspacePath, key).path 推导
  assert.match(src, /readWorkItem/);
  // token 哈希剥离：rest 解构 + Omit 类型（哈希永不离开服务端）
  const strip = src.match(/ownerTokenHash[^,}]*,\s*\.\.\./) ?? src.match(/\.\.\..*ownerTokenHash/);
  assert.ok(strip, "claim is stripped of ownerTokenHash via rest destructuring");
  assert.match(src, /Omit<ClaimState,\s*"ownerTokenHash">/);
  // attempts 末 5 条、新者在前（listAttempts 是 attemptId 升序）
  assert.match(src, /slice\(-5\)/);
  assert.match(src, /\.reverse\(\)/);
  assert.match(src, /workItemErrorResponse/); // item 不存在 → 404
});

test("GET delivery-execution enriches worktrees with repository alias at read time (fix round 1)", async () => {
  const src = await read(GET_ROUTE);
  // manifest 联表：readWorkspaceManifest → aliasById Map（alias 是展示元数据
  // 且可改名——claim 时落盘会漂移，读取时联表永远新鲜）。
  assert.match(src, /readWorkspaceManifest/);
  assert.match(src, /aliasById/);
  // 富化不落盘：claim 与 recentAttempts 的 worktrees 都在响应组装时富化。
  assert.match(src, /function enrichWorktrees/);
  assert.match(src, /enrichWorktrees\(claim\.worktrees, aliasById\)/);
  assert.match(src, /enrichWorktrees\(entry\.worktrees, aliasById\)/);
  // 富化只加字段：无 alias/未登记 → 不虚构（aliasById.get 命中才写）。
  assert.match(src, /alias \? \{ \.\.\.worktree, alias \} : \{ \.\.\.worktree \}/);
});

test("stop route follows the probe -> destroy -> recordInterruption chain", async () => {
  const src = await read(STOP_ROUTE);
  // 无 claim → NotFound 型（workItemErrorResponse 映射 404）
  assert.match(src, /WorkItemNotFoundError/);
  // 链序即语义：先探测，活着才 destroy，然后记中断
  const idxProbe = src.indexOf("probeSession");
  const idxDestroy = src.indexOf("destroySession");
  const idxRecord = src.indexOf("recordInterruption");
  assert.ok(idxProbe >= 0 && idxDestroy > idxProbe && idxRecord > idxDestroy,
    "probeSession precedes destroySession precedes recordInterruption");
  assert.match(src, /live !== null/); // destroy 仅在会话仍活时定向杀
  assert.match(src, /stopped by user/);
  assert.match(src, /workItemErrorResponse/);
});

test("recover route probes the workspace root and gates on surviving processes", async () => {
  const src = await read(RECOVER_ROUTE);
  assert.match(src, /detectSurvivingRoundProcesses/);
  // 探测作用域 = 工作区根（getWorkspace 的 path，非 itemPath）——T8 裁定
  assert.match(src, /detectSurvivingRoundProcesses\(path\)/);
  // 409 先于解除（manual 也不放行实测存活）；响应带 pids
  const idxConflict = src.indexOf("409");
  const idxResolve = src.indexOf("resolveInterruptions");
  assert.ok(idxConflict >= 0 && idxResolve > idxConflict, "409 branch precedes resolveInterruptions");
  assert.match(src, /pids/);
  // 干净 → 解除中断（needsAttention:false；manual=true → actor user）+ 事件
  assert.match(src, /resolveInterruptions/);
  assert.match(src, /needsAttention:\s*false/);
  assert.match(src, /manual === true/);
  assert.match(src, /delivery\.exec_recovered/);
  assert.match(src, /workItemErrorResponse/);
});

test("resume route is a thin shell over resumeAutomation keyed by body.key", async () => {
  const src = await read(RESUME_ROUTE);
  assert.match(src, /resumeAutomation\(path,\s*body\.key/); // （工作区 path, body 的 key）
  assert.match(src, /workItemErrorResponse/); // 未暂停 → 服务 Validation → 400
  assert.match(src, /WorkItemValidationError/); // body 缺 key → 400
  assert.match(src, /getWorkspace/);
});
