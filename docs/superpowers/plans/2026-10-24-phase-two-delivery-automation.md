# 第二阶段：交付执行自动化（领取协议 + designer）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已落地的 M1 单进程宿主与 M2 人工交付流程之上，交付程序保证的任务领取协议（TaskPool 投影 + 原子 claim/submit/fail + attempt/中断恢复）与第一个自动执行角色 designer（领取起稿设计，提交即停，人确认后流转）。

**Architecture:** 全部落在 `lib/work-items/delivery-runner/` 扩展模块（config/pool/attempts/claim/tools/role-session/dispatcher）；领取事务复用 M2 双层工作区写锁，阶段流转与事件复用 M2 的 delivery 语义（actor=agent 变体）；Dispatcher 是 M1 HostJob 体系的第二个常驻 job；角色会话是顶层普通会话（两步创建拿 sessionId → 预登记角色授权 → 发开场 prompt），工具回调以 `pi.sessionId` 核对授权，ownerToken 全程不经 LLM。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent 0.84.4（原样依赖）、node:test + jiti、既有 work-items YAML/JSONL 文件协议。

**Spec:** `docs/superpowers/specs/2026-10-24-phase-two-delivery-automation-design.md`（用户已批准）。

## Global Constraints

- 不修改 `@earendil-works/pi-*` 任何源码或依赖版本。
- 人工门禁不可绕过：confirm-design / record-release 永远 actor=user；不注册任何「agent 批准/发布登记」工具。
- 领取/流转规则是**程序保证**（服务端事务），不只写在提示词；agent 不能自报身份——role/sessionId 由 `pi.sessionId` 服务端解析，ownerToken 由运行时携带，LLM 参数不收 token。
- 无任务不建会话不调模型；单工作区同时至多一个 designer 执行；同输入连续失败 3 次（默认）停止自动领取，显式 resume 恢复。
- capability 门控 = work-items ∩ workflows（`workflows` 自本阶段激活自动执行含义）；`.pi/delivery.yaml` 缺省关闭。
- 中断恢复保守：失联不自动回收；关停写 needsAttention 中断记录阻塞新领取；恢复需人工确认（探测口径复用 M1）。
- cxin dev-loop kit、非 managed 项、导入脚本、回收站行为不变；`workspace_list_work_items` 默认排除 managed 项不变。
- 事件全部追加 events.jsonl（`delivery.claimed / delivery.submitted / delivery.attempt_failed / delivery.automation_paused / delivery.exec_interrupted / delivery.exec_recovered / delivery.resumed`）。
- 验证只跑 `node --test`、`node_modules/.bin/tsc --noEmit`、`npm run lint` 与必要手测；**绝不运行 `next build`**。
- 每任务以可运行测试结尾并提交；conventional 前缀提交。

---

### Task 1: 工作区交付配置 `.pi/delivery.yaml`

**Files:**
- Create: `lib/work-items/delivery-runner/config.ts`
- Create: `lib/work-items/delivery-runner/config.test.mjs`
- Create: `app/api/workspaces/[id]/delivery/route.ts`（GET|PUT 薄壳）

**Interfaces:**
- Consumes: `getWorkspace`/`readWorkspaceManifest`（`@/lib/workspaces/service`）、`withWorkspaceWriteLock`、`writeAtomic`（work-items service 的原子写助手——若私有则在本模块内实现 tmp+rename）、`WorkItemValidationError`（`@/lib/work-items/errors`）、`workItemErrorResponse`（`@/lib/work-items/web`）。
- Produces（后续任务全部依赖）：

```ts
export interface DeliveryRoleConfig { profile?: string; model?: { provider?: string; modelId: string } }
export interface DeliveryRunnerConfig {
  schemaVersion: 1;
  enabled: boolean;
  roles: { designer?: DeliveryRoleConfig };
  budget: { maxAttemptsPerInput: number; maxExecutionMinutes: number };
}
export const DEFAULT_DELIVERY_RUNNER_CONFIG: DeliveryRunnerConfig;
export function parseDeliveryRunnerConfig(value: unknown): DeliveryRunnerConfig;
// schemaVersion!==1 → WorkItemValidationError("Unknown delivery runner config schemaVersion: N")
// budget 字段缺省回填默认（3 / 30）；负数或 0 → Validation
export function deliveryConfigPath(workspacePath: string): string;  // <ws>/.pi/delivery.yaml
export async function readDeliveryRunnerConfig(workspacePath: string): Promise<DeliveryRunnerConfig | null>;  // 文件缺失 → null（视为 disabled）
export async function writeDeliveryRunnerConfig(workspacePath: string, config: DeliveryRunnerConfig): Promise<void>;  // tmp+rename
export function assertAutomationCapable(manifest: { capabilities: readonly string[] }): void;
// capabilities 不含 "work-items" ∧ "workflows" → WorkItemValidationError("delivery automation requires work-items and workflows capabilities")
```

- [ ] **Step 1: 写失败测试**（jiti + mkdtemp；断言默认值回填、未知 schemaVersion 拒绝、round-trip、capability 校验、PUT 路由 source 断言）

```js
// lib/work-items/delivery-runner/config.test.mjs（节选核心断言，风格沿用 lib/work-items 既有测试）
test("parse fills defaults and rejects unknown schemaVersion", () => {
  const cfg = dt.parseDeliveryRunnerConfig({ schemaVersion: 1, enabled: true });
  assert.equal(cfg.budget.maxAttemptsPerInput, 3);
  assert.equal(cfg.budget.maxExecutionMinutes, 30);
  assert.throws(() => dt.parseDeliveryRunnerConfig({ schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, enabled: true, budget: { maxAttemptsPerInput: 0, maxExecutionMinutes: 30 } }), /maxAttemptsPerInput/);
});
test("round-trip through read/write", async () => { /* mkdtemp ws → write → read 深比较；无文件 → null */ });
test("capability gate", () => {
  assert.doesNotThrow(() => dt.assertAutomationCapable({ capabilities: ["sessions", "work-items", "workflows"] }));
  assert.throws(() => dt.assertAutomationCapable({ capabilities: ["sessions", "work-items"] }), /workflows/);
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test lib/work-items/delivery-runner/config.test.mjs`
- [ ] **Step 3: 实现 config.ts**（yaml 用仓内既用的 yaml 库——对照 `lib/work-items/service.ts` 顶部 import；PUT 前置 `assertAutomationCapable(readWorkspaceManifest(ws))` 在路由层做）
- [ ] **Step 4: 路由**

```ts
// app/api/workspaces/[id]/delivery/route.ts
import { NextResponse } from "next/server";
import { getWorkspace, readWorkspaceManifest } from "@/lib/workspaces/service";
import { WorkItemValidationError } from "@/lib/work-items/errors";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { parseDeliveryRunnerConfig, readDeliveryRunnerConfig, writeDeliveryRunnerConfig, assertAutomationCapable } from "@/lib/work-items/delivery-runner/config";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    return NextResponse.json({ config: await readDeliveryRunnerConfig(path) });
  } catch (error) { return workItemErrorResponse(error); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    assertAutomationCapable(await readWorkspaceManifest(path));
    const config = parseDeliveryRunnerConfig(await req.json().catch(() => { throw new WorkItemValidationError("invalid JSON body"); }));
    await writeDeliveryRunnerConfig(path, config);
    return NextResponse.json({ config });
  } catch (error) { return workItemErrorResponse(error); }
}
```

- [ ] **Step 5: 测试+tsc+lint → Commit** `feat: workspace delivery automation config`

---

### Task 2: TaskPool 投影（pool.ts）

**Files:**
- Create: `lib/work-items/delivery-runner/pool.ts`
- Create: `lib/work-items/delivery-runner/pool.test.mjs`

**Interfaces:**
- Consumes: `listWorkItems`（`@/lib/work-items/service`）、Task 1 config、Task 3 的 `ClaimState`/`AttemptRecord`（本任务测试用字面量即可，类型从 `./attempts.ts` import）。
- Produces:

```ts
export type DesignerPoolReason =
  | "not-managed" | "automation-disabled" | "wrong-phase" | "active-claim"
  | "pending-interruption" | "automation-paused" | "failure-limit"
  | "terminal-status" | "archived";
export interface PoolEntry { key: string; title: string; priority: string; requirementDigest: string; ready: boolean; reasons: DesignerPoolReason[] }
/** 纯投影：全部输入由调用方传入（测试零 fs）。 */
export function projectDesignerPool(
  items: Array<{ key: string; title: string; priority: string; status: string; phase: string; archivedAt: string | null; delivery?: { protocolVersion: number; designConfirmed?: unknown } | null }>,
  ctx: { enabled: boolean; activeClaims: Set<string>; pendingInterruptions: Set<string>; paused: Set<string>; failedCountByDigest: Map<string, number>; maxAttemptsPerInput: number },
): PoolEntry[];
/** 读取端：装配 ctx（listWorkItems + config + 各项 claim/attempts/paused 文件）后调用纯投影。排序 P0→P3→key。 */
export async function listDesignerPool(workspacePath: string): Promise<{ ready: PoolEntry[]; blocked: PoolEntry[] }>;
```

- 纯投影谓词（spec §5.1）：managed ∧ enabled ∧ phase==="intake" ∧ !activeClaim ∧ !pendingInterruption ∧ !paused ∧ failedCount(requirementDigest) < max ∧ status 非 cancelled/done ∧ 未归档。requirementDigest 用 `contentDigest`（`@/lib/work-items/delivery-types`）对 README 内容计算——读取端做（投影收现成 digest 值：items 参数字段 requirementDigest 由 listDesignerPool 填，纯函数只比较）。**修正**：为保纯函数零 fs，`projectDesignerPool` 的 items 参数直接带 `requirementDigest` 字段（listDesignerPool 计算）。
- [ ] **Step 1: 失败测试**——覆盖每个 reason 分支 + 排序（P0 先于 P2、同优先级 key 升序）+ ready/blocked 分桶。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（纯函数 + 读取端；读取端对每 item 读 claim/paused/失败计数，fs 容错：目录缺失=空）→ **Step 4: 跑过 + tsc** → **Step 5: Commit** `feat: designer task pool projection`

---

### Task 3: claim 运行态与 attempt 审计（attempts.ts）

**Files:**
- Create: `lib/work-items/delivery-runner/attempts.ts`
- Create: `lib/work-items/delivery-runner/attempts.test.mjs`

**Interfaces:**
- Consumes: `writeAtomic` 风格 tmp+rename（对照 `lib/loops/executions.ts` 的实现习语）。
- Produces（T4/T7/T8/T9 依赖）:

```ts
export interface ClaimState {
  attemptId: string; generation: number; role: "designer"; sessionId: string;
  claimedAt: string; lastSeenAt: string; requirementDigest: string;
  ownerTokenHash: string;  // sha256 hex——明文 token 只存在于进程内 role grant，永不落盘
  lastRequest?: { requestId: string; at: string };
}
export interface AttemptRecord {
  attemptId: string; generation: number; role: "designer"; sessionId: string;
  workspacePath: string; key: string; claimedAt: string;
  endedAt?: string; outcome?: "submitted" | "failed" | "interrupted";
  reason?: string; requirementDigest: string; needsAttention?: boolean;
  diagnostic?: { checkedAt?: string; actor?: string };
}
export function claimFilePath(itemPath: string): string;        // <item>/delivery/runtime/claim.json
export function attemptsDir(itemPath: string): string;          // <item>/delivery/attempts
export function readClaim(itemPath: string): ClaimState | null;
export function writeClaim(itemPath: string, claim: ClaimState): void;   // tmp+rename，目录 mkdir -p
export function clearClaim(itemPath: string): void;
export async function writeAttempt(record: AttemptRecord): Promise<void>;
export async function listAttempts(itemPath: string): Promise<AttemptRecord[]>;          // 坏文件跳过
export async function listPendingInterruptions(itemPath: string): Promise<AttemptRecord[]>;
export async function resolveInterruptions(itemPath: string, patch: { outcome?: "interrupted"; needsAttention: false; diagnostic?: { checkedAt: string; actor?: string } }): Promise<number>;
export function pausedFilePath(itemPath: string): string;       // <item>/delivery/runtime/automation-paused.json
export function readPaused(itemPath: string): { at: string; reason: string; count: number } | null;
export function writePaused(itemPath: string, info: { at: string; reason: string; count: number }): void;
export function clearPaused(itemPath: string): void;
export function hashOwnerToken(token: string): string;          // sha256 hex
```

- [ ] **Step 1: 失败测试**——claim round-trip/clear、attempt 追加与坏文件跳过、pending/resolve 保留审计只清 needsAttention、paused round-trip。**Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过+tsc** → **Step 5: Commit** `feat: delivery claim runtime and attempt audit records`

---

### Task 4: ClaimService 领取事务（claim.ts）

**Files:**
- Create: `lib/work-items/delivery-runner/claim.ts`
- Create: `lib/work-items/delivery-runner/claim.test.mjs`

**Interfaces:**
- Consumes: `withWorkspaceWriteLock`（`@/lib/workspaces/service`）、`getWorkspace`/`readWorkspaceManifest`、`readWorkItem`/`serializeWorkItem`/`appendEvent`/`eventFor`/`commitWorkspaceChanges`（work-items service；私有助手如不可导出则按 delivery.ts 的同构做法在本模块实现——先读 `lib/work-items/delivery.ts` 看它怎么复用）、Task 1–3 全部、`contentDigest`、M2 `updateDesignContent` 的服务函数（`@/lib/work-items/delivery`——确认其签名后复用；不可复用则按其实现同构内联）。
- Produces:

```ts
export interface ClaimGrant { attemptId: string; generation: number; ownerToken: string; key: string; item: WorkItemDetail }
export interface ClaimInput { workspaceId: string; key: string; sessionId: string; requestId: string }
export async function claimDesignerTask(input: ClaimInput): Promise<{ grant: ClaimGrant; replayed: boolean }>;
// 事务（withWorkspaceWriteLock 内）：readClaim→同 requestId+role 命中→返回现 grant(replayed)；
// 否则纯投影谓词逐条复验（managed/enabled/phase=intake/无活动claim/无中断/未暂停/未达失败上限/状态可领）→
//   generation+1、attemptId=ULID、ownerToken=randomUUID → phase intake→design + design.md 缺失播种模板（对照 M2 start-design 的模板串）→
//   status=in_progress、revision+1 → writeClaim（含 lastRequest）→ appendEvent delivery.claimed {phase:{from,to}, generation, attemptId, actor:"agent"} →
//   commitWorkspaceChanges("workspace: delivery claim <key>") → readWorkItem 返回
// 失败：前置不满足→WorkItemValidationError(带 reason 串)；他人活动 claim→WorkItemConflictError
export interface SubmitDesignInput { workspaceId: string; key: string; attemptId: string; generation: number; ownerToken: string; designContent: string; acceptanceCriteria: string[]; requestId: string; conversationId?: string }
export async function submitDesignerResult(input: SubmitDesignInput): Promise<WorkItemDetail>;
// 锁内：claim 存在 ∧ attemptId/generation 匹配 ∧ hashOwnerToken 匹配 ∧ requirementDigest 未变（变了→Conflict 409 要求重领）→
//   写 design.md（designContent + 「## 验收条件」节由 acceptanceCriteria 列表合成——对照 updateDesignContent 的写入路径，actor:"agent"）→
//   clearClaim → writeAttempt(outcome submitted) → appendEvent delivery.submitted {attemptId, generation, criteriaCount} →
//   status→open（阶段保持 design 等人确认）→ commit → 返回 detail
export interface FailInput { workspaceId: string; key: string; attemptId: string; generation: number; ownerToken: string; reason: string; blocked?: boolean }
export async function failDesignerTask(input: FailInput): Promise<WorkItemDetail>;
// 锁内校验同上 → clearClaim → writeAttempt(outcome failed) → 事件 delivery.attempt_failed {reason, blocked} →
//   blocked=true→status=blocked；失败计数（同 requirementDigest 的 failed attempts）≥ max→writePaused+事件 delivery.automation_paused → commit
export async function heartbeatActiveClaim(workspacePath: string, itemPath: string, sessionId: string): Promise<boolean>;
// 无业务锁的轻量续约：readClaim→sessionId 匹配→lastSeenAt=now→writeClaim（attemptId/generation 原样写回即安全）→true；无 claim/不匹配→false
export async function recordInterruption(workspacePath: string, key: string, sessionId: string, reason: string): Promise<void>;
// 关停/停止路径：claim.sessionId 匹配→clearClaim→writeAttempt(outcome interrupted, needsAttention: true)→事件 delivery.exec_interrupted（锁内）
export async function resumeAutomation(workspaceId: string, key: string): Promise<WorkItemDetail>;
// 锁内：clearPaused + 事件 delivery.resumed（actor user）
```

- [ ] **Step 1: 失败测试**（mkdtemp 真 workspace 布局 + 手写 item.yaml/README/events——沿用 claim 测试直接驱动服务函数；`getWorkspace` 依赖以 workspacePath 注入缝规避：服务函数内部统一走 `resolveWorkspace(workspaceIdOrPath)` 私有助手，测试传 path。**裁定**：与 T2 读取端一致，服务函数收 `workspacePath` 而非 workspaceId；路由层做 id→path 转换）——用例：
  1. happy claim（phase→design、design.md 播种、claim 落盘、事件追加、status in_progress）
  2. 同 requestId 重放（replayed=true、revision 不动、无第二 attempt）
  3. 并发两 claim（Promise.all）只成一、另一个 Conflict
  4. 非 intake 阶段 / 无 delivery 块 / 活动claim / paused / 失败达上限 → 各自 Validation/Conflict 带 reason
  5. submit：design.md 内容与验收条件节正确、claim 清、attempt submitted、status open；digest 变化→Conflict
  6. fail blocked：status blocked；三次 fail→paused 文件+事件
  7. heartbeat 更新 lastSeenAt、他人 sessionId false
  8. recordInterruption→needsAttention attempt+claim 清
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过+tsc+lint** → **Step 5: Commit** `feat: atomic designer claim/submit/fail transaction service`

---

### Task 5: 角色授权登记 + 领取工具（tools.ts）

**Files:**
- Create: `lib/work-items/delivery-runner/role-grants.ts`
- Create: `lib/work-items/delivery-runner/tools.ts`
- Modify: `lib/workspaces/extensions.ts`（挂载门控）
- Create: `lib/work-items/delivery-runner/tools.test.mjs`（source 断言 + role-grants 单测）

**Interfaces:**
- Consumes: Task 4 claim 服务、Task 2 pool、`ExtensionAPI`/`InlineExtension`（对照 `lib/work-items/extension.ts` 的工厂写法）、`buildWorkspaceExtensions`（extensions.ts）。
- Produces:

```ts
// role-grants.ts —— 进程内单例（globalThis 守卫，HMR 安全；对照 registry 的 declare global 习语）
export interface RoleGrant { role: "designer"; workspacePath: string; ownerToken?: string; attemptId?: string }
export function grantRole(sessionId: string, grant: RoleGrant): void;
export function revokeRole(sessionId: string): void;
export function roleGrantOf(sessionId: string): RoleGrant | null;
export function setGrantToken(sessionId: string, attemptId: string, ownerToken: string): void;  // claim 成功后工具回调里调用
export function hasAnyActiveExecution(workspacePath: string): boolean;  // dispatcher 单槽位判定（T7 用）

// tools.ts
export function createDeliveryRunnerExtension(workspaceId: string, workspacePath: string): InlineExtension;
// 工具（registerTool，execute 里第一步解析身份）：
//   delivery_list_ready_tasks()        → { ready:[{key,title,priority,reasons?}], blocked:[...] }（listDesignerPool）
//   delivery_claim_task({key})         → grant（attemptId/generation/输入包=key+README+仓库清单）；成功即 setGrantToken(pi.sessionId, ...)
//   delivery_submit_result({key, designMarkdown, acceptanceCriteria:[string]}) → 提交确认 + 「等待人工确认」提示
//   delivery_fail_task({key, reason, blocked?}) → 确认
// 身份规则：const grant = roleGrantOf(pi.sessionId)；无 grant → 全部工具返回 400 文本「非角色执行会话（not a role execution session）」；
//   claim 后 submit/fail 再核对 grant.attemptId===claim.attemptId；ownerToken 从 grant 取，绝不出现在参数 schema。
```

extensions.ts 挂载（对照既有工厂注册处）：

```ts
// capabilities 含 "work-items" ∧ "workflows" 时追加：
createDeliveryRunnerExtension(workspace.id, workspace.path)
```

- [ ] **Step 1: 失败测试**——role-grants 单测（grant/revoke/setGrantToken/hasAnyActiveExecution/globalThis 幂等）+ tools source 断言（四工具名存在；「不注册 confirm/record-release/block 等动作工具」doesNotMatch；ownerToken 不在 parameters）+ extensions.ts 挂载断言。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过+tsc+lint** → **Step 5: Commit** `feat: delivery claim tools with server-bound role identity`

---

### Task 6: facade 会话选项 + designer 会话装配（role-session.ts）

**Files:**
- Modify: `lib/session-host/facade.ts`（CreateSessionInput 增可选 `appendSystemPrompt?: string`，透传 startRpcSession 的 `options.appendSystemPrompt`；`createSession` 调用处加一行透传）
- Modify: `lib/session-host/facade.test.mjs`（补 source 断言：透传存在）
- Create: `lib/work-items/delivery-runner/role-session.ts`
- Create: `lib/work-items/delivery-runner/role-session.test.mjs`

**Interfaces:**
- Consumes: Task 5 role-grants、Task 1 config（designer profile/model）、`createSession`/`sendCommand`/`destroySession`/`getRpcSession`（facade）、M1 `markRoundActive` 泛化点（见下）。
- Produces:

```ts
export const DESIGNER_CONTRACT = (task: { key: string; title: string }) => `...开场合同字符串（见 Step 3 模板：职责=把 ${task.key} 的需求梳理成设计与验收条件；硬规则=先 delivery_list_ready_tasks→delivery_claim_task 领取成功才动手；禁改宪法/AGENTS/其他工作项；写 design.md 与验收条件后 delivery_submit_result 提交即结束本轮；阻塞用 delivery_fail_task(blocked)；设计与验收的确认由人完成，你没有确认动作）...`;
export async function launchDesignerSession(opts: { workspaceId: string; workspacePath: string; task: { key: string; title: string }; config: DeliveryRunnerConfig; deps?: LaunchDeps }): Promise<string>;
// 1. createSession({ cwd: workspacePath, appendSystemPrompt: DESIGNER_CONTRACT(task), ...(config.roles.designer?.model ? { provider, modelId } : {}) })——不带 command
// 2. grantRole(sessionId, { role: "designer", workspacePath })
// 3. markDeliveryExecutionActive(sessionId, { workspacePath, key })（M1 background 泛化，见下）
// 4. sendCommand set_session_name `designer · ${task.key} · 尝试 ${generation?}`（generation 此刻未知——省略代次，命名 `designer · ${task.key}`）
// 5. sendCommand { type:"prompt", message: 开场指令 }（列出池子→领取最优先项→工作→提交；deps 全注入可测）
// 返回 sessionId；不 await 轮结束（fire-and-forget，结束钩子兜底）
// 6. 结束钩子（wrapper onDestroy + heartbeat 20s interval unref——interval 在 destroy 时清）：
//    claim 未清（readClaim(sessionId 匹配)）→ recordInterruption("session ended with active claim")；revokeRole；clearDeliveryExecutionMark
export interface LaunchDeps { createSession?; sendCommand?; destroySession?; heartbeat?: typeof heartbeatActiveClaim; record?: typeof recordInterruption; now?: () => Date }
```

M1 background 泛化（本任务内做，最小改动）：`lib/session-host/background.ts` 的 `ActiveRoundInfo` 增加 `kind?: "loop-round" | "delivery"` 与可选 `itemKey?: string`；`markRoundActive/clearRoundMark/listActiveRounds` 不改名（兼容 M1 调用），关停序列对 `kind === "delivery"` 的活动执行改写 delivery 中断（动态 import claim.recordInterruption），loop 语义不变。

- [ ] **Step 1: 失败测试**——facade 透传断言；role-session：注入假 deps 断言调用序（建会话无 command→grant→mark→命名→prompt）、结束钩子对未清 claim 记中断、heartbeat interval 注册并随 destroy 清理（fake timers 或注入）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过+tsc+lint** → **Step 5: Commit** `feat: designer role session assembly on the session host facade`

---

### Task 7: DeliveryDispatcher（dispatcher.ts + background 装配）

**Files:**
- Create: `lib/work-items/delivery-runner/dispatcher.ts`
- Create: `lib/work-items/delivery-runner/dispatcher.test.mjs`
- Modify: `lib/session-host/background.ts`（装配链第二个 HostJob + stopBackground 覆盖）

**Interfaces:**
- Consumes: Task 1–6 全部、`HostJob`（`@/lib/session-host/jobs`）、`facade.destroySession`/`probeSession`。
- Produces:

```ts
export class DeliveryDispatcher implements HostJob {
  readonly id = "delivery-dispatcher";
  constructor(deps: DispatcherDeps = {});
  start(): void; stop(): void;   // 30s tick + 首次立即（对照 LoopKitSpawner 形态；timer unref）
  async tick(): Promise<void>;
}
export interface DispatcherDeps {
  discoverWorkspaces?; readConfig?; pool?; launch?;          // 默认真实现
  activeExecution?;                                            // 默认 hasAnyActiveExecution + readClaim 扫描
  probeSession?; destroySession?; readClaim?; recordInterruption?; now?;
}
// tick 语义：遍历 discoverWorkspaces() 可用工作区 → readConfig enabled ∧ manifest capabilities 齐备 →
//   hasAnyActiveExecution(wsPath) → skip；pool.ready 空 → skip；否则 launch(workspaceId, wsPath, ready[0], config)（fire-and-forget，catch 记日志）
// 超时清道夫（同 tick 内）：对每个活动 delivery claim（listActiveRounds kind=delivery）：
//   claim.claimedAt 距 now > maxExecutionMinutes → probeSession(claim.sessionId) 仍活 → destroySession → recordInterruption("execution timeout")（结束钩子也会跑，双保险幂等）
```

background.ts 装配（`ensureHostBooted` 的 guard 链内、LoopKitSpawner 之后）：

```ts
.then(() => import("./../work-items/delivery-runner/dispatcher.ts"))  // 相对路径按实际层级
.then(({ DeliveryDispatcher }) => { const d = new DeliveryDispatcher(); d.start(); stopDeliveryDispatcher = () => d.stop(); })
```

`stopBackgroundSafely` 同时调两个 stop；`PI_TEST_NO_BACKGROUND` 同样豁免。

- [ ] **Step 1: 失败测试**——注入假 deps：无启用工作区不 launch；enabled 但已有活动执行不 launch；ready 非空且无活动 → launch 一次（且不因 ready 多条重复 launch）；超时活动 claim → destroy+中断；tick 异常不抛出（记日志）。background source 断言：装配链含 delivery-dispatcher、stop 覆盖、test 豁免。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过+tsc+lint** → **Step 5: Commit** `feat: delivery dispatcher host job with timeout reaping`

---

### Task 8: 人工控制路由与执行状态端点

**Files:**
- Create: `app/api/workspaces/[id]/work-items/[key]/delivery-execution/route.ts`（GET 状态）
- Create: `app/api/workspaces/[id]/work-items/[key]/delivery-execution/stop/route.ts`（POST 停止）
- Create: `app/api/workspaces/[id]/work-items/[key]/delivery-execution/recover/route.ts`（POST 恢复）
- Create: `app/api/workspaces/[id]/delivery/resume/route.ts`（POST 恢复自动领取，body { key }）
- Create: `lib/work-items/delivery-runner/routes.test.mjs`（source 断言）

**Interfaces:**
- Consumes: Task 3/4 服务 + `getWorkspace`、`facade.probeSession/destroySession`、M1 `detectSurvivingRoundProcesses`（`@/lib/loops/executions`）。
- Produces:
  - `GET .../delivery-execution` → `{ claim: Omit<ClaimState,"ownerTokenHash"> | null, recentAttempts: AttemptRecord[](末5), paused, pendingInterruption: boolean }`
  - `POST .../stop`：claim 存在 → probeSession 活 → destroySession → `recordInterruption("stopped by user")` → `{ok:true}`；无 claim → 404 型 NotFound。
  - `POST .../recover`（spec §5.3；**范围澄清裁定**：探测作用域=工作区根——角色会话 cwd=工作区根，与 M1 loop recover 同口径）：`detectSurvivingRoundProcesses(workspacePath)` 非空 → 409 {error, pids}（manual 也不放行）；干净 → `resolveInterruptions(itemPath, {needsAttention:false, diagnostic:{checkedAt, actor: manual?"user":undefined}})` + 事件 `delivery.exec_recovered` → `{ok:true, resolved:n}`。
  - `POST /delivery/resume` body {key}：`resumeAutomation` → detail；未暂停 → 400。

- [ ] **Step 1: source 断言失败测试**（四路径存在、stop 走 destroy+中断、recover 409 语义、resume 调服务）→ **Step 2: 确认失败** → **Step 3: 实现薄壳**（错误一律 workItemErrorResponse）→ **Step 4: 跑过+tsc+lint** → **Step 5: Commit** `feat: delivery execution control routes`

---

### Task 9: UI——详情活动执行区 + 配置区

**Files:**
- Create: `components/work-items/WorkItemExecution.tsx`（活动执行区：claim 概要/最近 attempts/会话链接/停止按钮/中断横幅+恢复/暂停横幅+恢复自动领取）
- Modify: `components/work-items/WorkItemDetailView.tsx`（挂载执行区；onStopExecution/onRecoverExecution/onResumeAutomation 回调 props，经 WorkItemsPage 透传）
- Modify: `components/work-items/WorkItemsPage.tsx`（fetch `GET .../delivery-execution` 与详情并行；回调 POST 对应路由后 invalidate + 重新拉执行状态；onOpenConversation 复用）
- Modify: `components/WorkspaceManager.tsx`（设置›工作区：capabilities 含 work-items+workflows 时显示「交付自动化」配置区——开关/designer profile 文本/预算只读；PUT `/api/workspaces/<id>/delivery`）
- Create: `components/work-items/work-item-execution.test.mjs`（source 断言）

**Interfaces:**
- Consumes: Task 8 端点、`useWorkItems`、既有 WorkItemDetailView 的 props 透传链与 inline-style 习语。
- Produces: 无新对外接口；props 命名与 DetailView 现有 onXxx 风格一致。

- [ ] **Step 1: source 断言失败测试**（执行区组件存在并被 DetailView 挂载；三个回调 POST 到正确路径；配置区在 WorkspaceManager 且 capability 门控；「停止执行」「重新检查并恢复」「恢复自动领取」文案存在）→ **Step 2: 确认失败** → **Step 3: 实现**（样式对照 T9 既有 work-items 组件；禁用态/进行中态沿用 WorkItemActionbar 的 busy 习语）→ **Step 4: 跑过+tsc+lint** → **Step 5: Commit** `feat: delivery execution panel and workspace automation config UI`

---

### Task 10: 兼容回归 + AGENTS.md + 收尾验证

**Files:**
- Modify: `AGENTS.md`（新增 delivery-runner 小节：协议/门控/配置/事件/恢复语义/File Map 条目；workflows capability 激活说明；只记已实现内容）

**Interfaces:** 无。

- [ ] **Step 1: 互不越界回归**——全量 `npm test`；grep 确认 `workspace_list_work_items` 默认排除 managed 不变、delivery 工具族不含 confirm/record-release/block/unblock/cancel。
- [ ] **Step 2: AGENTS.md 更新**（Work Items 章 + File Map + capability 表注释）。
- [ ] **Step 3: spec §11 验证清单逐项走查**（1–8 静态/单测已覆盖项 + 端到端演示留给 controller 冒烟）。
- [ ] **Step 4: 最终回归** `npm test && node_modules/.bin/tsc --noEmit && npm run lint` → **Step 5: Commit** `docs: update AGENTS.md baseline for delivery automation`

---

## 自审记录（写计划时已核对）

- Spec 覆盖：§4 模块表 → T1(config)/T2(pool)/T3(attempts)/T4(claim)/T5(tools+grants)/T6(role-session)/T7(dispatcher)；§5.1→T2、§5.2→T4、§5.3→T3/T4(recordInterruption)/T6(结束钩子)/T7(超时)/T8(recover)；§6→T6/T7；§7→T5；§8→T1/T8；§9→T9；§10→T5/T10；§11 清单→各任务测试步骤 + T10 汇总。
- 类型一致：`ClaimState/AttemptRecord`（T3）→ T4/T7/T8/T9；`claimDesignerTask/submitDesignerResult/failDesignerTask/heartbeatActiveClaim/recordInterruption/resumeAutomation`（T4）→ T5/T6/T7/T8；`grantRole/roleGrantOf/setGrantToken/hasAnyActiveExecution`（T5）→ T6/T7；`launchDesignerSession`（T6）→ T7；`listDesignerPool/projectDesignerPool`（T2）→ T5/T7。
- 两处澄清裁定（执行时按此，不再问）：(a) recover 探测作用域=工作区根（spec「工作项目录」笔误——角色会话 cwd 为工作区根）；(b) claim/submit 服务函数收 workspacePath（测试缝），路由层做 id→path。
- 已知留待后续阶段（spec §2/§12）：developer/verifier/release-preparer、worktree、验证命令自动化、多槽位。
