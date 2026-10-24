# 第五阶段：release-preparer 角色与发布材料自动起草实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 release-preparer 作为第四角色扩入既有领取协议：验证通过后自动领取，起草发布说明与回滚办法写入 delivery.releasePlan（M2 prepare-release 语义，actor=agent），项停 release_ready 等人 record-release。

**Architecture:** 全部落在 `lib/work-items/delivery-runner/` 既有模块的最小增量（pool 增第四谓词、claim 增三函数——无环境预建、tools 的 submit 增第四扁平形状、合同增一、UI 徽标/摘要）。无新工具、无配置键、无执行环境。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent 0.84.4（原样）、node:test + jiti。

**Spec:** `docs/superpowers/specs/2026-10-25-phase-five-release-preparer-design.md`（用户站立授权「继续直到全部做完」）。

## Global Constraints

- 不修改 `@earendil-works/pi-*` 任何源码或依赖版本。
- **record-release 永远 actor=user**；release-preparer 只写 delivery.releasePlan，不发布、不登记、不合并推送、不触任何发布执行。
- 人工 prepare-release 路由不动（可覆盖自动材料）；工具面**仍恰五件**（无新工具）。
- candidateDigest 三重绑定：谓词（verification.candidateDigest === candidatesDigest(当前候选)）→ claim 快照 → 提交复验（漂移 409）。
- 纯只读角色：无 worktree/checkout、无配置键；notes 必填 rollback 可选（M2 形状）。
- 单槽位四角色；失败预算跨角色共享；conversationId 自链接四角色齐。
- phase 语义：claim/submit/fail/中断全部**不改 phase**（release_ready 是等待人的阶段；give-back from=to 零变化）。
- 验证只跑 `node --test`、`node_modules/.bin/tsc --noEmit`、`npm run lint` 与必要手测；**绝不运行 `next build`**。
- 每任务以可运行测试结尾并提交；conventional 前缀提交。

---

### Task 1: 池谓词 + claim 事务（release-preparer 三函数）

**Files:**
- Modify: `lib/work-items/delivery-runner/pool.ts`（DeliveryRole 增 `"release-preparer"`；谓词）
- Modify: `lib/work-items/delivery-runner/pool.test.mjs`
- Modify: `lib/work-items/delivery-runner/attempts.ts`（AttemptRecord 增可选 `releasePlan?: {notes: string; rollback?: string}`；ClaimState 复用既有 candidateDigest 字段）
- Modify: `lib/work-items/delivery-runner/claim.ts`（三函数 + requireActiveClaim 的 expectedRole 类型放宽 + recordInterruption 的 role 分支增 release-preparer（from=to 零变化））
- Modify: `lib/work-items/delivery-runner/claim.test.mjs`

**Interfaces:**
- Consumes: 既有事务基建、`candidatesDigest`（delivery-types）、`DeliveryVerificationRecord.candidateDigest`（delivery-types）。
- Produces（T2 消费）:

```ts
// pool.ts：谓词（binding，spec §2）：共享条件 ∧ phase==="release_ready" ∧ item.delivery.verification 存在
//   ∧ verification.candidateDigest === candidatesDigest(item.delivery.candidates ?? [])（候选未换——纯函数内直接比对，items 参数已带 delivery 块）
// claim.ts
export interface ReleasePreparerClaimInput { workspacePath: string; key: string; sessionId: string; requestId: string }
export async function claimReleasePreparerTask(input: ReleasePreparerClaimInput): Promise<{ grant: ClaimGrant; replayed: boolean }>;
// 锁内复验 → 无环境预建 → phase 不变、status in_progress、generation+1、claim.json（role="release-preparer" + candidateDigest 快照同 verifier 先例）→ delivery.claimed → commit
export interface ReleasePreparerSubmitInput { workspacePath: string; key: string; attemptId: string; generation: number; ownerToken: string; releaseNotes: string; rollbackNotes?: string; conversationId?: string }
export async function submitReleasePreparerResult(input: ReleasePreparerSubmitInput): Promise<WorkItemDetail>;
// 三凭据（expectedRole="release-preparer"）+ candidateDigest 复验（漂移 409）+ cancel 守卫 →
//   delivery.releasePlan = {notes: releaseNotes, ...(rollbackNotes?.trim() ? {rollback: rollbackNotes.trim()} : {})}、
//   phase 保持 release_ready、status→open、revision+1 → 事件 delivery.submitted（actor agent，data {attemptId, generation, outcome:"release-plan"}）→
//   attempt submitted（releasePlan 拷贝）→ conversationId 自链接（designer 先例）→ commit
export interface ReleasePreparerFailInput { workspacePath: string; key: string; attemptId: string; generation: number; ownerToken: string; reason: string; blocked?: boolean }
export async function failReleasePreparerTask(input: ReleasePreparerFailInput): Promise<WorkItemDetail>;
// 标准骨架；phase 回退守卫：release_ready→release_ready（不动）
```

- [ ] **Step 1: 失败测试**——谓词全分支（phase/release_ready、verification 缺失、candidateDigest 不匹配（候选被换）、共享条件）+ 四角色排序回归 + 三角色谓词零变化；事务：happy claim（phase 不变/candidateDigest 落盘）/幂等/并发/submit（releasePlan 写入/phase 保持/status open/自链接/attempt.releasePlan）/候选被换 409/notes 空 400/fail blocked/中断 give-back 零阶段变化。**Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过+tsc+lint+全量** → **Step 5: Commit** `feat: release-preparer pool predicate and claim transactions`

---

### Task 2: submit 第四形状 + 合同 + 分派 + UI 摘要

**Files:**
- Modify: `lib/work-items/delivery-runner/tools.ts`（submit 增 release_notes/rollback_notes 可选字段；role=release-preparer 分派 + notes 必填校验；工具描述更新四角色）
- Modify: `lib/work-items/delivery-runner/role-session.ts`（buildRoleContract 增 release-preparer——合同要点按 spec §3；会话命名 `release-preparer · <KEY>`）
- Modify: `components/work-items/WorkItemExecution.tsx`（ExecutionRole 增 "release-preparer"；attempt releasePlan 摘要展示——notes 首行 + rollback 有无标记）
- Modify: `lib/work-items/delivery-runner/tools.test.mjs`（+role-session/execution 断言）

**Interfaces:**
- Consumes: Task 1 三函数。
- Produces: 无新对外接口。工具面恰五件断言不变（submit 形状扩展不新增注册）；dispatcher 零改动（role 分派已泛化——DeliveryRole 扩值自动流过，验证性断言即可）。

- [ ] **Step 1: 失败测试**——submit 分派（release-preparer grant → submitReleasePreparerResult；缺 notes 400）；合同内容断言（不发布不登记/只读/材料由验证证据支撑/submit 即结束）；RoleBadge 与 releasePlan 摘要渲染；dispatcher 对 release-preparer ready 项分派（合并池测试）。**Step 2–4 同前** → **Step 5: Commit** `feat: release-preparer submit shape, contract and panel display`

---

### Task 3: AGENTS.md、回归与收尾

**Files:**
- Modify: `AGENTS.md`（Delivery 自动执行小节：四角色完整流水线（designer→developer→verifier→release-preparer + 双人工门 confirm-design/record-release）；release-preparer 语义（纯只读/prepare-release 语义 actor=agent/人可覆盖/releasePlan 溯源）；File Map 无新文件；已知边角不变）

- [ ] **Step 1: AGENTS.md 更新** → **Step 2: 互不越界回归**（全量 npm test；grep 工具族恰五件、无 record-release/发布类 agent 入口）→ **Step 3: spec §4 静态勾验** → **Step 4: 最终回归** → **Step 5: Commit** `docs: update AGENTS.md baseline for the release-preparer role`

---

## 自审记录（写计划时已核对）

- Spec 覆盖：§2→T1；§3→T2（工具/合同/UI）；§4→T1/T2 测试 + T3 汇总；§5 默认选择逐条入 binding。
- 类型一致：三函数（T1）→ T2 分派；`DeliveryRole` 四值全链；AttemptRecord.releasePlan（T1）→ T2 UI。
- 取舍：谓词+事务并 T1（无新基建、审查面连续）；无 config 任务（零配置变更）。
- 端到端冒烟（spec §4.4 五角色全流水线 + record-release → released）归 controller（重启 dev server 后）。
