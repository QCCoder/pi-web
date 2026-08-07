# `cobusgreyling/loop-engineering` 与 Pi Loop 设想对照

调研日期：2026-08-07  
范围：仅审阅该项目仓库内 README、`docs/`、示例及仓库自己的 `LOOP.md`/`STATE.md`。下文先列项目事实，再单独给出比较推断。

## 一句话结论

两者的**设计思想高度相似**：都把 Loop 看成“反复触发的 agent 控制系统”，强调持久状态、Maker/Checker 分离、人工 Gate、运行证据和渐进放权。但它不是我们设想的那种“已实现的通用常驻 Loop Service”。已审阅资料把本仓库定位为 **Design 层的 patterns、starters 和 readiness 工具**；调度由各 agent 产品、cron/systemd、GitHub Actions 或自定义 harness 提供，runtime 则被列为独立 companion（Harness Foundry）。

## 已核实的项目事实

### 1. 这里的 Loop 是什么

- 项目把调度视为 Loop 的“heartbeat”；没有调度就只是一轮 agent run。它列出的实现方式包括产品内 `/loop`、scheduled tasks/cron、GitHub Actions/repository dispatch、`/goal` 和 custom harness scheduler。[`docs/primitives.md` L5-L16](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/primitives.md#L5-L16)
- 最小可用 Loop 被定义为“Scheduling + 一个 skill（triage）+ state file”；只有在产生实际需要后才逐步加入 worktree、sub-agent verification 和 connectors。[`docs/primitives.md` L80-L89](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/primitives.md#L80-L89)
- 仓库展示的典型单轮形状是：Scheduler → Skill → durable state → worktree → implementer → verifier → connector → safe auto path 或 human escalation → 回写 outcome。[`docs/architecture-diagrams.md` L4-L43](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/architecture-diagrams.md#L4-L43)

### 2. 触发与调度

- 调度机制是可替换的外部 primitive，不是该仓库声明的单一内置 scheduler；要求的性质是 interval、立即触发、单次/重复，以及重启后可持续。[`docs/primitives.md` L4-L16](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/primitives.md#L4-L16)
- 仓库自己的 Loop 同时采用工作日 GitHub Actions、人工 `/loop`、固定 cadence，以及 manual/tag-triggered 等方式。[`LOOP.md` L6-L32](https://github.com/cobusgreyling/loop-engineering/blob/main/LOOP.md#L6-L32)
- OpenCode 示例明确写的是 cron/systemd 配合 `opencode run`，不是由 loop-engineering 常驻服务计时。[`examples/opencode/README.md` L1-L13](https://github.com/cobusgreyling/loop-engineering/blob/main/examples/opencode/README.md#L1-L13)
- 在已审阅来源中，**未找到**统一的 `TriggerLoop` HTTP/API 契约、`triggerId` 幂等去重协议，或用于多个 Workspace 的常驻注册/派发 daemon。

### 3. 是否有常驻 Service / CLI

- 项目提供 `loop init`、`doctor`、`status`、`audit`、`cost` 等脚手架和检查 CLI；其架构图把本仓库工具描述为 Design/Control/Memory/Execution 所需的若干工具，而非一个单体长期运行服务。[`LOOP.md` L59-L69](https://github.com/cobusgreyling/loop-engineering/blob/main/LOOP.md#L59-L69)；[`docs/architecture-diagrams.md` L79-L128](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/architecture-diagrams.md#L79-L128)
- 在已审阅来源中，**未找到**类似 `loop serve` 的常驻进程、跨 Workspace Registry、中央 Round Dispatcher 或统一事件流。

### 4. Project / Workspace 范围和多 Loop

- 文档明确认为一个 repo 运行多个 Loop 是正常情况；不同 Loop 应有独立 state file，共用 denylist 和汇总 token budget，并为冲突 Loop 定优先级。[`docs/multi-loop.md` L1-L29](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/multi-loop.md#L1-L29)
- 推荐把各 Loop 的 schedule 写进 repo 根部 `LOOP.md`；碰撞检测依赖各 state file 的 `acting_on` 字段、append-only run log，以及可选 advisory path lock。[`docs/multi-loop.md` L29-L56](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/multi-loop.md#L29-L56)
- 仓库自己的 `LOOP.md` 也在一个文件中列出多个 active loop，而不是要求 `loops/<loopId>/` 自包含目录。[`LOOP.md` L6-L35](https://github.com/cobusgreyling/loop-engineering/blob/main/LOOP.md#L6-L35)
- 在已审阅来源中，**未找到**跨多个 Workspace 的全局注册模型，也没有规定“一 Loop 一目录”的强制结构。

### 5. 编排与 agent/sub-agent

- Sub-agent 的核心模式是 Maker/Checker 分离：第二个 agent 使用不同 instructions（有时用更强模型）做独立验证；示例拆分包括 Explorer → Implementer → Verifier、Implementer → Security reviewer、Implementer → Test writer/runner。[`docs/primitives.md` L50-L62](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/primitives.md#L50-L62)
- 单轮架构明确显示 Triage Skill 把任务交给 Implementer，再把 patch 交给 Verifier；验证通过后才进入 connector 和 gate，失败则记录并报告。[`docs/architecture-diagrams.md` L18-L42](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/architecture-diagrams.md#L18-L42)
- 在已审阅来源中，**未找到**跨工具统一实现的 orchestrator runtime、可执行步骤 DSL、固定 `agent.md`/`subagent-*.md` 文件契约，或“AI 先推断 Plan、用户确认后再执行”的编译阶段。

### 6. Verification 与 Human Gate

- Run lifecycle 明确包含 `Verifying`、`AwaitingHumanGate`、`Applied`、`Rejected`、`Failed` 和最终 `Logged`；风险操作通过 human 或 allowlist 批准。[`docs/architecture-diagrams.md` L44-L66](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/architecture-diagrams.md#L44-L66)
- 自治度分 L1 report-only、L2 assisted、L3 unattended；升级到 L3 要求 denylist、budget 和 gates 已被证明有效，发生事故或成本激增时可降级，并保留 kill switch。[`docs/architecture-diagrams.md` L67-L78](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/architecture-diagrams.md#L67-L78)
- 仓库自己的规则要求 dependency sweeper 跑完整测试，对 major/denylisted package 走 human gate；`loop-gate` 从 `gate.yaml` 机械执行 denylist 和 auto-merge allowlist。[`LOOP.md` L18-L23](https://github.com/cobusgreyling/loop-engineering/blob/main/LOOP.md#L18-L23)；[`LOOP.md` L53-L58](https://github.com/cobusgreyling/loop-engineering/blob/main/LOOP.md#L53-L58)

### 7. State、Evidence 与持久化

- 项目明确假设模型跨 turn/session 没有长期记忆，因此 Loop 必须读写 durable store；例子包括 repo 内 `STATE.md`/`LOOP-STATE.json`、项目管理工具或数据库行。State 要回答当前工作、上次尝试结果和等待人工事项。[`docs/primitives.md` L63-L77](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/primitives.md#L63-L77)
- 多 Loop 推荐独立 state files 加共享 append-only `loop-run-log.md`。[`docs/multi-loop.md` L10-L19](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/multi-loop.md#L10-L19)
- 最小 run log 包含 run id、pattern、耗时、发现项、动作、升级次数、token 估计和 outcome；同时建议跟踪 runs、actionable findings、false positives、human escalations 和 cost 等周度指标。[`docs/operating-loops.md` L41-L78](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/operating-loops.md#L41-L78)

### 8. “越来越好”是什么机制

- 仓库提供的明确反馈机制是**观测后渐进放权/降权**：L1 先稳定 1–2 周，再加入小型自动动作、verifier、worktree 和 max attempts，最后才进入具备 denylist、budget、metrics 和 human gates 的 L3；新 pattern 不允许直接跳过 L1。[`docs/operating-loops.md` L102-L115](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/operating-loops.md#L102-L115)
- 运行指标有明确的减速/暂停/终止阈值，例如 false positive rate、重复 escalation、成本价值比和生产事故。[`docs/operating-loops.md` L79-L101](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/operating-loops.md#L79-L101)
- 架构图呈现 `Audit → Design` 的反馈边；也就是说审计结果回到人维护的 Loop 设计。[`docs/architecture-diagrams.md` L108-L128](https://github.com/cobusgreyling/loop-engineering/blob/main/docs/architecture-diagrams.md#L108-L128)
- 在已审阅来源中，**未找到**每轮结束由 Improver agent 自动总结经验、自动修改 Memory，或生成 Plan/规则 patch 并等待确认的通用协议。

## 与我们拟议 Pi Loop 的比较（推断，不是上游项目事实）

| 轴 | 相似处 | 关键差异 |
|---|---|---|
| Loop 形状 | 都是重复触发 → 读状态 → maker → checker → gate → 回写结果 | 该项目给 patterns/工具组合；我们在考虑一个真正负责注册、去重、派发和创建 Pi 主会话的 runtime |
| 任务定义 | 都倾向把项目意图留在 repo 文件中（`LOOP.md`、skills/state） | 该项目未规定每 Loop 自包含目录，也未规定 AI 推断/人工确认后的结构化 Plan |
| 触发 | 都允许定时、手动和事件触发 | 上游将 scheduler 交给宿主/cron/Actions；我们的统一 Trigger API 和本地常驻 Service 是新增能力 |
| 多 Loop | 都承认一个 Workspace/repo 内不同 Loop 的步骤与状态不同 | 上游主要靠根 `LOOP.md`、多个 state file 和 advisory lock；我们拟用 `loops/<loopId>/` 隔离定义、agents、memory 和 runs |
| Agent | 都强调 Maker/Checker 分离 | 上游是跨工具概念模式；Pi 方案需要具体决定主 AgentSession 和临时 worker 的生命周期 |
| Gate | 都要求危险/含糊动作升级给人，并保留 allowlist/denylist | 上游没有定义 Pi 会话如何持久暂停和 resume，这会是我们的 runtime 语义 |
| 证据 | 都把 durable state、run log、失败与人工决定视为核心 | 我们若引入统一 Round evidence schema，会比该项目更强、更重 |
| Improve | 都主张从真实运行和 failure modes 渐进增强 | 上游主要是人工审计、指标和自治度升级；“每轮自动 improve”不是已发现的现成实现 |

## 可直接借鉴与不应误抄

可直接借鉴的最小集合：

1. v0 从“schedule + task/skill + durable state”开始，不先造完整 workflow DSL。
2. 有自主动作时再强制 Maker/Checker、worktree 和 gate。
3. 一个 Workspace 可以有多个 Loop，但必须隔离 state、处理碰撞，并共享安全边界。
4. 每轮至少写 run log；用 false positive、失败、人工升级和成本决定增强、降级或停止。

不应把以下内容误认为上游已经解决：

- 多 Workspace 常驻注册服务；
- 统一 Trigger API、幂等去重和 Round Dispatcher；
- Pi 主会话/临时 worker 的具体实现；
- 每 Loop 目录契约；
- 推断 → 确认 → 执行的 Plan 编译流程；
- 每轮自动自修改规则的 Improve engine。

这些如果要做，属于 Pi Loop 的产品/运行时创新，而不是复刻该仓库。
