# Loop Runtime

`pi-loop` 是独立于 Pi Web 的本地常驻进程。Workspace 拥有 Loop 定义；Host 只负责触发、去重、Round 状态、Pi 会话和证据落盘。

## 启动

```bash
npm run loop
```

默认监听 `127.0.0.1:30142`。可通过 `PI_LOOP_HOST`、`PI_LOOP_PORT` 修改监听地址，通过 Pi Web 的 `PI_LOOP_URL` 指向它。Loop Host 目前假设运行在与 Workspace 同一台受信任机器上，不应直接暴露到不受信任网络。

## Workspace 契约

```text
workspace/
  AGENTS.md
  loops/<loop-id>/
    loop.yaml       # 身份、启用状态、Autonomy Level、触发源
    LOOP.md         # 目标、Maker/Checker、验证标准、Gate、Improve 边界
    STATE.md        # 只保存已经验证且下轮需要的状态
    RUNS.jsonl      # Host 追加的 Round 状态与证据快照
    agents/         # 可选的任务专用 worker instructions
    audit/          # Improve 和人工审计材料
```

`loop.yaml` 的最小例子：

```yaml
schema_version: 1
id: daily-check
name: Daily Check
enabled: true
autonomy: L1
triggers:
  - id: daily
    type: cron
    expression: "0 9 * * *"
    timezone: Asia/Shanghai
    enabled: true
  - id: manual
    type: manual
    enabled: true
```

Cron 使用标准五字段（minute hour day-of-month month day-of-week）；支持 `*`、逗号、范围和步长。

## 一轮交互

1. 任意 Trigger Source 向统一入口提交稳定 `eventId`；重复 id 返回原 Round。
2. Host 创建 Pi Orchestrator Conversation，让 AI 读取 `LOOP.md` 和 `STATE.md`，只推断执行结构。
3. Round 进入 `waiting_for_confirmation`；Pi Web 展示 Maker、Checker、Gate 和 Improve。
4. 创建者确认后，Host 在同一个 Pi 主会话继续执行；拒绝则 Round 结束为 cancelled。Maker/Checker 作为**隔离子 agent 会话**运行——编排器用 `subagent` 工具派生，每个子会话可独立查看（侧边栏里挂在编排器会话下，跑完持久化在磁盘）。
5. 每次状态变化追加到 `RUNS.jsonl`。执行状态和业务 verdict 分开记录。

### 子 agent 依赖

Maker/Checker 走通需要该 Loop workspace 具有 `subagent` capability（编排器会话才会拿到 `subagent` 工具）。`execute()` 会先探测工具是否存在：有则让编排器用 `subagent` 派生 maker/checker；没有则回退到编排器自行执行（仍保持 producer/verifier 分离）。给 workspace 提供 `.pi/agents/maker.md` 与 `.pi/agents/checker.md`（或用内置 `general`）即可被按名派生。

当前骨架已经留出消息/webhook Trigger 与 Round Gate 的统一接口；首个跑通的 Adapter 是 cron 和手动触发。Host 重启后可读取证据，但不会续接尚未确认或尚未完成的 Pi 会话，这属于下一阶段的恢复策略。
