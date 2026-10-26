# 终局第三步：reviewer 角色 + checks 系统化 + verifier 退役 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「先审后跑」接回流水线：新角色 **reviewer** 在 verification 阶段评审候选 diff 并提交 pass / rework(code|spec)；**checks 变成引擎的 system 步**（不再消耗 LLM 会话），在冻结候选上逐条跑并结算（全绿 → release_ready；任一 failed → rework(code)；任一 unverified → blocked 待人修环境）；**verifier 退役**（旧记录仍可读）。工具面仍恰六件（`delivery_run_check` 身份门改为 reviewer）。

**Architecture:** 角色词表 4 活 + 1 legacy；config v2 增 `stages.review`；`delivery.review` 记录；claim.ts 增 reviewer 三事务、删 verifier 三事务、抽共享 `reworkTransition` 与 `finalizeChecks`；新 `checks-step.ts`（due 谓词 + 执行器，system claim 占槽）；dispatcher 在 LLM 派发前跑 system 步；tools 分支改；模板增 reviewer；UI 三处。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent（原样）、node:test + jiti、TypeBox。

**Spec:** `docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md` §5.1 / §5.3（含「第三步落地决策」修订记录）/ §6.2（reviewer 模板）/ §7 / §12（verifier 退役、reviewer 第五角色）/ §11 第 3 步。用户站立授权「继续处理，直到全部做完」（2026-10-26）。

## Global Constraints

- 不修改 `@earendil-works/pi-*`；**绝不 `next build`**；验证只跑 `node --test`、`tsc --noEmit`、`npm run lint`。
- **工具面恰六件**（list / claim / submit / fail / ask / run_check）；工具参数禁 union / any-of；人工动作永不做 LLM 工具。
- **verifier 永不再派发**：`DELIVERY_ROLES` 不含它；池不投影它；`roles.verifier` 配置键接受并忽略（warn 一次）；旧 attempt / claim / seeding 记录中的 `"verifier"` 必须仍可读（`AnyDeliveryRole`）。
- **checks 结果与 review 裁定不计失败预算**（verifier 先例）；**不加运行态文件**——system 步用 `role: "system"` 的 claim.json 占槽。
- **返工过渡单一实现**：reviewer rework(code) / checks failed / 原 verifier 失败路径 共用 `reworkTransition(item, "implementation")`；rework(spec) 与人工 `rework target=design` 共用 `reworkTransition(item, "design")`——不许出现第二份清下游证据的代码。
- `events.jsonl` 只追加；`expectedRevision` 乐观并发；conversationId 自链接（reviewer submit/fail/ask 透传 sessionId）。
- 范围守恒：`role-grants.ts`、`role-session.ts`（除 `AnyDeliveryRole` 类型若需）、`attention.ts`、`worktrees.ts` 不改逻辑；`checks.ts` 只读复用。
- 每任务以可运行测试结尾并提交；conventional 前缀；只暂存任务文件（工作树含用户 WIP：`components/WorkspaceManager.tsx`、`components/work-items/WorkItemsPage.tsx`、`AGENTS.md`、`docs/reference/*`、`docs/architecture.md` 编辑不提交）。

### 本计划引入的默认选择（请用户复核）

1. `stages.review.enabled` 缺省 **false**（v1/现状语义等价：candidates 一提交即由 system 步跑 checks）。
2. unverified（命令无法执行）→ `status: "blocked"` + 事件；人 unblock 后 system 步自动再 due——不自动重试、不进预算。
3. system claim 的 `sessionId = "system:<ulid>"`；超时由既有清道夫按 `budget.maxExecutionMinutes` 处理（checks 总时长超过该上限会被打断并记中断——工作区应按 checks 实际时长调大上限；文档注明）。
4. reviewer 的 `delivery_run_check` 结果写入其 claim 的 `checkResults`（与原 verifier 同）仅作评审佐证，**不**成为 `delivery.verification`——权威记录只由 system 步写。
5. 旧 `delivery_submit_result` verifier 形状（只需 key）删除；reviewer 形状 `{key, outcome, source?, notes}`。

---

### Task 1: 角色词表退役 + 配置 stages.review + review 记录类型

**Files:**
- Modify: `lib/work-items/delivery-runner/roles.ts`（`DELIVERY_ROLES` 四活值 `["designer","developer","reviewer","release-preparer"]`；`LEGACY_DELIVERY_ROLES = ["verifier"] as const`；`type LegacyDeliveryRole`、`type AnyDeliveryRole = DeliveryRole | LegacyDeliveryRole`；`isDeliveryRole`（活）与 `isAnyDeliveryRole`）
- Modify: `lib/work-items/delivery-runner/config.ts`（`stages?: { review?: { enabled: boolean } }` 解析：缺省 `{ review: { enabled: false } }`（解析后必有）；`roles` 遍历：键 `verifier` → 跳过 + `console.warn` 一次（模块级 once 标记）；其余词表外键仍 Validation）
- Modify: `lib/work-items/delivery-runner/config.test.mjs`
- Modify: `lib/work-items/delivery-types.ts`（`DeliveryReviewRecord { outcome: "pass"|"rework"; source?: "code"|"spec"; notes: string; candidateDigest: string; at: string; attemptId: string }`；`DeliveryMetadata.review?`；`parseDelivery` 校验：rework 必带 source、pass 不得带 source；`DeliveryClarification.role` 改 `AnyDeliveryRole`）
- Modify: `lib/work-items/delivery-types.test.mjs`
- Modify: `lib/work-items/delivery-runner/attempts.ts`（`AttemptRecord.role` / `ClaimState.role` 类型 → `AnyDeliveryRole | "system"`；读旧 verifier 记录零变化）
- Modify: `lib/work-items/delivery-runner/attempts.test.mjs`
- Modify: `lib/work-items/delivery-runner/roles.test.mjs`（若无则新建）

- [ ] **Step 1: 失败测试**——roles：四活值、legacy 含 verifier、`isDeliveryRole("verifier") === false`、`isAnyDeliveryRole("verifier") === true`；config：`stages` 缺 → `{review:{enabled:false}}`；`stages.review.enabled` 非布尔 → Validation；`roles.verifier` → 不抛、不入 roles、warn 一次（第二次解析不再 warn）；`roles.desginer` 仍 Validation；round-trip 保 stages；delivery-types：review 记录透传、rework 缺 source → Validation、pass 带 source → Validation、clarification role 为 verifier（旧数据）仍解析；attempts：role `"verifier"` / `"system"` 的记录读写不抛。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: retire verifier role, add reviewer vocabulary, stages.review config and review record`

---

### Task 2: reviewer 三事务 + 共享返工过渡 + 池谓词（reviewer 进 / verifier 出）

**Files:**
- Modify: `lib/work-items/delivery-runner/claim.ts`（新 `reworkTransition(next: WorkItemRecord, target: "implementation"|"design")`——从 `submitVerifierResult` 失败路径与 `delivery.ts` rework case 抽出的**唯一**清下游证据实现（delivery.ts 的 case 改为调用它或同一 helper 搬到 `delivery-types.ts`/`delivery.ts` 并被 claim.ts 导入——择一，无第二副本）；新 `claimReviewerTask` / `submitReviewerResult` / `failReviewerTask`；**删除** `claimVerifierTask` / `submitVerifierResult` / `failVerifierTask`（其结算核心抽成 `finalizeChecks(current, claim, results, actor)` 供 T3 的 system 步调用；`recordCheckResult` 保留，身份由调用方守卫））
- Modify: `lib/work-items/delivery-runner/claim.test.mjs`
- Modify: `lib/work-items/delivery.ts`（rework case 改用共享 helper）
- Modify: `lib/work-items/delivery.test.mjs`（rework 行为零变化回归）
- Modify: `lib/work-items/delivery-runner/pool.ts`（删 verifier 谓词；加 reviewer 谓词：`stages.review.enabled` ∧ phase verification ∧ candidates ∧ 无 review 或 digest 不符 ∧ 共用门；reason 词表增 `review-disabled`、`review-done`；`PoolContext` 带 `reviewEnabled`）
- Modify: `lib/work-items/delivery-runner/pool.test.mjs`

**Interfaces:**

```ts
export interface ReviewerClaimInput { workspacePath; key; sessionId; requestId }
export async function claimReviewerTask(input): Promise<{ grant: ClaimGrant; replayed: boolean }>;
// 锁内复验谓词 → prepareVerifyCheckouts（只读候选 checkout）→ claim.json {role:"reviewer", candidateDigest, worktrees, checkContexts} → status in_progress → delivery.claimed → commit
export interface ReviewerSubmitInput { workspacePath; key; attemptId; generation; ownerToken; outcome: "pass"|"rework"; source?: "code"|"spec"; notes: string; conversationId? }
export async function submitReviewerResult(input): Promise<WorkItemDetail>;
// 三凭据（expectedRole reviewer）+ candidateDigest 复验（漂移 409）+ 阶段守卫 verification → delivery.review 写入 → pass: phase 不变、status open；rework: reworkTransition(next, source==="spec" ? "design" : "implementation") → 事件 delivery.reviewed {outcome, source?, candidateDigest} → attempt submitted（携 review）→ 自链接 → 清 claim → commit。不写 failure-window。
export async function failReviewerTask(input: FailInput & {…}): Promise<WorkItemDetail>;   // 标准：phase 不变
export function reworkTransition(next: WorkItemRecord, target: "implementation"|"design"): void;  // 单一实现
export async function finalizeChecks(ctx: { workspacePath; current: WorkItemDetail; claim: ClaimState; actor: "agent"|"system" }): Promise<{ outcome: "verified"|"rework"|"unverified" }>;  // T3 消费
```

- [ ] **Step 1: 失败测试**——reviewer claim（谓词全分支：review 关闭不可领、无候选、已有同 digest review、digest 变化可再领；checkout 预建；candidateDigest 冻结）；submit pass（review 写入、phase 仍 verification、status open、claim 清、事件、自链接、不计预算）；submit rework code → ready_for_implementation + 下游清空（与原 verifier 失败路径逐字同形的断言）；rework spec → design；rework 缺 source → 400；digest 漂移 → 409；fail 标准；`reworkTransition` 被 delivery.ts rework case 与 claim 共用（源断言 + 行为回归）；pool：reviewer 谓词各分支、verifier 不再投影（任何阶段）。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: reviewer claim transactions, shared rework transition and pool predicate; retire verifier transactions`

---

### Task 3: system checks 步 + dispatcher 接入

**Files:**
- Create: `lib/work-items/delivery-runner/checks-step.ts`
- Create: `lib/work-items/delivery-runner/checks-step.test.mjs`
- Modify: `lib/work-items/delivery-runner/dispatcher.ts`（`tickWorkspace`：reap → **runChecksStep**（首个 due 项，fire-and-forget，catch 记日志）→ dispatch → attend；deps 注入 `checksDue` / `runChecksStep`）
- Modify: `lib/work-items/delivery-runner/dispatcher.test.mjs`
- Modify: `lib/work-items/delivery-runner/claim.ts`（如需：`finalizeChecks` 的 system actor 分支、system claim 写入 helper `writeSystemClaim`）

**Interfaces:**

```ts
export function checksDue(item: DeliveryPoolItem-like, ctx): { due: boolean; reasons: string[] };
// due ⇔ managed ∧ enabled ∧ phase verification ∧ candidates 非空 ∧ checks 非空 ∧ (!reviewEnabled ∨ (review?.outcome==="pass" ∧ review.candidateDigest===当前))
//        ∧ (无 verification ∨ verification.candidateDigest≠当前) ∧ 无 claim ∧ 无中断 ∧ 未 paused
export async function runChecksStep(workspacePath: string, key: string, deps?): Promise<"verified"|"rework"|"unverified"|"skipped">;
// 锁内：复验 due → 写 system claim {role:"system", sessionId:"system:<ulid>", attemptId, generation+1, candidateDigest, checkContexts(冻结 config.verification.checks), worktrees: prepareVerifyCheckouts} → status in_progress → delivery.checks_started → commit
// 锁外：逐条 runConfiguredCheck → recordCheckResult（心跳习语）
// 锁内：finalizeChecks(actor "system") → verified: verification 记录 + release_ready + delivery.checks_passed；rework: reworkTransition("implementation") + delivery.checks_failed；unverified: status blocked + delivery.checks_unverified；三者均清 claim、写 attempt（role system, outcome submitted/failed? → 用 outcome "submitted" + verificationOutcome 字段，与原 verifier attempt 同形）→ commit
// 任何异常：清 claim + recordInterruption("checks step failed") → 抛给 dispatcher 记日志
```

- [ ] **Step 1: 失败测试**——`checksDue` 全分支（review 关闭 / 开启且 pass / 开启未审 / digest 变化 / 无 checks / 已有同 digest verification / 共用门）；`runChecksStep` 在真临时工作区 + 真 git 仓（候选 commit）：全 passed → verification 记录（actor system、命令取自冻结快照）+ release_ready + 事件；一条 failed → ready_for_implementation + 下游清空 + 事件；一条 unverified（命令不存在）→ blocked + 事件；执行期间池 `active-claim`；完成后 claim 清；attempt 落盘 role system；异常路径记中断；不写 failure-window。dispatcher：有 due 项 → 调 runChecksStep 且**不**调 launch（占槽）；无 due → 原路径；runChecksStep 抛 → tick 不中断。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: system checks step with system claim and dispatcher integration`

---

### Task 4: 工具分支 + reviewer 模板 + 角色摘要

**Files:**
- Modify: `lib/work-items/delivery-runner/tools.ts`（claim/submit/fail 的 verifier 分支 → reviewer；submit 第三形状 `{key, outcome, source?, notes}`（扁平可选字段，无 union）；`delivery_run_check` 身份门 `gate.role === "reviewer"`；描述文案更新为四角色 + system 步说明）
- Modify: `lib/work-items/delivery-runner/tools.test.mjs`（六件钉不变；verifier 分派测试删；reviewer 分派 + run_check 门测试加；no-union 守卫续绿）
- Modify: `lib/work-items/delivery-runner/role-templates.ts`（`ROLE_PROFILE_TEMPLATES` 四键：删 verifier 模板、加 reviewer 模板——先审后跑三层：SPEC/design.md 合规 / README 原始验收核对 / 代码质量；rework 条目格式 `file:line 问题 期望 [源头: code|spec]`；可用 `delivery_run_check` 跑针对性检查作佐证但全量由系统跑；submit `{outcome, source?, notes}`；`ROLE_TEMPLATE_VERSION` → 2）
- Modify: `lib/work-items/delivery-runner/role-templates.test.mjs`（守卫 regex 续；seeding：旧记录含 verifier、无 reviewer → 只写 reviewer）
- Modify: `lib/work-items/delivery-runner/role-preview.ts` / `role-preview.test.mjs`（四角色自动随 DELIVERY_ROLES；测试更新角色名）
- Modify: `lib/work-items/delivery-runner/role-session.test.mjs`（四角色 identity 测试的角色列表更新）

- [ ] **Step 1: 失败测试**——tools：reviewer claim/submit(pass|rework)/fail 分派；submit rework 缺 source → 400；run_check 对 reviewer 放行、对 designer/developer/release-preparer 拒绝；六件钉；verifier 字样不再出现在分派代码（源断言）。templates：四键为新词表；reviewer 正文含三层审与 rework 条目格式；守卫 regex 不命中；seeding 对「记录含 verifier@1、文件齐、无 reviewer」的工作区 → written [reviewer]。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: reviewer tool dispatch, run_check gate, reviewer template and role summaries`

---

### Task 5: UI + 文档三层

**Files:**
- Modify: `components/work-items/WorkItemExecution.tsx`（claim role `"system"` → 徽标「系统检查」；attempt role 显示原文含 legacy verifier；review 结果徽章 pass/rework(source)）
- Modify: `components/work-items/WorkItemDetailView.tsx`（review 记录块：结论 / 源头 / 意见 / 时间 / 候选摘要——HEAD 干净可提交）
- Modify: `components/WorkspaceManager.tsx`（交付块增「评审阶段」开关 → `stages.review.enabled`；角色表随词表四行——**用户 WIP，编辑不提交**）
- Modify: `components/work-items/work-item-execution.test.mjs` 等既有测试同步（若用户 WIP 则编辑不提交）
- Modify: `AGENTS.md`（规则：verifier 退役、checks 是 system 步且唯一机器证据、reviewer 裁定与 checks 结果不计预算、返工过渡单一实现 `reworkTransition`——编辑不提交）
- Modify: `docs/reference/work-items.md` / `file-map.md` / `architecture.md`（编辑不提交）

- [ ] **Step 1: 测试/手测**——执行卡 system 徽标与 checkResults；review 块渲染三态；设置开关 round-trip；文档 grep：`verifier` 仅出现在 legacy 说明处。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: review record and system-checks display with stages.review setting`

---

## 端到端冒烟（controller，dev server + jiti 驱动 dispatcher；真 git 仓）

1. smoke 工作区内建最小 git 仓并提交；配置 checks `[{name: ok, command: "true"}]`；项写到 phase verification + candidates（真 sha）；review 关闭 → 一拍 → verification 记录 + release_ready + `delivery.checks_passed`；期间池 active-claim；claim 清。
2. 改 checks 命令为 `false` + 新候选 → 一拍 → ready_for_implementation + `delivery.checks_failed`。
3. 命令为不存在的可执行 → blocked + `delivery.checks_unverified`；unblock → 再 due。
4. review 开启 → 项不 due（await review）；池 reviewer ready；手写 review pass → 下一拍 due。
5. `roles.verifier` 配置文件 GET 不 400；角色摘要四行含 reviewer。

## 自审记录

- Spec 覆盖：§5.1 执行视图（review 可选 / checks system）→ T2/T3；§5.3 全部落地决策 → T1–T4；§6.2 reviewer 模板 → T4；§12 verifier 退役 → T1/T2/T4。
- 已核事实：`submitVerifierResult` 失败路径 = ready_for_implementation + 清 designConfirmed/candidates/verification/releasePlan，与 `delivery.ts` rework case 同构（两份副本 → 本计划合一）；`prepareVerifyCheckouts` / `runConfiguredCheck` / `recordCheckResult` 可复用；池 `active-claim` 来自 `readClaim` 非空（system claim 自然占槽）；清道夫按 `claim.claimedAt` + `maxExecutionMinutes` 定向 destroy——system claim 无 session，`probeSession` 返回 null 即跳过 destroy 只记中断（既有分支）。
- 未做：integrate / acceptance（第四步）；digest/巡逻（第五步）。
