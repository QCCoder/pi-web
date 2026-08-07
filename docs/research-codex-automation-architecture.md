# Codex / ChatGPT Scheduled Tasks 与 Automation 架构事实备忘

> 调查日期：2026-08-05（Asia/Shanghai）  
> 范围：当前 Codex/ChatGPT 桌面端与本地 Codex Automations；不把 ChatGPT 云端 Scheduled Tasks 的行为直接套到 Pi。  
> 证据等级：**官方文档** > **当前 Codex App 暴露的工具契约** > **本机只读持久化样本**。后两者是实现快照，不是 OpenAI 承诺的稳定公共 API。

## 结论摘要

Codex 当前没有把“Loop”建模成一套 maker/checker/gate/improve 工作流 DSL。公开产品模型的核心是：保存一段 durable prompt、一个 recurrence、一个执行目的地，然后在到期时唤醒 agent。它明确支持两种不同的连续性语义：

1. **Standalone scheduled task / 本地工具契约中的 `cron`**：每次运行新建 chat，适合各轮独立或跨一个/多个 project 执行。
2. **Scheduled task inside a chat / 本地工具契约中的 `heartbeat`**：到期后回到同一 thread，复用既有对话上下文，适合轮询、跟进与直到条件满足的长循环。

官方文档要求 prompt 自己说明每轮做什么、什么值得报告、何时停止或向人提问；没有公开一个独立的结构化步骤图或 verifier/gate 状态机。[OpenAI Scheduled tasks：standalone 与 chat-attached 语义](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)、[OpenAI Scheduled tasks：durable prompt](https://learn.chatgpt.com/docs/automations#schedule-a-task-inside-a-chat)

## 1. 存储模型

### 官方公开事实

OpenAI 文档将 Scheduled Task 描述为可查看、暂停、恢复、编辑和删除的持久对象，并提供 Scheduled 视图查看 task 状态和近期 runs；但该文档没有公开其数据库表、文件布局或持久化事务模型。[OpenAI Scheduled tasks：管理界面](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)

### 当前本机 Codex App 快照

本机存在一份每 Automation 一个目录的 TOML：

```text
~/.codex/automations/<automation-id>/automation.toml
```

调查时唯一的样本包含以下字段：

```toml
version = 1
id = "automation"
kind = "cron"
name = "每日简报"
prompt = "..."
status = "ACTIVE"
rrule = "RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR"
model = "gpt-5.6-sol"
reasoning_effort = "medium"
execution_environment = "local"
target = { type = "projectless" }
cwds = ["~"]
created_at = 1785919499915
updated_at = 1785919499915
```

本机证据：[automation.toml](/Users/qiancheng/.codex/automations/automation/automation.toml)。当前 App 的 `automation_update` 工具契约还暴露 `notificationPolicy`、`projectId`、`destination`、`localEnvironmentConfigPath`，以及 heartbeat 使用的 `targetThreadId`。这说明定义对象至少保存 prompt、启停状态、recurrence、执行模型/强度和目的地；它没有证明 run history 也存进该 TOML。

**明确未知：** run history、下一次触发时间、租约/锁、重试计数和通知投递状态具体存在哪里，公开文档与当前样本均未说明。`~/.codex/automations/.run-jitter-salt` 的存在不能单独证明调度算法，故不据此推断。

## 2. Standalone 与 Thread Heartbeat

官方文档称 standalone task 的每个 scheduled run 都启动一个新 chat，并把结果报告到 Scheduled；同一个 standalone task 可在一个或多个 project 上运行。[OpenAI Scheduled tasks：standalone runs](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)

当任务附着在现有 chat 时，到期运行复用该 chat 的既有上下文，而不是每次从保存 prompt 启动新对话；官方列举的用途包括轮询长运行操作、检查 Slack/GitHub、延续 review loop、持续研究或 triage。[OpenAI Scheduled tasks：chat-attached tasks](https://learn.chatgpt.com/docs/automations#schedule-a-task-inside-a-chat)

OpenAI 的长任务白皮书把 Thread Automation 明确定义为附着到当前 thread 的 heartbeat-style recurring wake-up call；同一 thread 可以有多个 schedule，并可运行到某个条件满足、随任务变化调整 cadence。[Codex-maxxing 白皮书，第 15 页](https://cdn.openai.com/pdf/8a9f00cf-d379-4e20-b06f-dd7ba5196a11/OAI_WhitePaper_Codex-maxxing26.pdf#page=15)

当前 App 工具契约与此对应：默认将持续跟进建模为 `heartbeat` + `targetThreadId`；只有用户明确要求“每轮新任务”或独立 project 工作时才选择 `cron`。这是当前 App 的 agent-facing contract，不是对外 SDK。

## 3. Project、cwd 与 worktree 范围

对于 Git project，scheduled task 可选择直接在本地 project 或新 worktree 中后台执行；worktree 用于隔离 Automation 的改动，本地模式可能修改用户正在编辑的 checkout。非 Git project 直接在 project directory 运行。同一个 standalone task 可以关联多个 project。[OpenAI Scheduled tasks：project 与 worktree](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)

project-scoped 本地任务要求机器保持开机、桌面 App 运行，而且运行时选定 project 仍须存在于磁盘。[OpenAI Scheduled tasks：本地可用性条件](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)

官方还提醒频繁 worktree 调度会累计大量 worktree；应归档不再需要的 scheduled runs，且不要随意 pin run，因为 pin 会保留 worktree。[OpenAI Scheduled tasks：worktree cleanup](https://learn.chatgpt.com/docs/automations#worktree-cleanup-for-scheduled-tasks)

当前 App `automation_update` 的 cron 更新契约是**一个** `projectId` 加 `executionEnvironment: local | worktree`（兼有 `destination` 字段）。公开文档说一个 task 可跨多个 project，而本机单份 TOML 样本也有 `cwds` 数组；两者如何映射为内部 records 没有公开，不能假定是“一条 Automation record 对多个 project”或“每 project 复制一条 record”。

## 4. Recurrence 表示

公开文档明确支持自定义 cadence，并允许高级用户编辑 RFC 5545 RRULE，例如：

```text
RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0
```

[OpenAI Scheduled tasks：RRULE](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)、[RFC 5545 recurrence rule](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3)

当前本机 TOML 也直接保存带 `RRULE:` 前缀的字符串。官方文档称 chat-attached task 可使用 minute interval，也支持每日和每周的指定时间；但没有公开支持的完整 RRULE 子集、时区字段、DST 策略、misfire/catch-up 规则或 jitter 算法。[OpenAI Scheduled tasks：chat cadence](https://learn.chatgpt.com/docs/automations#schedule-a-task-inside-a-chat)

## 5. Run、状态、历史与通知

Standalone 每轮产生新 chat；chat-attached 每轮回到同一 chat。官方 Scheduled 视图是 task 与 runs 的 inbox：可查看 task 状态和近期 runs，带有未读指示，并让用户进入结果继续工作。[OpenAI Scheduled tasks：Scheduled inbox](https://learn.chatgpt.com/docs/automations#manage-scheduled-tasks)

Codex App 发布说明同样说 Automation 完成后，结果进入 review queue，用户可以进入结果继续处理。[Introducing the Codex app：Automations](https://openai.com/index/introducing-the-codex-app/#delegate-repetitive-work-with-automations)

ChatGPT Scheduled Tasks 的通知可在平台设置里管理；monitoring task 会记住先前 runs，只在有值得报告的变化时通知，并可在终止条件满足时停止。该条描述的是 ChatGPT Scheduled Tasks，不足以证明本地 Codex Automation 使用同一存储或通知实现。[OpenAI Help：Scheduled Tasks notifications and monitoring](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt)

当前 Codex App 更新契约提供 `notificationPolicy`；工具说明将“静音”映射为 `failed_runs_only`，恢复通知映射为 `null`。公开文档没有列出 Codex 本地通知策略枚举的完整集合，故不能据此设计一模一样的通知状态机。

## 6. 执行权限与无人值守

Scheduled tasks 无人值守执行并采用默认 sandbox 设置。组织策略允许时使用 `approval_policy = "never"`；若管理员禁止，则回退到所选权限模式的审批行为。官方建议从最窄权限开始，只在任务确实需要时开放网络或更多文件权限。[OpenAI Scheduled tasks：permissions](https://learn.chatgpt.com/docs/automations#permissions-and-security-model)

这意味着“人 gate”并不是 Codex Scheduled Task 调度器的公开一等状态；需要人判断时，实践上应把 run 结果放入 review queue、停在 thread 中请求输入，或把会产生外部副作用的动作明确限制为先准备后审批。白皮书示例也把草拟回复与最终发送决定分开。[Codex-maxxing 白皮书，第 18–20 页](https://cdn.openai.com/pdf/8a9f00cf-d379-4e20-b06f-dd7ba5196a11/OAI_WhitePaper_Codex-maxxing26.pdf#page=18)

## 7. Concurrency、幂等、失败与恢复：未公开部分

截至调查日期，下列机制没有在上述官方资料或当前 App 工具契约中得到足够说明：

- 同一 Automation 上一轮未完成时，下一次到期是跳过、排队还是并行；
- 跨 project 的 runs 是否可并发及其上限；
- 触发事件是否拥有稳定 trigger/run id，以及是否提供 exactly-once 或 at-least-once 保证；
- App 崩溃、机器睡眠、错过时刻后的 catch-up/misfire 行为；
- 失败重试次数、退避、死信或熔断策略；
- heartbeat 遇到正在运行或等待审批的 target thread 时如何仲裁；
- task 配置更新与到期 dispatch 之间的一致性/版本固定方式；
- run history 的保留期限与清理协议。

因此，Pi Loop 不能把这些行为当作“参考 Codex 即可获得”的默认保证；需要在自己的 runtime contract 中显式决定。

## 8. 对 Pi Loop 设计可安全借鉴的边界（推断）

以下是基于上述事实的**架构推断**，不是 Codex 已公开实现细节：

1. 将触发对象统一成 `Saved Prompt + Recurrence + Destination + Status`，而不是一开始发明完整 workflow DSL。
2. 显式提供两种 continuity policy：`fresh_session_per_round` 与 `resume_orchestrator_session`；不要用一个含糊的“Loop 会话”同时覆盖两者。
3. 将 schedule 与 task definition 持久化，将计时和 dispatch 放在宿主/共享服务，而不是 Pi extension factory。
4. 把 workspace/cwd 与 worktree isolation 作为每个 Loop 的执行目的地配置；Loop 定义可在 workspace 中做真相源，中央注册表只做索引。
5. 独立保存可审计的 Round record；不能只依赖长 thread 上下文表达跨轮状态。Codex heartbeat 可复用上下文是产品能力，但其并发与恢复协议未公开。
6. v1 就定义幂等键、同 Loop 并发策略和 misfire 行为，因为 Codex 公开资料没有可直接照搬的保证。

## 9. 不能从 Codex 参考中推出的能力

没有官方证据表明 Codex Automations 当前原生提供：maker/checker 强隔离、每步骤 verifier、结构化人工 gate、任务定义编译/确认、Round Plan 版本固定，或 improve 自动修改下一轮定义。Codex 的公开抽象更薄：instructions/skills + schedule + destination + thread/run + review。Pi 若需要这些能力，应把它们定义为自身 Loop 层的增量，而不是声称复刻 Codex。
