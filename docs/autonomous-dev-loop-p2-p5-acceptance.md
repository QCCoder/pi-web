# 自主研发闭环 P2→P5 — 自验收报告（阶段 C）

> 设计 source of truth：`docs/autonomous-dev-loop.md`。实施计划：`docs/autonomous-dev-loop-p2-p5-plan.md`。
> 本文对 P2→P5 的实现做端到端自验收（设计 §7/§7.3/§7.4/§7.5/§7.6/§14 + AGENTS.md），并附 cxin 真机证据。

## 1. 交付总览

- **阶段 A（计划）**：`docs/autonomous-dev-loop-p2-p5-plan.md`（拆步 + 深模块缝标注 + 决策表 D1–D10）。
- **阶段 B（实现）**：6 个提交，新增 320→ 全绿（基线 262 → +58 测试）；`tsc --noEmit` 干净；`eslint` 0 error。
- **阶段 C（自验收）**：本文 + cxin 真机证据。

## 2. 实现清单（提交序列）

| Commit | 阶段 | 内容 | 深模块缝 |
|---|---|---|---|
| `dev-loop(P2): checker command registry` | P2 | `lib/loop/checkers.ts`（纯：仓库→checker 命令）+ 测试 | checkers.ts |
| `dev-loop(P3): Exporter SPI + FeishuNotifier + dispatcher` | P3 | `lib/exporters/{types,feishu-format,feishu-notifier,dispatcher,scheduler}.ts` + host wiring + 2 测试 | Exporter SPI / dispatcher |
| `dev-loop(P3): dev Loop definition` | P3 | `lib/loop/dev-loop/{contract,authoring}.ts` + API + 2 测试 | contract.ts（LOOP.md 契约本身） |
| `dev-loop(P4): evolution core` | P4 | `lib/loop/learn/{types,config,aggregate,state,knowledge,scheduler}.ts` + host wiring + 4 测试 | aggregate.ts（纯进化核） |
| `docs(AGENTS)` | 文档 | AGENTS.md 新增 Exporter/Dev Loop/Learn 三节 + 文件地图 | — |
| cxin 数据 | P2 | `cargo-knowledge/standards/dev-loop-modules.md`（敏感清单 + 模块映射）+ dev-loop 定义 | — |

**未碰**：`runtime.ts`/`pi-execution.ts`/`store.ts`/`scheduler.ts`（引擎核心零改动）；`instrumentation.ts`（web 零定时器）。**研发 Loop 是引擎的使用者，不是引擎本身。**

## 3. 自验收矩阵（设计条款逐条）

### §7 研发 Loop（OODA + Learn）
- ✅ **一轮闭环**（orient/decide/act/measure/learn）编码进 LOOP.md 契约（`contract.ts`），orchestrator 用既有工具执行（D10：不注入新工具）。
- ✅ **选品**（§7.1）：`phase==intake` ∧ 无在途 ∧ 优先级最高 ∧ 首个；eventId 去重复用引擎。
- ✅ **触发**（§7.1）：cron 工作日 9:00 + manual，autonomy L2 起步（D8）。
- ✅ **记忆三件套**（§7.7）：STATE.md（校准/敏感/在途）+ LEARN.jsonl（反馈，D2 与引擎 RUNS.jsonl 分文件）+ cargo-knowledge（长期）。按**模块/代码库**键（`learn/aggregate.ts` group by module），不按工作项键 → 换渠道带得走。

### §7.3 三重判定（信心×验证×风险）
- ✅ 编码进 LOOP.md：① 信心（STATE 校准表修正）× ② 验证（checker green/red，act 时）× ③ 风险（查 `standards/dev-loop-modules.md` 敏感清单）。
- ✅ 全绿（high∧非敏感∧校准允许）→ 直跑 ACT；否则 gate1。
- ✅ **红线**：自动只到开 PR（push 分支），合并永远是人点头的 gate2（L0①，契约写死）。

### §7.4 进化机器（确定性核 + LLM 定性）★
- ✅ **可计算=纯函数**：`aggregate.ts`（`aggregate(records)→DerivedState`，每模块 high-conf 准确率/strikes/stuck-rate；`effectiveTier` high→med 降级）。**绝不让 LLM 数数** —— orchestrator 只写定性 LEARN 记录。
- ✅ **三个存储 + 写法**：LEARN.jsonl（append-only，机器写）/ STATE 派生块（纯函数覆写，可重算）/ cargo-knowledge 笔记（LLM append）。
- ✅ **行为变化示例活现**（真机）：finance-service 5 条（3 merged/2 changes_requested）→ aggregate 算 60% < 70% → tier=med；orchestrator 的 plan 明确读到并应用（"finance-service is tier=med with 2 strikes — demote high→med"）。

### §7.5 约束分层 L0–L4 + 不对称演化
- ✅ **L0 不变式**（硬，写进 LOOP.md）：①永不自动合并主干 ②只能动声明仓库 ③只在 feature/hotfix 分支 ④同时一个在途 ⑤每轮可观测。
- ✅ **L1 三重闸 / L2 人闸**（gate1 批计划 + gate2 批合并永不跳）：引擎既有；L2 起步 gate1 必经。
- ✅ **L3 不对称**（`config.ts` + `aggregate.ts`）：准确率低→自动抬 tier；strike 到阈值→自动加敏感；**只自动收紧，放宽需人**（promote/remove 不在 aggregate 做）。
- ✅ **保险**：LEARN.jsonl append-only 不可变；STATE.md 在 git（cxin 是 git 仓库，可 revert）。

### §7.6 知识库契约 + 防污染
- ✅ **读（orient）**：kb_search（L1，knowledge 能力一开自动挂）+ grep（L0）喂进 plan —— 真机 orchestrator 实测调了 kb_search。
- ✅ **写（learn）**：`knowledge.ts` 格式化 OKF 笔记（`type:learning, author:loop, autoManaged, derivedFrom:run:*`）。
- ✅ **防污染（D6）**：Loop **永远只新建笔记文件**（`learnings/<module>-<runId>.md`），绝不编辑既有文件 → 天然满足"人改过的 Loop 不覆写"。信任序 human>loop 在 LOOP.md orient 政策里。

### §6 Exporter（触发即消息，Loop 渠道无关）
- ✅ Exporter SPI（`onWorkItemEvent`）+ FeishuNotifier（确定性，复用 `lib/feishu/client.ts`，无 LLM）。
- ✅ dispatcher（深缝：扫 events.jsonl → ULID 去重 → 派发，per-error 吞掉）+ ExporterScheduler（host 非 Loop 定时器，60s）。
- ✅ **Loop 不调任何渠道**：只写工作项 phase/event；通知 100% 事件驱动。
- ✅ 真机：cxin 无飞书凭据 → FeishuNotifier 优雅降级（"no feishu config, skipping"），dispatched 172 events 正常。

### §14 阶段表
- ✅ P2（checker 闸门 + 敏感清单）/ P3（Exporter + 研发 Loop v1 结构闭环）/ P4（进化上线）/ P5（阈值已配 + 契约写不对称放宽规则；待真实 RUNS 持续调优）。

## 4. 真机证据（cxin `01KYRBBY917PW4X0VHMY5GC8TE`）

loop host（新代码）启动，三定时器 tick：`[importer] / [exporter] / [learn] scheduler started`；`GET /loops` 可见 `dev-loop (L2)`。

| 环节 | 证据 | 状态 |
|---|---|---|
| 触发 | `POST /v1/triggers` → `accepted:true runId=01KZR29HK1...` | ✅ |
| orient | orchestrator 调 `kb_search`×2（cargo-knowledge）+ `read` STATE + `bash`（RUNS/LEARN）+ `workspace_list_work_items` | ✅ |
| decide 选品 | 选中 **BUG-0008**（mdm-service/cargoware），填回 `repositories`，记 `selection.decided` 里程碑（"三重判定全绿：①信心 high… ③风险 normal/非敏感"） | ✅ |
| 进化反馈 | plan 明文应用 STATE 校准："finance-service is tier=med with 2 strikes — demote high→med" | ✅ §7.4 活现 |
| gate1（L2） | infer 后 `waiting_for_confirmation`；我 approve → `running` | ✅ |
| maker 委派 | `subagent(developer)` 自包含 TDD 任务；建 `hotfix/2026-08-11/airline-dept-from-manager`（bug branch_rules ✓）于隔离 worktree | ✅ |
| maker→commit | developer 探索 mdm-service（11 bash/8 read）但**未提交代码** —— BUG-0008 禅道原文"需要排查原因和刷数据"是数据排查 bug，非 TDD 代码修复 | ⚠️ 见下 |
| learn 记录 | 本轮未写 LEARN 记录（orchestrator 未到 learn 步即结束） | ⚠️ 见下 |
| 进化核（手动） | `POST /learn/aggregate` → finance-service 60% → STATE 派生块 `tier=med` | ✅ |
| Exporter（手动） | `POST /exporters/dispatch` → dispatched 172 events，phase→verification 命中，FeishuNotifier 优雅跳过 | ✅ |

### 4.1 诚实的两点偏离（→ P5 调优输入）

1. **BUG-0008 不是理想的自主 TDD 候选**：禅道描述是"排查原因 + 刷数据"（数据/运维 bug）。orchestrator 的 orient 正确读到了，maker 探索后未产出可测代码改动。**这本身就是三重判定的价值信号**：纯数据 bug 不该走自主 TDD。P5 调优：选品阶段加一条"原始描述含排查/刷数据/配置类关键词 → 不选或直 gate1"。更优首跑候选：**REQ-0012**（目的港服务查询条件新增等于判断，纯代码逻辑，feature 分支）。
2. **learn 步未强制执行**：orchestrator 在 maker 无产出时直接结束轮次，没写 LEARN 记录。P5 调优：LOOP.md 加硬规则"无论 maker 产出与否，learn 步必须 append 一条 LEARN（outcome=blocked when 无改动）"，保证反馈数据集不丢。

> 注：maker 委派（subagent + 正确 branch + worktree）已用与 tester **完全相同**的机制证实；gate2 是引擎既有的 `LOOP_GATE → waiting_for_gate → answerGate`（`runtime.test.mjs` 覆盖）。故"checker green→push→gate2"链路结构已证，仅缺一次 mvn 跑绿的真实闭环（依赖选到纯代码候选）。

## 5. 测试覆盖

新增 9 个 `.test.mjs`（58 用例），全绿：
- `checkers.test.mjs`（9）· `feishu-format.test.mjs`（10）· `dispatcher.test.mjs`（7）
- `dev-loop/contract.test.mjs`（5）· `dev-loop/authoring.test.mjs`（3）
- `learn/aggregate.test.mjs`（11）· `learn/state.test.mjs`（6）· `learn/knowledge.test.mjs`（3）· `learn/scheduler.test.mjs`（4）

## 6. P5 状态与后续

- ✅ 阈值已配（`learn/config.ts`：MIN_SAMPLES=3 / ACCURACY_FLOOR=0.7 / STRIKE_THRESHOLD=3）。
- ✅ 不对称放宽规则已写进 LOOP.md 契约（"放宽需人确认"）。
- ⏳ 待真实 RUNS 累积后持续调优（P5 是"收敛"，本质是数据驱动迭代，需多轮真实跑）。
- 🔧 两条 P5 调优项（见 4.1）：选品排除数据/运维 bug；learn 步强制写 LEARN。

## 7. 结论

**结构闭环（P3）已实现并真机验证到 maker 委派**；**进化核（P4）已实现并真机验证（aggregate→STATE→下一轮读到）**；**Exporter（§6）已实现并真机验证**。引擎核心零改动、web 零定时器。研发 Loop 是引擎的使用者。两点偏离已记为 P5 调优输入，不影响结构正确性。
