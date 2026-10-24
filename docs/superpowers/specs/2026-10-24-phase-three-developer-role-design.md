# 第三阶段：developer 角色与 worktree 隔离执行

日期：2026-10-24

状态：用户已批准（2026-10-24）；未实施。

前置：第二阶段已合入（领取协议 + designer 角色：TaskPool 投影 / claim 事务 / attempt 审计与恢复 / Dispatcher HostJob / 角色授权与四工具 / 会话装配 / 控制路由 / UI）。M2 的 `submit-verification` 语义（候选 `{repositoryId, commit}` 列表、清旧验证、phase→verification）已就绪。

范围：加入 **developer 角色**——人工确认设计后，自动领取 → 在隔离 git worktree 中实现 → 提交候选（每仓库 `{repositoryId, commit}`）→ 走 M2 的 submit-verification 语义进入测试中，等待人工/后续 verifier 验证。verifier、release-preparer、多槽位、依赖图为后续阶段。

## 1. 意图与已确认决定

1. 首版范围 = developer 单角色扩入**既有协议**：同一 TaskPool/ClaimService/Dispatcher/工具族/恢复机制，不建第二套引擎（延续 P2 用户已确认的方向）。
2. **执行槽位仍为单槽位，跨角色共享**：一个工作区同时至多一个活动执行（designer 或 developer）。池按角色合并投影，候选合并排序（P→就绪等待→key），角色由项所处阶段决定。
3. **worktree 隔离**：developer 的代码改动只发生在 runner 预建的 git worktree 中（分支 `pi-delivery/<KEY>/gen<N>`）；提交候选 = 分支上的真实 commit，提交时服务端核验 commit 存在。
4. **developer 的提交即 M2 的 submit-verification**（actor=agent 变体）：候选写入 `delivery.candidates`、清旧验证、phase→verification——与人工路径同一语义面，不造第二套候选协议。
5. 人工门禁不变：record-verification（测试结论）/ confirm-design / record-release 永远 actor=user。
6. 会话装配取舍（v1）：developer 会话 cwd = **工作区根**（工作区扩展/交付工具自动挂载），开场合同显式指定 worktree 路径为唯一代码工作区（bash `cd`/绝对路径/edit-write 均指向 worktree）；不为 worktree cwd 改 session-host 的工作区解析。理由：worktree 在工作区目录之外，cwd=worktree 会失去工作区装配——改宿主解析属结构性变更，收益不抵。后续 verifier 需要时再评估。

## 2. 目标、范围与明确排除

本阶段完成：

- 池投影扩展：developer 可领谓词（见 §3）。
- claim 事务扩展：claimDeveloperTask（phase ready_for_implementation→implementation；worktree 预建入事务前置）；submitDeveloperResult（候选核验 + submit-verification 语义）；failDeveloperTask（回退 ready_for_implementation）。
- Worktree 管理：按项仓库范围预建（claim 前）、生命周期记录（attempt 携带 worktrees 清单）、**不自动销毁**（成功/失败后保留：候选在分支上、失败现场可查；清理是人工/后续阶段的事）。
- 角色泛化：role-session/grants/tools/dispatcher 从 designer 单角色泛化为 designer|developer 双角色（合同、命名、结束钩子按 role 分派）。
- UI 增量：执行区显示角色与 worktree/分支信息；配置区增加 developer profile/model。

本阶段不包含：verifier / release-preparer、验证命令自动执行、多执行槽位、跨工作项依赖图、worktree 自动清理、worktree-cwd 的宿主级工作区解析、候选合并/推送（合并仍由人按工作区 git 纪律执行）。

反目标：developer 不得直接改主工作区代码（合同+服务端不提供主区写通道的区别在于 worktree 是唯一被指定的路径；服务端无法 OS 级禁止，属可信协作边界，与 P2 一致）；不得自报候选 commit 而不经存在性核验；不得绕过 submit-verification 语义重复造候选字段。

## 3. 池投影扩展（pool.ts）

developer 可领谓词（新增，与 designer 谓词并列）：

```
readyFor(role="developer") ⇔ automation.enabled
  ∧ managed ∧ phase === "ready_for_implementation"
  ∧ item.delivery.designConfirmed 存在（设计已确认——防止确认失效后误领）
  ∧ item.repositories 非空（仓库范围明确；空范围 = 不可领原因 no-repo-scope）
  ∧ 范围内全部 repositoryId 在 manifest 登记且 status=active
  ∧ 无活动领取 ∧ 无未确认中断 ∧ 未暂停 ∧ 同 digest 尾部连续失败未达上限
  ∧ status ∈ {open, blocked} ∧ 未归档
```

排序与 designer 共用（P→等待→key）。投影输出带 role 字段；`listPool(workspacePath)` 返回按角色分桶 + 合并就绪队列。

## 4. 领取与提交事务（claim.ts 扩展）

- `claimDeveloperTask(input)`：锁内复验 §3 谓词 → **worktree 预建**（事务前置，见 §5）→ phase→implementation、status=in_progress、generation+1、claim.json（role=developer，claim 新增 `designDigest`（领取时 design.md 摘要）与 `worktrees: [{repositoryId, path, branch}]`）→ `delivery.claimed` 事件（actor=agent）→ commit。requestId 幂等同 designer。
- `submitDeveloperResult(input: {workspacePath, key, attemptId, generation, ownerToken, candidates: [{repositoryId, commit}], notes?})`：锁内三凭据核验 + 双 digest 复验（README 未变 ∧ design.md 摘要与领取时一致 ∧ designConfirmed 仍在——设计被重确认/失效（M2 失效回退会清 designConfirmed 并回 design）任一发生 → 409 引导 fail 释放重领）→ **候选核验**：每个 repositoryId ∈ 项范围 ∧ manifest 登记 ∧ `git -C <repo> rev-parse --verify <commit>^{commit}` 成功 → 写入 `delivery.candidates`、清 `delivery.verification`、phase→verification、status→open（等验证）→ `delivery.submitted`（data.candidates）→ attempt submitted（记录 candidates + worktrees）→ commit。语义对齐 M2 submit-verification，actor=agent。
- `failDeveloperTask(input)`：核验 → 清 claim → attempt failed（reason 必填；blocked 可选）→ phase 回 ready_for_implementation → 失败计数/暂停同 P2 语义。
- heartbeat / recordInterruption / resumeAutomation：role 泛化复用，零新机制。

## 5. Worktree 管理（新 worktrees.ts）

```
lib/work-items/delivery-runner/worktrees.ts
export interface RoleWorktree { repositoryId: string; repoPath: string; path: string; branch: string }
export async function prepareWorktrees(workspacePath: string, item: {key, repositories}, generation: number): Promise<RoleWorktree[]>
// 对项范围每个仓库：addWorktree(repoPath, `pi-delivery/${key}/gen${generation}`)（lib/worktree.ts 既有能力——分支已存在则复用，返回现 path）
// 单仓失败 → 整体抛错（claim 前置失败不落任何状态）；幂等（重放路径跳过已存在的）
export async function verifyCandidateCommits(repoPaths: Map<string, string>, candidates: Array<{repositoryId: string; commit: string}>): Promise<void>
// 对每个候选：repoPaths 有该 repositoryId（调用方已验范围）→ spawnSync git -C <repo> rev-parse --verify <commit>^{commit}；失败抛 Validation 带 repo/commit
```

- worktree 目录在仓旁 `<repo>-worktrees/`（既有约定），不进工作区 git；分支前缀 `pi-delivery/` 可识别。
- 不自动销毁；attempt 记录携带 worktrees 清单供 UI/恢复展示。恢复（recordInterruption 后重新领取）走新 generation = 新分支，旧 worktree 保留——接手不重用仍有进程活动的旧 worktree（P2 保守接手语义延续）。

## 6. 角色泛化（role-session / grants / tools / dispatcher）

- `RoleGrant.role: "designer" | "developer"`；`hasAnyActiveExecution` 不变（跨角色单槽位天然成立）。
- role-session：`buildRoleContract(role, task, worktrees)` 产出角色合同——developer 合同要点：职责（按已确认设计在指定 worktree 实现，产出候选 commit）；硬规则（**只在 <worktrees 清单> 内改代码**，主工作区只读；分支纪律按工作区 AGENTS/git 规则（draft 分支）；不合并到主分支——合并由人做；自测后在 worktree 分支上 commit；提交候选用 delivery_submit_result（candidates=每仓 commit sha + notes）；阻塞用 fail(blocked)；验证结论由人/后续 verifier 给出）；结束条件（提交或 fail 即结束）。会话命名 `developer · <KEY>`。
- tools：四工具 role-aware——`delivery_claim_task`/`delivery_submit_result`/`delivery_fail_task` 按 grant.role 分派到对应服务函数；`delivery_submit_result` 参数 schema 联合（designer: designMarkdown+acceptanceCriteria；developer: candidates+notes），服务端按 role 校验形状；list 工具返回合并池（ready 带 role 字段）。
- dispatcher：`listPool` 合并就绪队列取队首，按 role 分派 launch；其余（单槽位/超时/豁免）零变化。

## 7. 配置、事件与 UI

- `.pi/delivery.yaml`：`roles.developer?: {profile?, model?}`（与 designer 同形；profile→model 解析规则沿用 P2 最终波）。
- 事件复用 P2 七类 + M2 的 `work_item.design_updated` 不涉；新增无（submit 复用 `delivery.submitted`，data 带 candidates）。
- UI：WorkItemExecution 显示 role（designer/developer 标签）、claim.worktrees（仓 alias + 分支 + 路径摘要）；配置区加 developer 行。看板/列表零变化（phase 驱动）。

## 8. 与既有机制的关系

- M2 submit-verification 人工路由不动（actor=user）；developer 服务路径与其共享 candidates 写入语义（同构内联，如 P2 design.md 先例——updateDesignContent 自锁不可重入同理，delivery 动作函数若自锁则 claim 侧同构内联并注明）。
- cxin dev-loop / 非 managed 项 / 导入 / 回收站：零影响（managed 门控不变）。
- P2 的失败窗口（failure-window）按 digest 计数——developer 与 designer 的 attempt 同审计流，各自 digest 相同（README 未变）——**裁定**：失败计数跨角色合并（同输入的设计失败与开发失败都消耗同一预算，防 A/B 角色互相刷次数绕上限）。

## 9. 验证与交付顺序

1. **池与事务扩展**：developer 谓词（含 no-repo-scope/非 active 仓/designConfirmed 缺失分支）、claim（worktree 预建 + 回退）、submit（候选核验 404/409、digest 失效 409、语义=submit-verification）、fail 回退；程序化假 worker。
2. **角色泛化**：grants/合同/tools/dispatcher 双角色分派与合并池排序；结束钩子/心跳对 developer 生效。
3. **UI + 文档**：执行区 role/worktrees、配置区 developer、AGENTS.md。
4. **端到端冒烟（controller）**：designer 自动起稿 → 人确认 → developer 自动领取 → worktree 实现 → 候选提交 → phase=verification → 人 record-verification。

必须覆盖：worktree 预建失败不落状态；候选 commit 不存在 → 400；范围外 repositoryId → 400；设计重确认后旧 claim 提交 → 409；失败回退后可重领（新 generation 新分支）；单槽位跨角色互斥；P2/M2/M1 全量回归。

## 10. 本设计的默认选择（用户审阅重点）

1. 首版只做 developer；verifier/release-preparer 后续。
2. 会话 cwd=工作区根 + 合同指向 worktree（不为 worktree cwd 改宿主工作区解析）——结构性变更留待有第二需求方（verifier）时再评估。
3. worktree 分支 `pi-delivery/<KEY>/gen<N>`，仓旁目录，**不自动清理**（候选在分支上、失败现场保留；清理人工/后续）。
4. 项仓库范围为空 = developer 不可领（no-repo-scope 原因），引导创建时设置范围。
5. 失败预算跨角色共享（同 digest）。
6. developer 提交 = M2 submit-verification 语义（actor=agent）；合并到主分支永远由人做。

实施者自由度：worktrees.ts 文件组织、合同文案细节、UI 展示细节；不可改变：单槽位跨角色、worktree 隔离与不自动销毁、候选核验、门禁边界（§1.5）、与 P2 机制的复用关系。
