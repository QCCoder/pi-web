> **已退役（2026-09）**：v3 loop 引擎已被 pi-loop kit 取代，本文仅作历史参考。
> 现行设计见 `docs/pi-loop-kit-design.md`。

# dev Loop v3 设计：loop 降级为「选品 + 播种器」，执行归普通会话 + skill

> 状态：设计已确认（2025-06 与用户逐题 grilling 定稿）。前置：v2（`docs/dev-loop-v2-design.md`）。
> 一句话：**cron 选品回合只挑活并播种；执行是挂在工作项上的普通会话，跑 dev-loop skill 合同；gate 就是对话里的一句话 + 里程碑戳兜底。**

## 1. 背景与动机

v2 把「研发纪律」（L0/N1-N3、角色菜单、派发计划、md 契约、gate 协议）全部写进 loop 专属的 `LOOP.md`，由 loop 引擎驱动专属「编排会话」执行。两个结构性问题：

1. **合同锁死在 loop 里**。下午想亲自盯一个 bug 走同样的 maker≠checker 流程，唯一办法是等 loop 触发或手贴 LOOP.md。纪律本该是任何会话都能装载的东西——这是 skill 的活。
2. **「执行会话是 loop 特有怪种」催生了一片补丁**：gate 重水化、孤儿 gate 回收、LoopStatusBar、编排会话 409 禁输入、pin/reprobe、sessionNamer 反扫工作项、归档联动。对话挂在需求/bug 上之后，这些补丁大部分自然溶解。

v3 的分界线：**引擎保留机制（cron、dedup、超时、播种），合同变成 skill（任何会话可装载），工作项是对话的锚**。

## 2. 目标形态

```
cron(30min) → 选品回合(薄 LOOP.md ~15行)
                │ 活性判定 + 泊车关键词 + 挑 KEY
                │ 输出 LOOP_SEED: <KEY>  (唯一保留的机器可解析标记)
                ▼
        引擎确定性播种(代码,非LLM):
          createSession(普通会话, extraAgentDirs=<ws>/.pi/agents)
          种子 prompt = "/skill:dev-loop 执行 REQ-xxxx"
          写 conversations + 盖 loop.started + loop.active_session 戳
          → 撒手
                ▼
        执行会话(普通会话, 跑 skill 合同):
          开场: 三重判定/证据包/薄SPEC (predictedConf 定稿)
          角色派发: subagent(.pi/agents 下, 免审批)
          gate: terse 提问 → 盖 loop.gate 戳 → 本轮自然结束 → 人在输入框回话
          终态: 里程碑盖戳, 清 active_session
```

人工入口与 cron 入口**完全对称**：工作项详情「按合同执行」按钮 = 同一份种子 prompt（收养场景换收养版种子词）。人可随时插话，输入框永远可用（今日编排会话做不到）。

## 3. 决策记录（grilling 定稿）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 僵尸执行会话谁重启 | **只提醒不重启**：选品回合 idle 报告列「疑似中断」（>2h 无活动），人决定是否点「按合同执行」收养。不自动重启（误判活会话 = 双 implementer 打同分支，唯一能造成 git 实损的事故模式） |
| 2 | 并发守卫 | **机制硬拦**：引擎盖 `loop.active_session: <sessionId>` 戳；播种/按钮检测戳 + daemon probe 存活即拒绝；探针失败（会话已死但戳在）自动放行并覆盖戳（兼作收养语义）。唯一用机制而非合同的地方——这是人肉入口竞态，合同管不住 |
| 3 | 角色安家 | `<workspace>/.pi/agents/`；daemon `POST /v1/sessions` 加可选 `extraAgentDirs` 透传，播种代码统一携带（免 `confirmProjectAgents` 审批）。后期可上移 pi 全局层复用（本期不做） |
| 4 | skill 激活 | **种子 = `/skill:dev-loop <terse 参数>`**，走 pi RPC 层 input expansion 机制性注入（SKILL.md 全文 + `User: <args>`），不赌模型主动 read / description 匹配。前置引读（AGENTS.md/README）写进 SKILL.md 正文第一步。skill 必须同时进 manifest（workspace `skillsOverride` 过滤同样作用于 expansion 查找） |
| 5 | 三重判定归属 | **全搬进 skill 开场**：loop 回合只剩活性判定+泊车关键词+挑 KEY。predictedConf 在执行开场定稿，双入口同时点同方式产生（校准链源头一致性） |
| 6 | 迁移 | **一刀切**：新链路全量上线 + 老机制同一次切换全拆，不留双轨。缓解：拆改前全量 `npm test` 基线、每层独立 commit、文档同步、git revert 整体回退兜底 |

## 4. 合同搬家（workspace-c 侧）

### LOOP.md（95 行 → ~15 行，只做选品）

保留：活性判定（新活=`phase==intake` 且无 `loop.parked`；收养提示改为「疑似中断」报告——见决策 1）、泊车关键词过滤（排查/刷数据/迁移等运维类）、挑首个可自主 TDD 候选（最多前 3 个）。
输出协议：`LOOP_SEED: <KEY>` / `LOOP_VERDICT: idle`（附 `pendingVerify` 列表）/ `decision=park-all`。
**删除**：三重判定、证据包、数据流快筛、代写薄 SPEC（全搬 skill 开场）；六角色菜单、L0/N1-N3、派发计划、md 契约、gate 规则、反自欺表（全搬 SKILL.md）。

### 新 SKILL.md（`<workspace>/.agents/skills/dev-loop/SKILL.md`）

v2 LOOP.md 正文原样搬家，仅改三处：

1. **`LOOP_GATE:` 协议删除** → 「terse 提问（一次性问全、gate 消息 terse）→ **前置盖 `loop.gate{kind,question}` 戳** → 本轮自然结束，等答复」。plan gate / final-verify / 合同修正 gate 三种 gate 同语义。人在输入框正常回话即续轮（普通会话冷启动复活，无需重水化）。
2. **`LOOP_VERDICT:` 删除**（那是 loop 回合协议，普通会话以终态里程碑表达收尾）。
3. **新增开场步骤**（吸收 selector 判定职责）：读工作区 AGENTS.md + 工作项 README → 三重判定（`predictedConf` 定稿不可变 / `verifiable` / `riskTier`）→ 数据流快筛 → 证据包 → 纯展示类（零跨层零查询跳）代写薄 SPEC.md → 组合派发计划初版盖 `loop.dispatch`。收养版开场：读 dispatch 计划 + 里程碑盖戳缺口，从缺口续。

### 角色文件

`brainstorm/implementer/checker/learner/writing-plans` 五个 md → `<workspace>/.pi/agents/`（subagent 原生发现 + extraAgentDirs 免审批）。**selector 退役**（职责已拆：选活归薄 LOOP.md，判定归 skill 开场）。文件内容除 selector 引用外基本不动。

### 不动的东西

`loop.yaml`（cron 触发）、`RUNS.jsonl`（继续记录选品回合，Loop 视图仍有内容）、`LEARN/` 档案、kb `learnings/`（learner 合同不变：写档案 + 泛化测试 + contentHash 守护合并）、`AGENTS.md`（站点政策继续是 L0 引用的单一基线权威）。

## 5. 播种机制（pi-web 引擎侧）

选品回合结束，runtime（确定性代码）regex 到 `LOOP_SEED: <KEY>` 后：

1. **守卫**：查工作项 `loop.active_session` 戳 → 有戳则 daemon probe（`GET /v1/sessions/:id`）→ 活着（200）则跳过播种（记一条 run 快照 `skipped_duplicate`）；死了放行并覆盖戳。
2. `createSession`：cwd=工作区根，普通会话（非 subagent child、非 orchestrator），`extraAgentDirs=[<ws>/.pi/agents]`，首条 prompt = `/skill:dev-loop 执行 <KEY>`。
3. 落账：会话 id 写入工作项 `conversations` + 盖 `loop.started` 里程碑 + 盖 `loop.active_session` 戳 + 选品 run 快照记 `seededSessionId`（引擎代写，遵循「确定性 I/O 不交给 LLM」既有原则）。
4. **撒手**：执行会话生命周期与 loop 引擎脱钩。`RUN_TIMEOUT_MS`（30min）只管选品回合。

「按合同执行」按钮走同一份播种代码（参数：KEY + 模式 execute|adopt）。收养模式种子词 = `/skill:dev-loop 收养 <KEY>`，开场步骤切收养版（读缺口续跑）。

引擎小改汇总：`POST /v1/sessions` 加可选 `extraAgentDirs`（~10 行）；runtime 加 `LOOP_SEED` 解析 + 播种逻辑；退役清单见 §7。

## 6. 执行会话生命周期

- **gate**：提问 → `loop.gate{kind,question}` 戳（events.jsonl）→ 轮结束。UI 读戳渲染「待裁决」徽章；人回话即续。无专用 gate bar、无 409、无重水化。戳缺失即审计信号（反自欺表兜底：模型该问没问 = 合同违规，事后可见）。
- **终态**：`complete`+`done` / `blocked` 里程碑即终态。**戳语义防漏清**：守卫判定的权威是「戳 + probe 结果 + 工作项 phase」三者的确定性组合——工作项已终态 phase，或戳指向的会话 probe 不通（已死/已归档），戳即失效放行；漏清的陈旧戳永远无害，不需要任何后台清理。
- **僵尸发现**：选品回合顺带扫「非终态 phase + 执行会话 >2h 无新事件」→ idle 报告列「疑似中断: REQ-x」。只提醒（决策 1）。
- **人插话**：执行中任何时点可在输入框插话（steer/followUp 语义由 pi 原生处理）。这是新增能力。
- **孤儿进程回收**（`process-cleanup.ts`）保留，触发点从「回合拆除」挂到「执行会话 destroy」。

## 7. 退役清单（一刀切，随新链路同批拆除）

| 层 | 拆除物 |
|----|--------|
| runtime/store | gate 状态机（`waiting_for_gate`/`answerGate`/`resumeRound` 重水化）、`reapOrphanedGates`、gate 快照字段 |
| host | gate 路由（`/gate/approve|reject`）、sessionNamer 注入、编排会话 probe 的 `loop.run` 载荷 |
| web 路由 | `/api/workspaces/[id]/loop/runs/[runId]/gate`、runs 路由的 work-item join 收缩（选品回合无工作项关联） |
| 前端 | LoopStatusBar + `loopPollTarget` + `useAgentSession` 的 pin/reprobe/`loopOwned`/`loopRunMeta`、编排会话禁输入逻辑（`ChatInput.disabledNotice` 的 loop 分支） |
| session-tags | `loopOrchestrator`/`loopWorkItem` 反扫 join 及 30s 缓存（执行会话经 `conversations` 天然挂在工作项下） |
| pi-execution | 长回合 `capturePrompt`/gate 保活/`runAgentDirs` 跨 gate 保留（选品回合短平快） |

Loop 视图（侧栏）保留：选品回合 run 记录照列；run 记录点击行为 = 若该 run 播种了会话则直接打开该会话（RUNS 快照记 `seededSessionId`）。

## 8. 风险与取舍（明说）

- **无人值守执行会话无 30 分钟硬上限**。控制 = 合同纪律（rework ≤5、重规划 ≤2）+ UI 随时可见可停 + 里程碑审计。接受。
- **纪律从机制强制降为合同约束**：模型可能不停下等 gate / 不盖戳。兜底 = `/skill:` expansion 确保合同全文在上下文 + 戳缺失即审计信号 + 反自欺表。接受（决策来源：grilling gate 降级确认）。
- **一刀切迁移**：中间态不可运行、回归在生产工作区现形。缓解 = 全量测试基线 + 每层独立 commit + 文档同步 + git revert。接受（用户明确选择）。
- 选品回合每 30 分钟一个小会话（idle 居多）——与今日同，成本不升。

## 9. 不做的事（out of scope）

- 角色上移 pi 全局层（`~/.pi/agent/agents/`）——后期复用时再做。
- `auto_adopt` 自动收养开关——先提醒模式，痛了再加。
- 引擎对执行会话的任何监控/干预——撒手就是撒手，人看 UI。
- LEARN.jsonl 解冻、kb 结构变更。

## 10. 迁移步骤（一刀切内的顺序）

1. workspace-c：写 SKILL.md + 迁五角色 + 薄 LOOP.md + skill 进 manifest（一次 commit，旧文件删除）。
2. 引擎：`extraAgentDirs` 透传 + `LOOP_SEED` 解析 + 播种 + 守卫戳 + 按钮（含测试）。
3. 退役：按 §7 清单逐层拆（daemon → 路由 → 前端），每层独立 commit，全量 `npm test`。
4. 文档：AGENTS.md（本文件 Loop 节）、`docs/loop-runtime.md`、workspace-c 的 `AGENTS.md` 同步。
5. 真实验证：手动触发选品回合 → 观察 seed → 执行会话跑合同 → 中途插话 → gate 回话 → 终态清戳。
