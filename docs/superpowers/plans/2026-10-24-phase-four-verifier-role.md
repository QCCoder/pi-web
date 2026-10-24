# 第四阶段：verifier 角色与验证命令自动化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 verifier 角色扩入既有领取协议：developer 提交候选后自动领取，在候选 commit 的独立 detached checkout 上执行人配置的验证命令，服务端产出结构化执行证据，全过推进 release_ready、失败按 M2 rework 语义回开发携带证据。

**Architecture:** 全部落在 `lib/work-items/delivery-runner/` 既有模块（config 增 verification.checks、pool 增 verifier 谓词、worktrees 增候选 checkout、新 checks 执行器、claim 增 verifier 三函数、tools 增 run_check、合同/调度三角色化）+ UI 增量。执行证据服务端产（spawnSync + 日志落盘），LLM 只能触发已配置检查、读结果，不能编造。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent 0.84.4（原样依赖）、git worktree（detached）、node:test + jiti。

**Spec:** `docs/superpowers/specs/2026-10-24-phase-four-verifier-role-design.md`（用户已批准，§10.2 取自动推进版）。

## Global Constraints

- 不修改 `@earendil-works/pi-*` 任何源码或依赖版本。
- 验证命令是人维护的配置（`.pi/delivery.yaml` verification.checks），agent 不能自造/改写命令；**LLM 自述不构成证据**——检查结果只能来自服务端 runConfiguredCheck 的记录（claim 内累积、submit 整体取用）。
- 执行环境 = 候选 commit 的 detached checkout（`pi-verify/<KEY>/gen<N>`），不重用开发 worktree；不自动清理。
- exitCode 0=passed / 非 0=failed / 超时或启动失败=unverified；存在 unverified 不推进（blocked）。
- verifier 提交：全过→M2 record-verification 语义（actor=agent，candidateDigest 绑定）→release_ready；有 failed→M2 rework 语义回 ready_for_implementation（清下游证据、反馈附检查结果）。
- 人工 record-verification/rework 路由不动；confirm-design/record-release 永远 actor=user；工具面不新增任何人工动作入口。
- candidateDigest 领取快照 + 提交复验（候选被换→409）；失败预算跨三角色共享（同 digest）；单槽位三角色。
- 无配置 checks = verifier 不可领（reason `no-checks-configured`）。
- 命令超时默认 600s（timeout_seconds 可配 1–3600）；检查顺序执行；日志尾部 64KB 截断落 `<item>/delivery/artifacts/verification-logs/<attemptId>/<name>.log`（tmp+rename，有意入库）。
- 验证只跑 `node --test`、`node_modules/.bin/tsc --noEmit`、`npm run lint` 与必要手测；**绝不运行 `next build`**。
- 每任务以可运行测试结尾并提交；conventional 前缀提交。

---

### Task 1: 配置 verification.checks + 池 verifier 谓词

**Files:**
- Modify: `lib/work-items/delivery-runner/config.ts`（+`DeliveryCheckConfig`/parse；`DeliveryRunnerConfig` 增 `verification?: { checks: DeliveryCheckConfig[] }`）
- Modify: `lib/work-items/delivery-runner/config.test.mjs`
- Modify: `lib/work-items/delivery-runner/pool.ts`（DeliveryRole 增 "verifier"；verifier 谓词 + 新 reason）
- Modify: `lib/work-items/delivery-runner/pool.test.mjs`

**Interfaces:**
- Consumes: 既有 parseDeliveryRunnerConfig/projectDeliveryPool/listDeliveryPool。
- Produces:

```ts
// config.ts
export interface DeliveryCheckConfig { name: string; repositoryId?: string; command: string; timeout_seconds?: number }
// parse：verification 可选缺省 undefined（=无配置）；checks 数组逐条校验 name/command 非空串、timeout 1–3600 整数；空数组=合法（等同无配置，池按空处理）
// pool.ts
export type DeliveryRole = "designer" | "developer" | "verifier";
export type DeliveryPoolReason = ... | "no-checks-configured";  // 新值
// verifier 谓词（spec §3，binding）：共享条件 ∧ phase==="verification" ∧ candidates 非空 ∧ designConfirmed 真值
//   ∧ (config.verification?.checks?.length ?? 0) > 0（否则 no-checks-configured）
//   ∧ 每 check.repositoryId（缺省=候选首仓）∈ 候选仓集合 ∧ manifest 登记 active（否则 repo-not-registered）
// PoolEntry.role 相应扩展；读取端装配 checks 与候选仓集合（claim.ts 复验同源——本任务只做池侧）
```

- [ ] **Step 1: 失败测试**——config：无键=undefined、空数组、逐条校验、timeout 边界；pool：verifier 全分支（phase 验证/无候选/designConfirmed 缺/无配置/repo 未登记/共享条件）、三角色合并排序回归、designer/developer 谓词零变化。**Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过+tsc+lint+全量** → **Step 5: Commit** `feat: verifier pool predicate and verification check config`

---

### Task 2: 候选 checkout 与服务端执行器（checks.ts）

**Files:**
- Create: `lib/work-items/delivery-runner/checks.ts`
- Create: `lib/work-items/delivery-runner/checks.test.mjs`
- Modify: `lib/work-items/delivery-runner/worktrees.ts`（导出 `prepareVerifyCheckouts`）

**Interfaces:**
- Consumes: `lib/worktree.ts` 的 addWorktree/listWorktrees（读实现确认 detached 支持——无则 addWorktree+`git checkout --detach` 两步）、`DeliveryCheckConfig`、`RoleWorktree`。
- Produces:

```ts
// worktrees.ts
export async function prepareVerifyCheckouts(workspacePath: string, item: { key: string }, candidates: Array<{repositoryId: string; commit: string}>, generation: number, repoPaths: Map<string, string>, deps?: {...}): Promise<RoleWorktree[]>;
// 每候选仓：worktree 目录名 pi-verify-<KEY>-gen<N>（仓旁 <repo>-worktrees/），检出到该仓候选 commit（detached）；
// 幂等（已存在即复用——不再校验其 HEAD，gen 单调保证新代新目录）；单仓失败整体抛（claim 前置零状态）
// checks.ts
export interface CheckEvidence { name: string; exitCode: number | null; durationMs: number; logRef: string; outcome: "passed" | "failed" | "unverified" }
export function runConfiguredCheck(check: DeliveryCheckConfig, worktreePath: string, logDir: string, deps?: { spawnSync?: typeof spawnSync; now?: () => number }): CheckEvidence;
// spawnSync(check.command, { cwd: worktreePath, shell: "/bin/sh", timeout: (check.timeout_seconds ?? 600) * 1000, env: process.env, maxBuffer 1MB })
// outcome：正常退出 exitCode===0→passed / 非0→failed；error（ETIMEDOUT/ENOENT 等）→unverified+exitCode null
// 日志：stdout+stderr 各取尾部 32KB 合并（总 64KB）写 <logDir>/<safe(name)>.log（tmp+rename，目录 mkdir -p）；logRef=相对 item 的 POSIX 路径
export function safeCheckName(name: string): string;  // 文件名安全化（非 [\w.-] → _）
```

- [ ] **Step 1: 失败测试**——真 git 仓 + 真命令：`exit 0`/`exit 1`/超时（`sleep 5` + timeout 1）/不存在命令 → 四种 outcome；日志内容与截断（生成 >64KB 输出验证尾部保留）；prepareVerifyCheckouts 幂等/detached HEAD 在候选 commit/失败零状态（注入假 addWorktree）。**Step 2–4 同前** → **Step 5: Commit** `feat: verify checkouts and server-side check executor`

---

### Task 3: claim 事务 verifier 三函数

**Files:**
- Modify: `lib/work-items/delivery-runner/attempts.ts`（ClaimState 增 `candidateDigest?: string`、`checkResults?: CheckEvidence[]`；AttemptRecord 增 `verificationOutcome?: "verified" | "rework"`；类型透传）
- Modify: `lib/work-items/delivery-runner/claim.ts`
- Modify: `lib/work-items/delivery-runner/claim.test.mjs`

**Interfaces:**
- Consumes: Task 1 谓词、Task 2 prepareVerifyCheckouts/CheckEvidence、既有事务基建、M2 `candidatesDigest`（delivery-types）。
- Produces:

```ts
export interface VerifierClaimInput { workspacePath: string; key: string; sessionId: string; requestId: string }
export async function claimVerifierTask(input: VerifierClaimInput): Promise<{ grant: ClaimGrant; replayed: boolean }>;
// 锁内复验 verifier 谓词 → prepareVerifyCheckouts（状态落盘前，失败零状态）→ phase 不变（verification）、status in_progress、
// generation+1、claim.json（role=verifier + candidateDigest=candidatesDigest(当前候选) + worktrees + checkResults: []）→ delivery.claimed → commit
export interface VerifierSubmitInput { workspacePath: string; key: string; attemptId: string; generation: number; ownerToken: string; notes?: string }
export async function submitVerifierResult(input: VerifierSubmitInput): Promise<WorkItemDetail>;
// 锁内三凭据（expectedRole=verifier）∧ candidateDigest 复验（漂移→409）∧ cancel 守卫（requireActiveClaim 内已有）∧
//   checkResults 完整性：配置 checks 每名恰有一条记录（缺→Validation "check <name> not run"；LLM 不能凭空补）：
//   有 unverified → status=blocked（不推进，fail 语义提示）；
//   有 failed → M2 rework 同构：清 designConfirmed/candidates/verification/releasePlan + phase→ready_for_implementation + status→open
//     + 事件 delivery.rework_suggested（actor=agent，reason="verification-failed"，data.checks=失败条目摘要+logRef）+ attempt(verificationOutcome:"rework")；
//   全 passed → delivery.verification={at, actor:"agent", requirementDigest, candidateDigest, checks:[{name, outcome:"passed", evidence}]}}
//     + phase→release_ready + status→open + 事件 delivery.submitted（data.outcome="verified", data.checks）+ attempt(verificationOutcome:"verified")
export interface VerifierFailInput { workspacePath: string; key: string; attemptId: string; generation: number; ownerToken: string; reason: string; blocked?: boolean }
export async function failVerifierTask(input: VerifierFailInput): Promise<WorkItemDetail>;
// 环境/依赖问题 → blocked；phase 回退守卫：verifier 的 from-phase=verification→verification（不动）；中断 give-back（recordInterruption）对 verifier 同理零阶段变化
export function recordCheckResult(workspacePath: string, key: string, sessionId: string, evidence: CheckEvidence): Promise<boolean>;
// run_check 工具路径（无业务锁轻量——同 heartbeat 习语）：claim.sessionId 匹配 → 同名覆盖/新名追加进 claim.checkResults（原子写回）→ true
```

- [ ] **Step 1: 失败测试**——沿用 claim.test.mjs 布局 + Task 2 真 git 仓：happy claim（checkout 建好/candidateDigest 落盘/phase 不变）/幂等/并发/无配置拒绝/checkout 失败零状态/submit：全过→release_ready+verification 块带证据/有失败→rework 路由证据清空+回 rfi/缺检查名→400/候选被换→409/超时条→blocked/fail blocked/中断 give-back 对 verifier 零阶段变化。**Step 2–4 同前** → **Step 5: Commit** `feat: verifier claim/submit/fail transactions with evidence gating`

---

### Task 4: run_check 工具 + verifier 合同 + 三角色调度

**Files:**
- Modify: `lib/work-items/delivery-runner/tools.ts`（注册 `delivery_run_check`；submit 形状扩展 verifier）
- Modify: `lib/work-items/delivery-runner/role-session.ts`（buildRoleContract 增 verifier；roles[role] 泛化照旧）
- Modify: `lib/work-items/delivery-runner/dispatcher.ts`（零机制预期——确认 role 分派对 verifier 自动生效）
- Modify: `lib/work-items/delivery-runner/tools.test.mjs`（+role-session/dispatcher 测试）

**Interfaces:**
- Consumes: Task 3 全部。
- Produces:

```ts
// tools.ts 新工具（第五件——工具族从四扩五，工具面门禁同步更新：恰好 list/claim/submit/fail/run_check）
delivery_run_check({ name: string })
// grant.role==="verifier" 专属（他角色/无 grant → denied）；按 claim.checkContexts（claim 时的配置快照——claimVerifierTask
//   在 claim.json 增存 checks 配置的 {name, repositoryId, command, timeout_seconds} 摘要，工具按 name 找配置与对应仓 checkout）
// 服务端 runConfiguredCheck → recordCheckResult 累积 → 返回 {name, outcome, exitCode, durationMs}（不给 LLM 编造口）
// 重跑同名 = 覆盖（幂等重试）
// delivery_submit_result 形状扩展：verifier 提交只需 {key}（+可选 notes）——checks 由服务端从 claim.checkResults 取；
//   工具描述注明「verifier 无需传检查结果，全部由 run_check 记录」
// role-session.ts
buildRoleContract("verifier", task, claim?) — 职责（触发全部配置检查并提交）；硬规则（只通过 delivery_run_check 执行——
//   不要自己用 bash 跑替代命令（其结果不作证据）；逐项跑完再 delivery_submit_result；环境问题 delivery_fail_task(blocked)；
//   验证环境只读——发现问题走 rework 反馈，不自行修复代码；不合并不推送）；结束条件（submit 或 fail）
```

- [ ] **Step 1: 失败测试**——run_check：verifier grant 过/他角色 denied/未知名 400/结果进 claim 累积/重跑覆盖；submit verifier 形状（不传 checks 服务端自取）；verifier 合同内容断言（run_check 专属/只读/不修复）；dispatcher 对 verifier ready 项分派（合并池 P0 verifier 优先）。工具面计数断言更新（恰五件）。**Step 2–4 同前** → **Step 5: Commit** `feat: verifier run-check tool, contract and tri-role dispatch`

---

### Task 5: UI 增量

**Files:**
- Modify: `components/work-items/WorkItemExecution.tsx`（verifier 徽标 + claim.checkResults 列表：名称/outcome 徽章/exitCode/duration/日志文件名；attempt 的 verificationOutcome 展示）
- Modify: `components/work-items/WorkItemDetailView.tsx`（verification 块 checks 增显 evidence 摘要——命令+退出码）
- Modify: `components/WorkspaceManager.tsx`（配置区 checks 行编辑：name/repositoryId/command/timeout_seconds 四列 + 增删行，PUT round-trip）
- Modify: `components/work-items/work-item-execution.test.mjs`

**Interfaces:** 消费 GET delivery-execution 的 claim.checkResults（CheckEvidence 形状自动随 ClaimState 带出）与 attempt.verificationOutcome；M2 详情 verification 块的 checks[].evidence 增量字段。无新对外接口。

- [ ] **Step 1: 失败测试**（source/渲染断言：verifier 徽标、checkResults 行、evidence 摘要、checks 编辑器四列与增删）→ **Step 2–4 同前** → **Step 5: Commit** `feat: verifier execution panel, evidence display and checks config editor`

---

### Task 6: AGENTS.md、回归与收尾

**Files:**
- Modify: `AGENTS.md`（Delivery 自动执行小节：三角色、verification.checks 配置、服务端证据协议、rework 路由、run_check 第五工具、日志布局；File Map；只记已实现）

- [ ] **Step 1: AGENTS.md 更新**（工具面恰五件的门禁表述同步）
- [ ] **Step 2: 互不越界回归**——全量 `npm test`；grep 工具族恰五件、无人工动作入口；managed 门控不变
- [ ] **Step 3: spec §9 静态项勾验**（配置/谓词/checkout 零状态/证据门禁/rework 路由/digest 复验/跨角色预算）
- [ ] **Step 4: 最终回归** → **Step 5: Commit** `docs: update AGENTS.md baseline for the verifier role`

---

## 自审记录（写计划时已核对）

- Spec 覆盖：§3→T1；§5→T2；§4→T3；§6→T4（dispatcher 零机制、submit 形状、合同）；§7→T5（config UI 在 T5、config parse 在 T1）；§8→T3（同构内联/预算跨角色/digest 绑定）；§9 清单→各任务 + T6 汇总；§10 默认选择逐条落入 binding。
- 类型一致：`DeliveryCheckConfig/CheckEvidence`（T1/T2）→ T3/T4/T5；`claimVerifierTask/submitVerifierResult/failVerifierTask/recordCheckResult`（T3）→ T4；`prepareVerifyCheckouts`（T2）→ T3；`DeliveryRole` 三值（T1）全链。
- 两处机制澄清（执行按此）：(a) claim.json 增 `checkContexts`（claim 时的 checks 配置快照）——run_check 按它找配置，避免工具路径重读配置与 claim 漂移；(b) submitVerifierResult 的 checks 完整性按 **claim.checkContexts** 比对（不是当前配置——领取后配置变更不追溯作废本轮，下轮生效）。
- 端到端冒烟（spec §9.6：含故意失败→rework→修复→重验通过）归 controller（重启 dev server 后进行）。
