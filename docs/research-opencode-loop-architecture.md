# OpenCode 与通用 Loop 架构：事实备忘

调研日期：2026-08-05。范围仅限 OpenCode 官方文档与 `anomalyco/opencode` 官方仓库；社区插件只作为“官方生态目录里列出的扩展”这一事实使用，不据其实现推断 OpenCode Core。

## 已证实事实

### 1. 常驻服务与外部触发入口

- `opencode serve` 会启动一个无头 HTTP 服务并暴露 OpenAPI；普通 `opencode` 也会同时启动 TUI 和服务端，TUI 是该服务的客户端。服务支持多个客户端，也可由程序调用。[Server — Overview / How it works](https://opencode.ai/docs/server/#overview)
- 服务端提供全局健康检查与全局 SSE 事件流：`GET /global/health`、`GET /global/event`。[Server — Global API](https://opencode.ai/docs/server/#global)
- 会话可通过 `POST /session` 创建；通过 `POST /session/:id/message` 同步发送消息，或通过 `POST /session/:id/prompt_async` 异步提交后立即得到 `204`。[Server — Sessions](https://opencode.ai/docs/server/#sessions)、[Server — Messages](https://opencode.ai/docs/server/#messages)
- 因此，外部 cron、消息消费者或 Webhook 服务可以把 OpenCode Server 当作“启动/推进一次 agent 会话”的执行接口。官方 Server 文档本身没有把这些来源抽象成统一的 trigger envelope；这是调用方要补的协议。

### 2. 定时、后台与调度

- 在本次审阅的官方 Server API、配置文档与 Agents 文档中，**没有找到已文档化的 Core cron/schedule API，也没有找到跨项目的定时任务注册表**。这里是“未在这些官方表面中找到”，不是对整个仓库做绝对不存在证明。
- OpenCode 官方生态目录把 `opencode-scheduler` 描述为用 macOS `launchd` 或 Linux `systemd`、以 cron 语法调度重复任务的生态插件；调度能力被列在 Ecosystem，而不是 Server Core API 中。[Ecosystem — Tools](https://opencode.ai/docs/ecosystem/#tools)
- 官方 Server Core 确实有异步 prompt，但“异步提交一次 prompt”不等于“保存 schedule、计算下次触发时间、做幂等和并发控制”。[Server — Messages](https://opencode.ai/docs/server/#messages)

### 3. Project / Workspace 作用域

- Server API 能列出所有已知项目并取得当前项目：`GET /project`、`GET /project/current`；同时提供当前 path、VCS 与当前 instance 的 dispose API。[Server — Project / Path & VCS / Instance](https://opencode.ai/docs/server/#project)
- OpenCode 同时支持全局配置 `~/.config/opencode/opencode.json(c)` 和项目配置；项目配置从当前目录向项目根查找并合并。[Config — Locations](https://opencode.ai/v2/docs/config#locations)
- 项目规则放在项目根 `AGENTS.md`，只在该目录及子目录工作时生效；也支持全局规则。[Rules — Types](https://opencode.ai/docs/rules/#types)
- 会话与消息数据按项目保存；官方排障文档说明 Git 仓库使用项目 slug 对应的存储，非 Git 目录进入 global storage。[Troubleshooting — Storage](https://opencode.ai/docs/troubleshooting/#storage)

这说明 OpenCode 有“一个服务看见多个项目”和“配置/会话按项目隔离”的基础，但官方 API 中未见“Workspace 向某个 Loop 注册表注册 Loop Definition”的领域对象。

### 4. Session 与 subagent

- OpenCode 明确区分 primary agent 与 subagent；primary agent 可自动调用 subagent，用户也可 `@` 调用。[Agents — Types / Usage](https://opencode.ai/docs/agents/#types)
- subagent 会创建 child session；TUI 提供从父 session 进入 child、在 children 间切换、返回 parent 的导航。[Agents — Usage](https://opencode.ai/docs/agents/#usage)
- Session API 原生支持 `parentID` 创建子 session，并能通过 `GET /session/:id/children` 查询 children。[Server — Sessions](https://opencode.ai/docs/server/#sessions)
- agent 可全局配置，也可按项目放在 `.opencode/agents/`；每个 agent 可以设置 prompt、model 和 permissions。[Agents — Configure](https://opencode.ai/docs/agents/#configure)
- 当前官方源码的 prompt 执行路径把 Task 调用写成父 session 的 tool part，调用专门 agent 执行 subtask，并把完成或失败结果更新回该 part；中断会 abort subtask。[`packages/opencode/src/session/prompt.ts`, Task execution path](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts#L2741-L2950)

OpenCode 因而比“临时 `--no-session` worker”多一层原生父子 session 语义；但该语义仍是 agent/session 执行机制，不自带 maker/checker、gate、Round 或 improve 的领域约束。

## 未在官方 Core 文档中找到的能力

以下能力不应当假定 OpenCode 已替 Loop 系统提供：

- Loop Definition 注册与版本化；
- cron / webhook / message 的统一 trigger 协议；
- trigger 幂等、同一 Loop 的并发策略与租约；
- Round 状态机与 gate 恢复；
- maker/checker 强制隔离及验证契约；
- 一轮结束后的 improve 回写策略；
- 跨多个 Workspace 的 Loop 运维视图。

## 可借鉴的实现构件

以下源码事实固定到调研时的 OpenCode `dev` commit [`4a57013c`](https://github.com/anomalyco/opencode/tree/4a57013cf8cb163f58638273fd9da8538cd33cb7)，避免后续分支移动使行号失真。

### 源码事实

1. **按目录缓存 Instance，并合并并发初始化。** `InstanceStore` 用规范化 directory 作 `Map` key；第一次加载先放入带 `Deferred` 的 entry，再 fork 初始化，随后到达的请求等待同一个 `Deferred`。初始化失败会移除 entry；reload 会原子替换 cache entry，dispose 只删除仍指向同一 entry 的值，避免旧清理误删新实例。[`project/instance-store.ts` L43-L151](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/project/instance-store.ts#L43-L151)
2. **请求先解析 Workspace，再注入 Instance context。** workspace routing 从 session 或 query 解析 workspace；本地 workspace 得到 directory，远程 workspace 转发到目标服务。instance middleware 随后由 directory 加载 Instance，并向请求 effect 注入 `InstanceRef` 与 `WorkspaceRef`。[`workspace-routing.ts` L151-L208](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts#L151-L208)、[`instance-context.ts` L20-L43](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts#L20-L43)
3. **异步 prompt 由服务端受管 scope 托管。** `promptAsync` 先确认 session 存在，然后把 prompt effect `forkIn(scope, { startImmediately: true })`；异步失败会记日志并发布 `Session.Event.Error`，HTTP 立即返回 no-content。[`handlers/session.ts` L311-L329](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L311-L329)
4. **每个 session 只有一个受管 runner。** `SessionRunState` 以 `sessionID` 保存 runner；runner busy 时拒绝第二个 shell/run，开始与结束分别设置 `busy`、`idle`。cancel 会同时取消与该 session、其 child/background metadata 关联的后台 job，再取消主 runner。[`session/run-state.ts` L38-L105](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/session/run-state.ts#L38-L105)、[`session/run-state.ts` L112-L143](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/session/run-state.ts#L112-L143)
5. **Session 是显式的 project/workspace/parent 记录。** Session schema/row 含 `projectID`、`workspaceID`、`parentID`；创建 child 时保存 parent，`children()` 按 `parent_id` 查询；删除会递归删除 children 并取消关联后台任务。项目列表查询默认按当前 project，且可继续按 workspace/directory/path 收窄。[`session/session.ts` L77-L128](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/session/session.ts#L77-L128)、[`session/session.ts` L598-L625](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/session/session.ts#L598-L625)、[`session/session.ts` L960-L1018](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/session/session.ts#L960-L1018)
6. **Task subagent 有完整的 parent/child、前台等待与取消生命周期；实验开关开启时还支持后台提升。** Task 创建 `parentID = ctx.sessionID` 的 child session，并记录 parent/child session 与 model metadata。同步模式等待 child 完成；`experimentalBackgroundSubagents` 开启时，后台模式立即返回 job/session id，完成后向 parent 注入 synthetic message。父调用 abort 或 effect interrupt 时，同时 cancel child prompt 与 background job。[`tool/task.ts` L145-L221](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/tool/task.ts#L145-L221)、[`tool/task.ts` L223-L360](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/tool/task.ts#L223-L360)
7. **状态变化与输出通过事件传播。** `SessionStatus.set()` 发布 status，进入 idle 时额外发布 idle 事件；instance SSE 在注册 listener 后使用无界 queue，按 directory/workspace 过滤事件，合并 dispose 信号与 10 秒 heartbeat，并在断连时解除 listener。全局 SSE 同样提供 heartbeat。[`session/status.ts` L27-L50](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/session/status.ts#L27-L50)、[`handlers/event.ts` L26-L96](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts#L26-L96)、[`handlers/global.ts` L33-L70](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts#L33-L70)
8. **文件型状态采用逐 key 可回收读写锁。** OpenCode 的 Storage service 为解析后的目标路径建立 `TxReentrantLock`，read 使用 read lock，write/update/remove 使用 write lock；锁放在带回收机制的 `RcMap` 中。[`storage/storage.ts` L218-L305](https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/storage/storage.ts#L218-L305)

### 对 Pi Loop 的设计推论

- `InstanceStore` 的 **keyed single-flight** 可直接映射为 `workspaceId/loopId` 的定义加载与初始化锁；但 Round 执行锁应另设，不能让“加载 definition”和“运行 Round”共用一把锁。
- `SessionRunState` 的 **per-session runner + busy/idle event** 可映射为 `per-loop concurrency policy`。v1 可先实现 `forbid overlap`；后续再添加 `queue-one`、`replace`，不能只依赖 Pi 会话当前是否 streaming。
- `promptAsync + managed scope + error event` 是 Trigger API 很好的下游形状：先持久化 Round，再异步 dispatch；HTTP 接收成功不等于 Round 成功，终态必须从 Round 状态或事件读取。
- Task subagent 的 metadata、级联取消和结果回注可用于设计 Pi Worker handle；不过 maker/checker 的产出仍应写入 Round artifact，而不能只以 synthetic chat message 作为事实来源。
- directory/workspace 事件过滤说明共享服务可以承载多 Workspace，但 Loop 事件还应带稳定的 `loopId`、`roundId`、`triggerId`，仅靠 directory/sessionID 无法做幂等与跨轮审计。
- 逐 key 读写锁适合保护本地 registry/state 文件的进程内竞争；若未来允许多个 Loop Service 进程，它不提供跨进程租约，需要 SQLite transaction、文件锁或单实例约束。

## 设计含义（推论，不是 OpenCode 事实）

1. 拟议架构方向合理，但应把组件命名拆清：共享的 **Loop Service** 负责 Registry、Trigger、Scheduler、Dispatcher；OpenCode/Pi 只作为 **Round Execution Backend**。
2. cron 表达式可归 Loop Definition（随 Workspace 版本控制），而计时与派发归共享 Loop Service。官方生态中使用 launchd/systemd 的 scheduler 也支持“外部计时器调用 agent”的方向，但它不证明应该照搬该插件实现。
3. OpenCode 的 `serve + project list + async prompt + child sessions` 能承载共享执行服务原型；它仍缺少 Loop 领域的注册、幂等、Round、Gate 和 Improve，因此不能把 OpenCode Server 直接等同于 Loop Service。
4. 对 Pi 的 v1，可保持已选方案：一个可见的 Round 主会话，maker/checker 是隔离 worker。将来若要像 OpenCode 一样提供可导航、持久化的 child sessions，可作为执行后端增强，不必改变 Trigger 与 Loop Service 契约。
