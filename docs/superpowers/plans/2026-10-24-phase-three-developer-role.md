# 第三阶段：developer 角色与 worktree 隔离执行实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 developer 角色扩入既有领取协议：人工确认设计后自动领取，在预建隔离 git worktree（分支 `pi-delivery/<KEY>/gen<N>`）中实现，提交经存在性核验的候选（每仓 `{repositoryId, commit}`），走 M2 submit-verification 语义进入测试中等人工验证。

**Architecture:** 全部改动落在 `lib/work-items/delivery-runner/` 既有模块（pool 谓词扩展、claim 事务三函数、attempts 的 ClaimState 扩 designDigest/worktrees、worktrees.ts 新模块、grants/合同/tools/dispatcher 双角色泛化）+ UI 增量。单执行槽位跨角色共享（池合并排序，角色由项阶段决定）；worktree 由 `lib/worktree.ts` 既有 addWorktree 创建于仓旁目录，不自动销毁。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent 0.84.4（原样依赖）、git worktree（经 lib/worktree.ts）、node:test + jiti。

**Spec:** `docs/superpowers/specs/2026-10-24-phase-three-developer-role-design.md`（用户已批准）。

## Global Constraints

- 不修改 `@earendil-works/pi-*` 任何源码或依赖版本。
- 单执行槽位跨角色互斥（designer/developer 共享）；无任务不建会话不调模型。
- developer 的代码改动只在预建 worktree（合同指定 + 服务端候选核验兜底）；合并到主分支永远由人做，不注册任何合并/推送工具。
- 人工门禁不变：record-verification / confirm-design / record-release 永远 actor=user。
- developer 提交 = M2 submit-verification 语义（写 delivery.candidates、清 delivery.verification、phase→verification、status→open），actor=agent。
- 候选核验强制：repositoryId ∈ 项范围 ∧ manifest 登记 active ∧ commit 经 `git rev-parse --verify <commit>^{commit}` 存在；任一不满足 → Validation 400。
- claim 绑定双 digest（requirementDigest + designDigest）；提交时 README 或 design.md 摘要漂移、或 designConfirmed 已被清 → 409 引导 fail 释放。
- 失败预算跨角色共享（同 digest 尾部连续——既有 countRecentFailures 天然满足，不加角色维度）。
- worktree 预建失败不落任何状态；worktree 不自动销毁；恢复=新 generation 新分支，旧 worktree 保留。
- 项仓库范围为空 = developer 不可领（reason `no-repo-scope`）。
- 验证只跑 `node --test`、`node_modules/.bin/tsc --noEmit`、`npm run lint` 与必要手测；**绝不运行 `next build`**。
- 每任务以可运行测试结尾并提交；conventional 前缀提交。

---

### Task 1: 池投影扩展——developer 谓词与合并池

**Files:**
- Modify: `lib/work-items/delivery-runner/pool.ts`
- Modify: `lib/work-items/delivery-runner/pool.test.mjs`

**Interfaces:**
- Consumes: 既有 `projectDesignerPool(items, ctx)` / `listDesignerPool(workspacePath)`、`PoolEntry`（现字段 key/title/priority/requirementDigest/ready/reasons）。
- Produces（后续任务依赖）:

```ts
export type DeliveryRole = "designer" | "developer";
export type DesignerPoolReason = ... | "no-repo-scope" | "design-unconfirmed" | "repo-not-registered";  // 新增三值（枚举扩）
export interface PoolEntry { key: string; title: string; priority: string; requirementDigest: string; ready: boolean; reasons: DesignerPoolReason[]; role: DeliveryRole; }
/** 纯投影：按角色分谓词产出（designer 谓词不变；developer 谓词见 spec §3）。 */
export function projectDeliveryPool(
  items: Array<{ key; title; priority; status; phase; archivedAt; repositories: string[]; designDocDigest?: string; designConfirmed?: unknown; delivery?: {...} | null; requirementDigest?: string }>,
  ctx: { enabled: boolean; activeClaims: Set<string>; pendingInterruptions: Set<string>; paused: Set<string>; failureCountByKey: Map<string, number>; maxAttemptsPerInput: number; registeredRepos: Map<string /*repositoryId*/, "active" | "removed"> },
): PoolEntry[];
export async function listDeliveryPool(workspacePath: string): Promise<{ ready: PoolEntry[]; blocked: PoolEntry[] }>;
// ready 合并两角色按 P→等待→key 排序（role 字段随项）；listDesignerPool 保留为薄包装（返回 designer 过滤视图）或直接迁移调用方——**取迁移**：grep listDesignerPool 调用点（tools.ts/dispatcher.ts）一并改名，不留双入口。
```

developer 谓词（binding，spec §3）：managed ∧ enabled ∧ phase==="ready_for_implementation" ∧ `item.delivery.designConfirmed` 真值（否则 reason `design-unconfirmed`）∧ `item.repositories.length > 0`（否则 `no-repo-scope`）∧ 范围内每个 repositoryId 在 registeredRepos 且 "active"（否则 `repo-not-registered`）∧ 无 claim/中断/暂停/失败上限 ∧ status∈{open,blocked} ∧ 未归档。designer 谓词与 P2 行为逐字节不变（新增 role:"designer" 字段除外）。

读取端装配：registeredRepos 从 `readWorkspaceManifest(workspacePath)` 的 `repositories[]`（id→status）取；`designDocDigest` 由读取端对 `delivery/artifacts/design.md` 内容 contentDigest 计算（文件缺失=undefined；designer 项天然无此文件，不影响 designer 谓词）。

- [ ] **Step 1: 失败测试**——纯函数：developer 全谓词分支（含三新 reason）、designer 回归不变（同输入 designer 行为零变化 + role 字段）、合并排序（designer P1 vs developer P0 → developer 在前）、读取端 manifest 装配。**Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑过 + tsc + lint + 全量** → **Step 5: Commit** `feat: developer pool predicate and merged role pool`

---

### Task 2: worktrees.ts——预建与候选核验

**Files:**
- Create: `lib/work-items/delivery-runner/worktrees.ts`
- Create: `lib/work-items/delivery-runner/worktrees.test.mjs`

**Interfaces:**
- Consumes: `addWorktree(cwd, branch)` from `@/lib/worktree`（返回 `{path, branch}`，分支已存在则复用现 path）；`readWorkspaceManifest`（repositories[]: {id, alias, path, status})；manifest.repository path 是**相对工作区根**的 POSIX 路径（AGENTS.md 约定——join(workspacePath, repo.path)）。
- Produces:

```ts
export interface RoleWorktree { repositoryId: string; repoPath: string; path: string; branch: string }
/** 项范围每仓建 worktree：branch = `pi-delivery/${key}/gen${generation}`（addWorktree 内部 sanitize）。
 *  任一仓失败 → 整体抛（claim 前置，不落状态）；已存在的分支/path 复用（幂等）。 */
export async function prepareWorktrees(workspacePath: string, item: { key: string; repositories: string[] }, generation: number, deps?: { addWorktree?: typeof addWorktree; manifest?: ... }): Promise<RoleWorktree[]>;
/** 每候选：repoPaths 含 repositoryId → spawnSync("git", ["-C", repo, "rev-parse", "--verify", `${commit}^{commit}`]) 成功；失败/未知 repo → WorkItemValidationError 带 repositoryId+commit。 */
export function verifyCandidateCommits(repoPaths: Map<string, string>, candidates: Array<{ repositoryId: string; commit: string }>, deps?: { run?: (args: { repo: string; commit: string }) => { ok: boolean } }): void;
```

- [ ] **Step 1: 失败测试**——mkdtemp 假仓（`git init` + 一次 commit 拿真 sha）：prepareWorktrees 幂等（同 generation 二次调用复用）、branch 命名、多仓顺序、注入假 addWorktree 失败 → 抛错；verifyCandidateCommits：真 sha 过、假 sha 400 带信息、未登记 repo 400、注入 run 的纯分支。**Step 2–4 同前** → **Step 5: Commit** `feat: delivery worktree preparation and candidate verification`

---

### Task 3: claim 事务扩展——developer 三函数

**Files:**
- Modify: `lib/work-items/delivery-runner/attempts.ts`（ClaimState 增可选 `designDigest?: string`、`worktrees?: RoleWorktree[]`；AttemptRecord 增可选 `candidates?: Array<{repositoryId; commit}>`、`worktrees?: RoleWorktree[]`；类型宽校验兼容旧行）
- Modify: `lib/work-items/delivery-runner/claim.ts`
- Modify: `lib/work-items/delivery-runner/claim.test.mjs`（或新增 developer 用例段）

**Interfaces:**
- Consumes: Task 1 `projectDeliveryPool`（复验用同谓词）、Task 2 `prepareWorktrees/verifyCandidateCommits`、既有 `claimDesignerTask` 全套基建。
- Produces:

```ts
export interface DeveloperClaimInput { workspacePath: string; key: string; sessionId: string; requestId: string }
export async function claimDeveloperTask(input: DeveloperClaimInput): Promise<{ grant: ClaimGrant; replayed: boolean }>;
// 锁内：projectDeliveryPool 复验 developer 谓词 → prepareWorktrees(workspacePath, item, generation)（**在写任何状态前**，失败抛出=零副作用）
// → phase ready_for_implementation→implementation、status in_progress、generation+1、ownerToken
// → writeClaim({...claim, role:"developer", designDigest: contentDigest(design.md), worktrees}) → delivery.claimed(actor agent, data.phase.from/to+worktrees) → commit → readWorkItem
export interface DeveloperSubmitInput { workspacePath: string; key: string; attemptId: string; generation: number; ownerToken: string; candidates: Array<{ repositoryId: string; commit: string }>; notes?: string; conversationId?: string }
export async function submitDeveloperResult(input: DeveloperSubmitInput): Promise<WorkItemDetail>;
// 锁内：requireActiveClaim 三凭据（role=developer）∧ requirementDigest 未变 ∧ designDigest 与领取时一致 ∧ item.delivery.designConfirmed 仍真值
//   （任一漂移 → WorkItemConflictError("input changed since claim — release via fail and re-claim")）
// → verifyCandidateCommits(repoPaths(范围仓), candidates)（spawnSync 在锁内可接受：纯读快）
// → delivery.candidates = candidates、verification 清、phase→verification、status→open、revision+1
// → delivery.submitted(actor agent, data {attemptId, generation, candidates, notes?}) → clearClaim → attempt submitted(candidates+worktrees 从 claim 拷贝) → commit
export interface DeveloperFailInput { workspacePath: string; key: string; attemptId: string; generation: number; ownerToken: string; reason: string; blocked?: boolean }
export async function failDeveloperTask(input: DeveloperFailInput): Promise<WorkItemDetail>;
// 同 designer fail 骨架：清 claim → attempt failed → phase implementation→ready_for_implementation 回退（守卫：仅当仍为 implementation 时回退——人若中途动作改了阶段不回滚）→ 失败计数/暂停/事件（reason 带 role 语义）→ commit
// heartbeat/recordInterruption/resumeAutomation 零改动（role 泛化字段已随 ClaimState 流动）
```

M2 语义对齐注意：submit 的 candidates 写入**同构内联**（不调 delivery.ts 的 applyDeliveryAction——其自锁不可重入，P2 design.md 先例）；写序 candidates 进 item.yaml 前无产物要先落的问题（候选是既有 commit，无新产物）。

- [ ] **Step 1: 失败测试**——沿用 claim.test.mjs 的 mkdtemp 布局 + Task 2 的真 git 仓（把仓登记进假 manifest、item.repositories 指向）：happy claim（worktree 建好入 claim、phase 流转、designDigest 落盘）/ 幂等重放 / 并发互斥 / 三新谓词拒绝 / prepareWorktrees 注入失败=零状态 / submit：候选核验（真 sha 过、假 sha 400、范围外 repo 400）/ 设计编辑后 submit 409（改 design.md 再提交）/ 人 record-verification 后 claim 已过阶段→submit 冲突路径 / fail 回退与不回退守卫 / 失败计数跨角色（designer 失败 2 + developer 失败 1 = 达上限暂停）。**Step 2–4 同前** → **Step 5: Commit** `feat: developer claim/submit/fail transaction with worktrees`

---

### Task 4: 角色泛化——grants/合同/tools/dispatcher 双角色

**Files:**
- Modify: `lib/work-items/delivery-runner/role-grants.ts`（`RoleGrant.role: DeliveryRole`；setGrantToken/hasAnyActiveExecution 不变）
- Modify: `lib/work-items/delivery-runner/tools.ts`（claim/submit/fail 按 grant.role 分派；submit 参数联合 schema）
- Modify: `lib/work-items/delivery-runner/role-session.ts`（`buildRoleContract(role, task, claim?)` 双合同；launchRoleSession 双角色；结束钩子/心跳 role 无关零变化）
- Modify: `lib/work-items/delivery-runner/dispatcher.ts`（listDeliveryPool 合并队列取首，按 entry.role 分派 launch）
- Modify: `lib/session-host/facade.ts`（零改动预期——确认；如需透传 worktrees 信息只经合同字符串，不动 facade）

**Interfaces:**
- Produces:

```ts
// role-session.ts
export function buildRoleContract(role: DeliveryRole, task: { key: string; title: string }, claim?: { worktrees?: RoleWorktree[] }): string;
// designer 合同 = 现行文本（限定只领 task.key 不变）；
// developer 合同要点（spec §6）：职责（按已确认设计与验收条件实现）；硬规则：**代码只改这些 worktree**（逐项列出 path+branch）——主工作区与其它目录只读；分支纪律按工作区 AGENTS/git 规则，草稿分支上工作，**不合并不推送**（合并由人做）；完成后在 worktree 分支 commit，用 delivery_submit_result 提交 candidates（每仓 commit sha）+notes（变更说明/自测情况）；阻塞 delivery_fail_task(blocked)；验证结论由人给，你没有验证登记动作；结束条件：提交或 fail。
export async function launchRoleSession(opts: { workspaceId: string; workspacePath: string; role: DeliveryRole; task: { key: string; title: string }; claim: { worktrees?: RoleWorktree[] }; config: DeliveryRunnerConfig; deps?: LaunchDeps }): Promise<string>;
// 泛化 launchDesignerSession：命名 `${role} · ${task.key}`；grantRole(role)；开场 prompt 按角色；launchDesignerSession 删除（调用方只有 dispatcher，一并迁移）
// tools.ts：delivery_claim_task({key}) → 按 grant.role 调 claimDesignerTask/claimDeveloperTask；
//   delivery_submit_result 参数联合（designMarkdown+acceptanceCriteria | candidates+notes）——Type.Union 或可选字段组，服务端按 grant.role 校验形状并调对应 submit；submit 成功结果对 developer 附「等待人工验证」提示；Conflict 文案沿用 fail 释放引导；
//   delivery_list_ready_tasks → listDeliveryPool（ready 带 role）；
// dispatcher.ts：tick 用 listDeliveryPool(workspacePath).ready[0] → {role, key} → launchRoleSession；超时清道夫对 developer claim 同样适用（claimedAt 起算不变，recordInterruption 已 role 无关）。
```

- [ ] **Step 1: 失败测试**——tools 分派（source+行为：grant.role=developer 调 developer 服务、submit 联合形状校验错 400）；role-session（developer 合同含 worktree 清单与「不合并不推送」、命名、grant role）；dispatcher（合并队列 P0 developer 优先于 P1 designer、按 role 分派 launch、developer 超时清道夫）。**Step 2–4 同前** → **Step 5: Commit** `feat: dual-role dispatch, contracts and tool routing`

---

### Task 5: 配置与 UI 增量

**Files:**
- Modify: `lib/work-items/delivery-runner/config.ts`（`roles.developer?: {profile?, model?}`——解析与 designer 同形；roles 形状改为 Record<string, DeliveryRoleConfig> 或显式双字段，取显式双字段）
- Modify: `components/WorkItemExecution.tsx`（role 标签 designer/developer；claim.worktrees 列表：仓 alias? 无 alias 用 repositoryId + 分支名；候选展示在 recentAttempts 的 submitted 项）
- Modify: `components/WorkspaceManager.tsx`（配置区加 developer profile/model 行，与 designer 同形；profile→model 解析提示同款文案）
- Test: `components/work-items/work-item-execution.test.mjs`（source 断言增补）

**Interfaces:**
- Consumes: Task 3 的 claim.worktrees / attempt.candidates（GET delivery-execution 已随 ClaimState/AttemptRecord 扩展自动携带——确认 GET 序列化不含 ownerTokenHash 原则仍成立，新字段照带）。
- Produces: 无新对外接口。

- [ ] **Step 1: 失败测试**（config 解析 developer；UI source 断言：role 标签、worktrees 渲染、developer 配置行）→ **Step 2–4 同前** → **Step 5: Commit** `feat: developer role config and execution panel worktree display`

---

### Task 6: AGENTS.md、回归与收尾

**Files:**
- Modify: `AGENTS.md`（Delivery 自动执行小节：单角色表述改双角色、developer 语义/worktree 约定（分支前缀/仓旁目录/不自动销毁/不合并不推送）、池合并与单槽位跨角色、失败预算跨角色、新 reason 三值；File Map 增 worktrees.ts；只记已实现）

- [ ] **Step 1: AGENTS.md 更新**
- [ ] **Step 2: 互不越界回归**——全量 `npm test`；grep 确认工具族仍只有四工具、无合并/推送类工具注册；`workspace_list_work_items` managed 门控不变。
- [ ] **Step 3: spec §9 验证清单静态项勾验**（worktree 预建失败零状态/候选核验/409 语义/回退可重领/单槽位互斥——单测已覆盖项对号）。
- [ ] **Step 4: 最终回归** `npm test && node_modules/.bin/tsc --noEmit && npm run lint` → **Step 5: Commit** `docs: update AGENTS.md baseline for the developer role`

---

## 自审记录（写计划时已核对）

- Spec 覆盖：§3→T1；§4/§5→T2/T3；§6→T4；§7→T5（config roles.developer/UI role/worktrees）；§8→T3（同构内联注记）+T6（跨角色预算文档化）；§9 清单→各任务测试步骤 + T6 汇总；§10 默认选择逐条落入对应任务的 binding 语义。
- 类型一致：`DeliveryRole`/`RoleWorktree`（T1/T2 定义）→ T3/T4/T5 消费；`claimDeveloperTask/submitDeveloperResult/failDeveloperTask`（T3）→ T4 工具分派；`buildRoleContract/launchRoleSession`（T4）→ dispatcher；`listDeliveryPool/projectDeliveryPool`（T1）→ tools/dispatcher/claim 复验（`listDesignerPool` 移除不留双入口）。
- 已知取舍：verifyCandidateCommits 的 spawnSync 在写锁内（纯读、毫秒级，可接受）；developer submit 无新产物落盘（候选是既有 commit），「产物先落盘」序自然满足。
- 端到端冒烟（spec §9.4）归 controller：designer 起稿→人确认→developer 领取→worktree 实现→候选提交→人 record-verification（需重启 dev server 使新代码生效——HostJob 装配在启动时）。
