> **已退役（2026-09）**：v3 loop 引擎已被 pi-loop kit 取代，本文仅作历史参考。
> 现行设计见 `docs/pi-loop-kit-design.md`。

# Loop Runtime（v3）

`pi-loop` 是独立于 Pi Web 的本地常驻进程（同时是 THE session daemon，见根 AGENTS.md「session daemon」节）。v3 起 Loop 的职责收窄为**选品 + 播种**：一轮 run 就是一次短的选品回合；真正的执行是挂在**工作项上的普通会话**，装载该工作区自己的 dev-loop skill 合同（`docs/dev-loop-v3-design.md`）。

## 启动

```bash
npm run loop    # 或由 npm run dev 以 sidecar 自动拉起
```

默认监听 `127.0.0.1:30142`（`PI_LOOP_HOST`/`PI_LOOP_PORT`/`PI_LOOP_URL`）。Loop Host 假设运行在与 Workspace 同一台受信任机器上，不应直接暴露到不受信任网络。

## Workspace 契约（v3）

```text
workspace/
  AGENTS.md                          # 站点政策：分支纪律、gate 命令、敏感清单（L0 引用的单一权威）
  .agents/skills/<loopId>/SKILL.md   # 执行合同（原 LOOP.md 的策略部分；开场判定+SPEC+maker/checker+gate 语义）
  .pi/agents/*.md                    # 角色文件（subagent 按名发现；播种时经 extraAgentDirs 免审批注入）
  loops/<loop-id>/
    loop.yaml       # 身份、启用状态、触发源
    LOOP.md         # 薄选品合同（~15 行）：活性判定 + 泊车关键词 + 挑 KEY → LOOP_SEED
    RUNS.jsonl      # Host 追加的选品回合快照（dedupe 最新一条 per run）
    LEARN/          # 每 run 的学习档案（纯人翻，无流程读它做决策）
    audit/          # 审计材料
```

约定：**loop id === skill 名**（`dev-loop` → `/skill:dev-loop`），skill 必须同时列进 manifest `skills:`（workspace 会话按 manifest 过滤 skills，`/skill:` 展开同样走这套过滤）。

## 一轮选品（run 生命周期）

`queued → running → succeeded | failed`（没有 gate 状态了）：

1. Trigger（cron/manual）带稳定 `eventId` 提交；重复 id 返回原 run（30 分钟 cron 由 `LoopHostScheduler` 每分钟槽去重）。
2. Host 起一个编排会话（`__loop_host__<runId>`），薄 LOOP.md 作为首条 prompt。30 分钟超时只管这一回合。
3. 回合落定，引擎（确定性代码，非 LLM）解析输出：
   - `LOOP_SEED: <KEY>` → **播种**（`lib/loop/seed.ts`）：守卫 → 建普通执行会话（种子 prompt `/skill:<loopId> 执行 <KEY>`，`.pi/agents` 注入）→ 写 `conversations` + 盖 `loop.started`/`loop.active_session` → 撒手。run 快照记 `seededSessionId`。
   - `LOOP_VERDICT: idle` / `park-all` → 终态，verdict 落快照（idle 附 待人工验证 + 疑似中断 清单）。
4. 之后引擎不再跟踪执行——执行会话是普通会话，gate 是对话里的一句话（发问前必盖 `loop.gate` 里程碑戳，UI 靠它渲染「待裁决」徽章），人随时可插话。

## 播种与双开守卫（`lib/loop/seed.ts`）

两个入口共用同一份确定性播种代码：cron 选品后引擎自动播种；工作项详情「按合同执行/收养续跑」按钮（`POST /api/workspaces/:id/work-items/:key/run-contract` → daemon `POST /v1/workspaces/:id/seed`）人工播种。

守卫 = `loop.active_session` 戳 + 会话存活探测 + 工作项终态 三者的确定性组合：
无戳 → 放行；工作项已终态 → 放行（陈旧戳永远无害，无需清理）；戳的会话 wrapper 活着 → 拒绝（「已有会话在跑」）；idle 但 2h 内有活动 → 拒绝（gate 暂停中/人驱动）；idle 超 2h 或文件已没了 → 放行（僵尸 → 收养）。

僵尸不自动重启（决策：提醒不重启）——选品回合 idle 报告列「疑似中断」，人决定是否点收养。

## 子 agent 依赖

`subagent` 是全局能力。角色文件住 `.pi/agents/`：普通会话按 project 源发现（首次带审批弹窗）；播种的执行会话经 `StartSessionOptions.extraAgentDirs` 注入（可信源，免审批）。编排选品回合仍会注入 `loops/<loopId>/agents/`（如存在）——薄选品回合一般用不到角色。

## 已退役（v3 一刀切）

gate 状态机（`waiting_for_gate`/`answerGate`/`resumeRound` 重水化）、孤儿 gate 回收、host probe 的 `loop` 载荷、`sessionNamer` 注入、web 端 LoopStatusBar 与 gate 答复拦截、session-tags 的 conversations 反扫 join（`loopWorkItem`）。选品编排会话继续打 `loopOrchestrator` 标记并从会话列表隐藏——唯一入口是 Loop 视图 run 记录（优先打开 `seededSessionId` 指向的执行会话）。

已知取舍：用户强杀一个正在跑的执行会话可能遗留孤儿构建进程树——与今天任何普通会话被杀的暴露面一致；缓解 = 疑似中断报告 + 人工清理。
