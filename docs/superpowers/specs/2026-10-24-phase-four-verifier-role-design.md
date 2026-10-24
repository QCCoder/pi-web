# 第四阶段：verifier 角色与验证命令自动化

日期：2026-10-24

状态：草案，待用户审阅；未实施。

前置：第三阶段已合入（developer + worktree 隔离：合并双角色池、claim 事务、双角色合同/工具/调度、alias 联表 UI）。M2 的 `delivery.verification`（DeliveryVerificationRecord：requirementDigest + candidateDigest + checks[]）与 `record-verification`/`rework` 动作语义已就绪。

范围：加入 **verifier 角色**——developer 提交候选后（phase=verification），自动领取 → 在**候选 commit 上的独立 checkout** 中执行**人配置的验证命令** → 服务端产出结构化执行证据 → 全过推进 release_ready / 失败按返工路由回开发。release-preparer、多槽位、依赖图为后续阶段。

## 1. 意图与已确认决定

1. verifier 扩入既有协议（同池/同锁/同 Dispatcher/同工具族/同恢复机制，第三角色）。
2. **验证命令是人维护的配置**（`.pi/delivery.yaml` 的 `verification.checks[]`），不是 agent 自造——agent 无法通过改写命令为恒成功给自己放行（旧草案 §8 的防自放行约束）。
3. **执行证据由服务端产出**：verifier 调 `delivery_run_check(name)` 工具，服务端 spawnSync 在候选 worktree 执行该配置命令并记录 {command, cwd, exitCode, durationMs, logRef}；**LLM 自述不构成证据**。
4. verifier 的提交走 M2 `record-verification` 语义（actor=agent）：全 passed → `delivery.verification`（含证据）+ phase→release_ready；有 failed → M2 `rework` 语义回 ready_for_implementation（实现问题路由，反馈携带检查结果）。
5. 人工面保留：人工 `record-verification` 路由不动（人可随时手登，与自动结果同块同 digest 绑定规则——最后写入者生效）；confirm-design / record-release 仍永远 actor=user。
6. 执行环境：**候选 commit 的独立 detached checkout**（`pi-verify/<KEY>/gen<N>`），不重用 developer 的 gen 分支 worktree（验证必须在提交点核对的快照上，不随分支推进漂移）；验证 worktree 不自动清理（同款保留语义）。
7. 单执行槽位三角色共享（合并池排序不变，角色由阶段决定）。

## 2. 目标、范围与明确排除

本阶段完成：

- 池谓词扩展：verifier 可领（phase==="verification" ∧ candidates 非空 ∧ 配置 checks 非空 ∧ 共享条件）。
- claim 事务扩展：claimVerifierTask（候选 checkout 预建入事务前置、claim 增 checkContexts）；submitVerifierResult（证据校验 + record-verification 语义 / rework 路由）；failVerifierTask（回退守卫）。
- 新工具 `delivery_run_check`（服务端执行配置命令 + 证据落盘）与 checks 执行记录。
- 配置扩展：`verification: { checks: [{name, repositoryId?, command, timeout_seconds?}] }`。
- UI 增量：执行卡 verifier 角色 + 检查结果展示（名称/退出码/通过态/日志入口）；配置区 checks 编辑（简版行编辑）。

本阶段不包含：release-preparer、按验收条件自动映射命令（人自己把验收条件对应到 checks 配置）、跨仓联合检查编排、验证环境预装（依赖安装由命令自身负责，如 `npm ci && npm test`）、多槽位、并行检查（顺序执行）。

反目标：agent 不能自造/改写命令；没有服务端执行记录的「通过」不能推进；failed 不能被静默改 passed；验证不能在非候选快照上执行。

## 3. 池谓词（pool.ts 扩展）

```
readyFor(role="verifier") ⇔ 共享条件（enabled/managed/无claim/无中断/未暂停/失败上限/status∈{open,blocked}/未归档）
  ∧ phase === "verification"
  ∧ item.delivery.candidates 非空（候选存在）
  ∧ item.delivery.designConfirmed 仍真值
  ∧ config.verification.checks 非空（否则 reason no-checks-configured——引导人配置或走人工验证）
  ∧ 每个 check 的 repositoryId ∈ 候选范围 ∧ manifest 登记 active（否则 repo-not-registered）
```

无配置 checks 时项在池中显示 blocked 原因（人看见去配置），verifier 不启动。

## 4. 领取与提交事务（claim.ts 扩展）

- `claimVerifierTask(input)`：锁内复验 §3 谓词 → **候选 checkout 预建**（事务前置，见 §5）→ status in_progress（phase 保持 verification——claim 不改阶段，验证就是该阶段的活动）、generation+1、claim.json（role=verifier，`candidateDigest = candidatesDigest(item.delivery.candidates)` 快照 + worktrees）→ `delivery.claimed` 事件 → commit。幂等/互斥同既有。
- `submitVerifierResult(input)`：锁内三凭据 + **candidateDigest 复验**（候选在领取后被换——人 rework/重提交——→ 409 释放重领）+ status 非终态 → 组装 checks 结果（每条来自服务端 run_check 记录，见 §5；不允许凭空造结果）：
  - 全 passed → `delivery.verification = {at, actor:"agent", requirementDigest, candidateDigest, checks:[{name, outcome:"passed", evidence:{command, exitCode, durationMs, logRef}}]}`、phase→release_ready、status→open → `delivery.submitted` 事件（data.outcome="verified"）。
  - 有 failed → M2 rework 语义：清 designConfirmed 下游证据（candidates/verification/releasePlan）+ phase→ready_for_implementation + status→open + `delivery.rework_suggested` 事件（actor=agent，reason="verification-failed"，data 带失败检查与日志引用——开发返工的反馈输入）。
  - 命令超时/无法执行 → 该条 outcome:"unverified"，存在 unverified 即不推进（status→blocked + fail 语义提示）。
- `failVerifierTask(input)`：环境/依赖问题 → blocked；回退守卫（phase 仍为 verification 时不动阶段，仅清 claim）。
- 中断/心跳/恢复：复用全部既有机制（recordInterruption 的状态+phase 带守卫回退对 verifier 同样生效——回 verification）。

## 5. 候选 checkout 与服务端执行（worktrees.ts + 新 checks 执行器）

- `prepareVerifyCheckouts(workspacePath, item, generation, config)`：对候选涉及每个仓 `git worktree add --detach <repo>-worktrees/pi-verify-<KEY>-gen<N> <candidateCommit>`（经 lib/worktree 既有目录约定旁路——读其实现取 detached 支持；不支持则 `addWorktree` 后 `git -C <wt> checkout --detach <commit>` 两步）；幂等同款（已存在即复用）。
- `runConfiguredCheck(check, worktree, opts)`（服务端，非 LLM 路径）：spawnSync 在该 check 的仓 checkout 内执行 `check.command`（shell 经 `/bin/sh -c`，env 继承宿主；timeout 默认 600s、`timeout_seconds` 可配）；stdout/stderr 截断（尾部 64KB）落 `<item>/delivery/artifacts/verification-logs/<attemptId>/<check-name>.log`（tmp+rename）；返回 {exitCode, durationMs, logRef}。**exitCode 0 = passed；非 0 = failed；超时/启动失败 = unverified**。日志文件与 attempts 一起入库（审计）；同 gitignore 规则不适用（产物有意保留）。
- 工具 `delivery_run_check({name})`：verifier grant 专属；服务端按 claim 的 checkContexts 找到该 name 的配置与 checkout → runConfiguredCheck → 把结果**写入 claim.json 的 checkResults**（claim 内累积，submit 时整体取用——LLM 只能触发已配置的检查、读取结果，不能编造）。重跑同名校验 = 覆盖该条记录（幂等重试语义）。

## 6. 角色泛化与调度（最小增量）

- `DeliveryRole` 增 `"verifier"`；合同 `buildRoleContract("verifier")`：职责（在候选 checkout 上触发全部配置检查并汇报）；硬规则（**只通过 delivery_run_check 执行检查——不要自己 bash 跑替代命令**，其结果不作证据；检查全跑完再 submit；发现环境问题 fail(blocked)；不改任何代码——验证环境只读，发现问题走 rework 反馈不自行修复）；结束条件（submit 或 fail）。
- dispatcher/dispatch 与 submit 工具形状：零机制新增（role 分派与扁平 schema 已泛化——submit 的 verifier 形状 {key, verification_summary?} 结果由服务端 claim 记录组装，无需 LLM 传 checks）。
- 会话 cwd 仍=工作区根；合同指向 checkout 路径。

## 7. 配置与 UI

- `.pi/delivery.yaml` 增 `verification: { checks: [{name, repositoryId?, command, timeout_seconds?}] }`（parse 校验：name/command 非空、repositoryId 可选缺省=候选首仓、timeout 1–3600）。旧文件无此键 = 无配置（verifier 不可领，池显 no-checks-configured）。
- UI：执行卡 verifier 徽标 + claim.checkResults 列表（名称/退出码/duration/通过徽章/日志文件名）；详情 verification 块展示证据摘要（M2 块已渲染 checks——增量展示 evidence 字段）；配置区 checks 简版行编辑（name/repo/command/timeout 四列，增删行）。
- 事件：`delivery.claimed`(verifier) / `delivery.submitted`(outcome verified) / `delivery.rework_suggested` / 既有 fail/interrupt 族复用。

## 8. 与既有机制的关系

- M2 人工 record-verification/rework 路由不动；verifier 服务路径与其共享 delivery.verification 块语义（同构内联，P2/P3 先例）。
- 候选 digest 绑定沿用 M2 candidatesDigest；验证与候选的绑定（candidateDigest 复验）保证候选更换后旧验证失效（M2 规则）与 verifier 领取期间候选被换的 409。
- 失败预算跨三角色共享（同 digest——设计失败/开发失败/验证失败共耗）。
- 非 managed 项 / 旧 loop / 导入 / 回收站：零影响。

## 9. 验证与交付顺序

1. **配置与池**：verification parse + verifier 谓词（含 no-checks-configured/repo-not-registered）。
2. **checkout 与执行器**：detached checkout 预建（幂等/失败零状态）、runConfiguredCheck（真命令 exitCode/超时/日志截断落盘）。
3. **事务**：claim/submit（全过→release_ready；failed→rework 路由证据清空；unverified→blocked）/fail/中断恢复对 verifier 生效；candidateDigest 漂移 409。
4. **工具/合同/调度**：run_check 写 claim 累积 + verifier 合同 + dispatcher 三角色。
5. **UI + 文档**：执行卡/详情证据/配置区 + AGENTS.md。
6. **端到端冒烟（controller）**：developer 候选 → verifier 领取 → 配置检查执行（含一条故意失败项演示 rework 路由，再修复重验通过）→ release_ready。

## 10. 本设计的默认选择（用户审阅重点）

1. 验证命令来自工作区配置（人维护），agent 只能触发不能自造——防自放行的根本机制。
2. verifier 全过即自动推进 release_ready（证据绑定 + 命令是人配置的，故推进是安全的）；failed 自动按实现问题路由回 ready_for_implementation（rework 反馈附证据）——**若你希望验证结果只呈现、推进仍由人确认**，此条可改（改后 verifier 提交只写结果+横幅，release_ready 仍走人工）。
3. 验证环境=候选 commit 的 detached checkout（不重用开发 worktree）；检查顺序执行；每命令默认 600s 超时。
4. run_check 证据写 claim 累积、submit 整体取用——LLM 无法编造或篡改结果。
5. 无配置 checks = verifier 不可领（显式原因引导配置）；人工验证路由始终可用。
6. 失败预算跨三角色共享。

实施者自由度：checks 执行器文件组织、日志截断细节、UI 行编辑形态；不可改变：命令人维护、服务端证据、候选快照核对、digest 绑定、三角色单槽位。
