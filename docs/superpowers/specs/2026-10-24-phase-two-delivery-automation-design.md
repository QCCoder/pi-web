# 第二阶段：交付执行自动化（领取协议 + designer 首角色）

日期：2026-10-24

状态：用户已批准（2026-10-24）；未实施。

前置：第一阶段已合入——M1 单进程会话宿主（`lib/session-host/`，HostJob 装配、关停中断记录、恢复门禁、双层跨进程工作区写锁）与 M2 中央工作项管理 + 人工标准交付流程（七阶段、11 个 delivery 动作、digest 证据绑定、失效回退、已发布冻结、`workflows` capability 已注册未激活）。

范围：在已落地的交付流程之上，加入**程序保证的任务领取协议**与**第一个自动执行角色 designer**。后续角色（developer/verifier/release-preparer）沿用同一协议分批加入，不在本版范围。

## 1. 意图与已确认决定

业务意图在 2026-10-22 草案对话中已确认，继续有效：**工作项为中心，角色从就绪任务池自主领取，程序保证领取与阶段流转规则，不由中央 LLM 逐次派发**；设计确认与发布登记保持人工门禁。

本阶段在此基础上确认：

1. 首版范围 = 领取协议（TaskPool 投影 + 原子 claim/submit + 尝试/恢复）+ **designer 一个角色**（自动起稿设计与验收条件，人确认后流转）。developer/verifier/release-preparer、worktree 隔离执行、验证命令自动化、并发多槽位为后续阶段。
2. 自动执行归 ③ pi-extension 层（工作项交付扩展内部：TaskPool/ClaimService/Dispatcher/角色唤醒是扩展内部服务），宿主只提供通用装配入口（HostJob + 会话创建门面），不进 SDK、不新增平台分层（架构总纲 §3）。
3. `workflows` capability 在本阶段激活其自动执行含义：自动化需要 capability = work-items ∩ workflows 且工作区显式配置开启；手工管理面继续只看 work-items（第一阶段语义不变）。
4. 人工门禁不变：confirm-design / record-release 永远 actor=user；agent 工具不注册「批准自己方案」类动作（第一阶段 §9 边界延续）。
5. 旧草案（2026-10-22）的 daemon/WorkerWaker/双进程锁动机作废；其领取协议、attempt/generation、恢复规则的业务语义按本 spec 移植到单进程宿主与 M2 动作面。

## 2. 目标、范围与明确排除

本阶段完成：

- 就绪任务池：由工作项文件状态**投影**（不另存队列事实源）——managed 项、automation 启用、阶段/门禁允许、无活动领取。
- 原子领取协议：claim/submit/fail/heartbeat，attempt + generation + ownerToken，幂等与并发互斥（复用 M2 双层工作区写锁）。
- Designer 自动执行：Dispatcher（HostJob）发现就绪 → 建角色会话 → 会话内领取 → 起稿 `delivery/artifacts/design.md` 与验收条件 → 提交 → 会话结束，项停在 design 阶段等待人工 confirm-design。
- 中断与恢复：关停写中断记录、恢复门禁阻塞该工作项新领取（M1 模式）；同输入失败 3 次停止自动领取等人处理。
- 最小 UI：工作项详情显示活动执行（角色/会话/attempt/状态）与「停止执行」「恢复」；设置›工作区新增交付自动化配置区（开关 + designer 角色映射 + 预算）。

本阶段不包含：developer/verifier/release-preparer 角色、worktree 隔离与候选提交协议、验证命令自动执行与结构化检查记录自动化、发布准备自动化、跨工作项并行/多槽位、子任务 DAG、新外部连接器、生产发布自动化、任意工作流编辑器。

反目标：不能用「只有单进程」替代领取互斥（异步请求与重复唤醒仍在）；不能把领取/提交规则只写进提示词；agent 不能自报身份绕过角色绑定；不能在无任务时调用模型；不能把人工确认动作注册成 agent 工具；不能为 designer 会话复制第二套会话引擎。

## 3. 方案选择

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 专用 Dispatcher HostJob + 角色会话自主领取（领取协议为本阶段核心交付） | 确定性唤醒、attempt/恢复语义完整、后续角色零边际接入 | 采用（用户已确认的方向，单进程化移植） |
| 复用 kit loop 心跳承载交付执行（SKILL 合同） | 零新引擎，但轮锁≠领取协议、无 attempt/generation/租约，恢复与预算语义要重新发明，且 loop 轮会话身份与角色执行审计混淆 | 不采用（cxin dev-loop 继续按原样运行，二者并存互不干扰） |
| 会话内 subagent 编排（父会话派子会话） | 需要常驻父会话当调度器——正是「中央 LLM 派发」已被否决的形态 | 不采用 |

## 4. 六层定位与模块边界

| 层 | 本阶段职责 |
| --- | --- |
| ① 用户交互 | 详情页活动执行区、停止/恢复动作、设置›工作区交付配置区 |
| ② Next.js 接口 | 人工控制路由（stop/resume/配置读写）薄壳，错误映射沿用 work-items 惯例 |
| ③ pi-extension（本阶段主体） | `lib/work-items/delivery-runner/`：TaskPool 投影、ClaimService、Dispatcher（HostJob）、designer 会话装配、领取 LLM 工具、attempt/中断记录 |
| ④ pi SDK | 原样：AgentSession、扩展与资源加载、SessionManager |
| ⑤ 文件与状态 | `.pi/delivery.yaml`（工作区自动化配置）、`<item>/delivery/attempts/`、`<item>/delivery/runtime/claim.json` |
| ⑥ 部署基建 | 单进程宿主装配（`ensureHostBooted` 注册 Dispatcher）、关停序列扩展 |

模块内部结构（实施者可调整文件名，职责不可并）：

```
lib/work-items/delivery-runner/
  pool.ts          TaskPool 纯投影：listReadyTasks(workspacePath, role) —— 读 listWorkItems + 配置 + 活动领取，输出候选与不可领原因
  claim.ts         ClaimService：claim/submit/fail/heartbeat/recover —— 全部在 withWorkspaceWriteLock 内；attempt/generation/ownerToken 事务
  dispatcher.ts    DeliveryDispatcher implements HostJob（id "delivery-dispatcher"，30s tick，可注入时钟）；发现就绪 → 经 session-host facade 建角色会话
  role-session.ts  designer 会话装配：开场合同（appendSystemPrompt）、命名、登记（M1 background 的活动执行登记泛化）、结束钩子
  tools.ts         领取工具扩展工厂（delivery_list_ready_tasks / delivery_claim_task / delivery_submit_result / delivery_fail_task）；capability 门控挂载
  attempts.ts      attempt 审计记录读写（tmp+rename）；中断记录与恢复门禁（对齐 M1 lib/loops/executions 习语）
```

## 5. 领取协议

### 5.1 任务投影（pool.ts）

就绪任务不是存储实体，是**每次查询时从文件状态推导**：

```
readyFor(role="designer") ⇔ automation.enabled
  ∧ item.delivery 存在（managed）
  ∧ item.phase === "intake"（designer 的可领阶段；领取事务内流转到 design，之后 designer 不再可领该项）
  ∧ 无活动领取（runtime/claim.json 不存在或已判定失效）
  ∧ 无未确认中断记录（attempts 中 needsAttention 的中断未解除）
  ∧ 自动失败未达上限（同 requirementDigest 的连续失败 attempt < 3）
  ∧ status ∈ {open, blocked(可解)}（cancelled/archived/done 不可领）
```

排序：P0→P3 → 就绪等待时间升序 → key。投影输出包含不可领原因（供 UI 与日志），不写文件。

### 5.2 领取事务（claim.ts）

`claim(input: { workspaceId, key, role, requestId })`，全部在 `withWorkspaceWriteLock` 窗口内：

1. 重读 item + 配置 + 活动领取，逐条复验 5.1 前置（双检——Dispatcher 的发现只是提示，领取才是权威）。
2. 通过 → 生成 `attemptId`（ULID）、`generation = item.delivery.claim?.generation + 1 ?? 1`、随机 `ownerToken`；**同一事务内完成阶段流转**：phase intake→design、design.md 缺失则播种模板（与 M2 start-design 同构，actor=agent 记入 `delivery.claimed` 事件的 phase 字段——程序保证流转，不依赖 LLM 调用动作）；写 `<item>/delivery/runtime/claim.json`（claim = {attemptId, generation, ownerToken hash, role, sessionId, claimedAt, requirementDigest}）；status → in_progress。
3. 同 `requestId` 重试返回已有领取（幂等，不产生第二个 attempt）；他人活动领取 → 409；前置不满足 → 400 携带具体原因。
4. `ownerToken` 不暴露给 LLM：由运行时在扩展工具回调的服务端路径中携带与核对（见 §7 身份绑定）。

`submit({attemptId, generation, ownerToken, result})`：锁内校验 owner/generation/输入摘要未变（requirementDigest 与领取时一致，变了 → 409 要求重新领取）；designer 的 result = `{ designContent, acceptanceCriteria[] }` → 经 M2 `updateDesignContent` 同构路径写 design.md（不经过 user 路由，直调服务）+ 记录 `delivery.submitted` 事件 + 清 claim + status → open（回到等待人工确认；阶段保持 design）。提交即结束：designer 不推进 confirm-design。

`fail({attemptId, generation, ownerToken, reason, blocked?})`：记 `delivery.attempt_failed` 事件 + attempt 审计；清 claim；环境/依赖问题 → status=blocked + 阻塞原因；连续失败达 3 → 追加 `delivery.automation_paused`（自动领取停止，等人显式恢复）。

`heartbeat({attemptId, generation, ownerToken})`：仅刷新 claim.json 的 `lastSeenAt`（不 bump revision、不产生事件、不进 git）；由**运行时续约**（role-session 的定时器，20s），不依赖 LLM 调工具。

### 5.3 attempt 与中断恢复（attempts.ts）

- `<item>/delivery/attempts/<attemptId>.json`：{attemptId, generation, role, sessionId, claimedAt, endedAt?, outcome: submitted|failed|interrupted, reason?, requirementDigest}；结束（成功/失败/中断确认）后写入，追加式审计。
- `<item>/delivery/runtime/`（claim.json、心跳）gitignored，可丢失——丢失按中断处理。
- 90s 无心跳 → 标记 suspected；**不自动回收**。恢复判定对齐 M1 模式：宿主关停时对活动 designer 执行写中断记录（复用 M1 background 关停序列——活动登记从 LoopKit 轮泛化为「活动执行」：role-session 登记/清除走 `markRoundActive` 同构机制，中断记录写 `<item>/delivery/attempts/` 且 needsAttention=true）；重启后该项被 5.1 的中断门禁挡住，详情页提供「重新检查并恢复」——确认旧会话不在注册表（单进程内天然可知）且无存活命令进程（复用 M1 只读探测口径，作用域=该工作项目录）→ 解除。
- 会话仍活但超执行上限（默认 30 分钟，可配）：Dispatcher 停止该会话（facade destroy，SDK 定向杀）→ 记 interrupted attempt → 门禁等人恢复。

## 6. Dispatcher 与角色会话

- `DeliveryDispatcher implements HostJob`，`ensureHostBooted` 装配链中注册（LoopKitSpawner 之后；同 globalThis 单例纪律）。30s tick：遍历启用自动化的工作区 → 每工作区至多**一个**活动 designer 执行（首版单槽位）→ 无活动且池非空 → 建一个 designer 会话。tick 可注入时钟/依赖测试。
- 会话创建：`session-host facade.createSession({ cwd: workspace 根 })` + `appendSystemPrompt` = designer 开场合同（职责、领取协议硬规则、门禁边界、结束条件）+ `set_session_name`「designer · <KEY> · 尝试 <generation>」。工作区扩展（含领取工具）按 cwd 自动装配；profile 优先用工作区 `.pi/agents/designer.md`（存在则以其 model/tools 约束为准——经 startRpcSession 的 model 参数与后续 set_tools 实现），缺省用合同内置默认。**不建父会话、不冒用 pi-subagent- 前缀**（顶层普通会话，列表可见、可停止、可打开——审计与操控走既有会话面）。
- 会话结束钩子（成功/失败/销毁路径都跑）：核对 claim 未提交则记 failed/interrupted attempt + 清 claim；从活动执行登记清除。
- 无任务不建会话、不调模型；同一工作区一个唤醒槽——tick 与会话存活判定互斥，不重复建。

## 7. 身份绑定与工具面（tools.ts）

- 领取工具经工作区扩展工厂挂载，capability 门控：`work-items ∧ workflows` 均开启才注册；`automation.enabled=false` 时工具在但 claim 全部 400（提示未启用）。
- 工具回调中 role/sessionId/ownerToken 由**服务端扩展上下文**注入（pi 扩展回调可取得当前会话 id；ownerToken 存于角色会话的运行时登记，由 claim.ts 在该会话后续工具调用中按 sessionId 匹配核发）——LLM 参数中的 role 仅作展示，不作为身份。旧 loop 与普通会话不带执行身份：claim 一律 400「非角色执行会话」。
- 工具集：`delivery_list_ready_tasks`（读池投影+不可领原因）、`delivery_claim_task`、`delivery_submit_result`（designer：designContent + acceptanceCriteria）、`delivery_fail_task`。**不注册**：confirm/record-release/block/unblock/cancel 等人工动作的 agent 入口（人工动作走既有 UI/API，actor=user）。
- M2 的 managed 工具门控不变：`workspace_list_work_items` 默认仍排除 managed 项——delivery 工具是 managed 项的唯一 agent 入口，两个工具族互不越界。

## 8. 工作区配置与 API

- `.pi/delivery.yaml`（工作区根）：`schema_version: 1`、`enabled: bool`（缺省 false）、`roles: { designer: { profile?: string, model?: string } }`、`budget: { max_attempts_per_input: 3, max_execution_minutes: 30 }`。capability 校验：启用时要求 manifest 含 work-items+workflows，否则配置面报错不写入。
- HTTP（薄壳，错误沿用 workItemErrorResponse 惯例）：
  - `GET|PUT /api/workspaces/[id]/delivery`——配置读写（人工）。
  - `POST /api/workspaces/[id]/work-items/[key]/delivery-execution/stop`——停止活动执行（facade destroy + interrupted attempt + 门禁）。
  - `POST /api/workspaces/[id]/work-items/[key]/delivery-execution/recover`——重查恢复（对齐 M1 recover 语义：探测存活进程 → 409 / 干净 → 解除）。
  - `POST /api/workspaces/[id]/delivery/resume`——连续失败暂停后的显式恢复（人处理完阻塞后重开自动领取）。
- 事件类型：`delivery.claimed / delivery.submitted / delivery.attempt_failed / delivery.automation_paused / delivery.exec_interrupted / delivery.exec_recovered`，沿用 events.jsonl 追加审计。

## 9. UI（最小面）

- 工作项详情（中央页）：有活动领取/最近 attempt 时显示「活动执行」区——角色、generation、会话链接（复用关联会话打开路径）、开始时间、心跳状态；动作：「停止执行」。「自动领取已暂停（连续失败）」横幅 + 「恢复自动领取」。中断未确认时显示 M1 同款「执行中断，待恢复」+「重新检查并恢复」。
- 设置›工作区：交付自动化配置区（开关、designer profile 映射、预算只读展示）；完整角色编辑继续走既有 Agents 面。
- 右栏快捷面板与移动端详情同步显示活动执行摘要（共享 useWorkItems 快照 + 详情数据，无独立状态）。

## 10. 与既有机制的关系

- cxin dev-loop kit：原样运行不受影响；loop 轮会话领取 delivery 任务时按「普通会话」处理（无角色身份 → claim 400），互不越界。managed 项已从 loop 候选默认排除（M2 T6），自动执行不改变这一点。
- M1 执行中断记录（`lib/loops/executions.ts`）：本阶段**不混用**文件（loop 中断记 `.pi/runtime/executions/`，delivery 中断记 `<item>/delivery/attempts/`）——作用域不同（loop 级 vs 工作项级），但恢复判定与 UI 习语对齐。活动执行登记（markActive/clearActive）泛化共用。
- M2 双层写锁：claim/submit 全部在其窗口内；嵌套调用走 unlocked 变体（工作项服务已有先例）。
- 非 managed 项、旧 loop、导入脚本、回收站：行为不变。

## 11. 验证与交付顺序

拆分边界（非批准实施计划）：

1. **协议层**：pool 投影、claim/submit/fail/heartbeat 事务、幂等与并发（两个并发 claim 只成一个）、attempt/中断记录——程序化假 worker 测试，不建真会话。
2. **Dispatcher 与角色会话**：HostJob 装配、单槽位互斥、会话装配与结束钩子、心跳续约、超时停止。
3. **人工面**：配置区、详情活动执行区、stop/recover/resume 路由、UI 呈现。
4. **兼容与基线**：loop/工具族互不越界回归、AGENTS.md 更新。

必须覆盖的检查：

1. 两个并发 claim 同一 key 只有一个成功；同 requestId 重试不产生第二 attempt。
2. claim 后崩溃 / 提交后崩溃 / 关停中断——重启后门禁生效，恢复动作解除，不重复执行、不丢审计。
3. 过期 generation/ownerToken 的 submit/fail/heartbeat 被拒；迟到的旧会话提交不能改变新代状态。
4. requirementDigest 变化后旧领取提交 → 409 重新领取；需求变更失效回退（M2 规则）与领取互斥正确联动。
5. 连续 3 次失败 → 自动领取停止 + 事件 + UI 横幅；显式 resume 后恢复。
6. confirm-design/record-release 无任何 agent 工具入口；designer 提交后项停在 design 等人确认。
7. 无任务时 Dispatcher 不建会话不调模型；单工作区同时至多一个 designer 执行。
8. 既有回归：非 managed CRUD/导入/回收站/loop/子 agent/会话宿主全量测试不回退。
9. 端到端演示：创建 managed 项 → 自动化启用 → designer 领取起稿 → 会话结束 → 人在中央页确认设计 →（后续角色的接续点在 ready_for_implementation 等待）。

验证按实际变更运行 Node 测试、tsc、lint 与必要浏览器检查；不运行 next build。本次仅设计，不声称上述能力已实现。

## 12. 本设计的默认选择（用户审阅重点）

1. 首版只做 designer（起稿+验收条件，提交即停，人确认后流转）——后续角色分批接入同一协议。
2. designer 的提交物 = design.md 正文 + 结构化 acceptanceCriteria（存入 attempt 记录与 design.md 的「验收条件」节；M2 confirm-design 的 digest 绑定自动覆盖新内容）。
3. 单工作区单执行槽位；执行上限默认 30 分钟；心跳 20s；失联 90s 标记但不自动回收，恢复需人工确认（保守接手）。
4. 连续失败 3 次（同输入摘要）停止自动领取；显式 resume 恢复。
5. 配置放 `.pi/delivery.yaml`（工作区级、显式 opt-in，缺省关闭）；capability 门控 = work-items ∩ workflows。
6. delivery 工具族与 workspace 工具族分离（managed 项的 agent 入口只有 delivery 工具）；两族互不越界。
7. 中断记录按工作项存 `<item>/delivery/attempts/`，不与 M1 loop 级记录混文件；恢复习语对齐。
8. 后续阶段（不在本版）：developer（worktree 隔离+候选提交协议）、verifier（验证命令自动化+结构化检查）、release-preparer、多槽位、依赖图。

实施者自由度：模块文件名、pool 排序细节、UI 组件拆分、工具参数形状的次要字段；不可改变：六层归属、领取事务语义、人工门禁、单槽位与保守恢复、capability 门控、与 M1/M2 机制的对齐关系。
