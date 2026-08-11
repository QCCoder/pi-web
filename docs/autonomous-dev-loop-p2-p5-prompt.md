# 实现任务：Autonomous Dev Loop P2→P5（研发闭环 + 进化）

> 把 pi-web 已有的通用 Loop 引擎变成「自动挑工作项 → TDD 写码 → 开 PR → 学习进化」的研发闭环。
> 复制下面整段作为新会话的首条消息。

---

你是 pi-web 项目「自主研发闭环（Autonomous Dev Loop）」迭代的端到端实现者。**P0+P1（禅道 Importer）已完成上线**，本次实现剩余 **P2→P5**。依次完成【计划 → 开发 → 自验收】，全部在本次会话内连贯完成，不要中途停下等人。

═══════════════════════════════════════════════
## 0. 必读（动代码前先读完）
═══════════════════════════════════════════════
1. **docs/autonomous-dev-loop.md** —— 设计终稿（source of truth）。重点读：§3 架构骨干、§4 工作项=集成枢纽、§7 研发 Loop（OODA+Learn）、§7.3 三重判定、§7.4 进化机器、§7.5 约束分层 L0–L4、§7.6 知识库契约、§12 流程图、§14 阶段表。
2. **AGENTS.md** —— 编码规范、文件地图、Loop/工作项/飞书/禅道(importers) 子系统现状。
3. **docs/autonomous-dev-loop-plan.md** —— P0/P1 实施计划，**照抄它的拆步方式与「深模块缝」标注风格**来写 P2→P5 的计划。
4. **docs/autonomous-dev-loop.md 附录 A/B** —— 禅道 API 事实表 + cxin 现状。

先探查这些现有模式（务必照抄，别重造）：
- **Loop 引擎**（已完整可用，研发 Loop 是它的**使用者**，不重写引擎）：`lib/loop/runtime.ts`、`lib/loop/pi-execution.ts`（PiRoundExecutionBackend，驱动 orchestrator session + subagent 委派）、`lib/loop/host.ts`、`lib/loop/store.ts`、`lib/loop/authoring.ts`（在 web 进程写 loop.yaml/LOOP.md/agents）、`lib/loop/scheduler.ts`。
- **subagent**：`lib/subagent/extension.ts`（maker/checker 委派）、`lib/subagent/worker.ts`、loop 注入 agents 的机制 `StartSessionOptions.extraAgentDirs`。
- **工作项**：`lib/work-items/`（phase 状态机、events.jsonl、external 段）。
- **飞书**：`lib/feishu/client.ts`（FeishuNotifier 直接复用，确定性不走 LLM）。
- **Importer**（P0/P1 已完成）：`lib/importers/`——参考其深模块缝风格。

环境：Next.js + Workspace 子系统 + 独立 loop host 进程。
- 类型检查：`node_modules/.bin/tsc --noEmit`
- Lint：`npm run lint`
- 测试：`npm test`（node:test over `lib/**/*.test.mjs`；**.mjs 测试文件必须是纯 JS，不能 import type / 不能用 TS 注解**；被测 .ts 文件**不能用 constructor 参数属性**，否则 node strip-only 模式报错）
- 开发期严禁 `next build`。

═══════════════════════════════════════════════
## 1. 已完成（不要重做）
═══════════════════════════════════════════════
- **P0** `lib/importers/`：Importer SPI + ChandaoImporter + 配置 UI + 测试连接。
- **P1** `lib/importers/runner.ts` + `scheduler.ts`：cron(30min,在 loop host 非 Loop 定时器)/webhook/manual → 工作项(含图片)→去重 by external.sourceId→event。web 端点 `…/importers/sync`。`instrumentation.ts` 未改（web 不持定时器）。
- 工作项加可选 `external:{source,sourceId,url,lastSyncedAt}` 段。

═══════════════════════════════════════════════
## 2. 关键事实（实测踩坑，别再错）
═══════════════════════════════════════════════
- **禅道 REST API 忽略 `assignedTo` 查询参数**（带不带都返回产品下全部）→ 必须客户端按 `assignedTo.account === assignee` 二次过滤。见 `lib/importers/chandao-importer.ts` 的 `assignedToAccount()`。
- **「待开发」= bug `active` / task `doing`**（不是 wait）。见 `READY_STATUSES`。
- **cxin 工作区**：`~/.pi/workspaces/workspace-c`，id `01KYRBBY917PW4X0VHMY5GC8TE`，能力含 `work-items/repositories/knowledge/requirement-sources/loop`。git.branch_rules 已配（requirement=`feature/{date}/{slug}`，bug=`hotfix/{date}/{slug}`，create_after=plan_approved）。Importer 凭据已存 0600（研发 Loop 不需要禅道凭据，工作项已拉好）。
- **cxin 现有 8 条待开发工作项**（3 active bug + 5 doing task），可直接当研发 Loop 的 backlog 测试。
- **目标仓库**（cxin `repositories/code/`）：cargoware(Java/SpringBoot/Maven,19 模块,353 个 *Test.java)、cargoware-h5(Vue+Jest+ESLint,`npm run test:ci`)、cargo-h5-mp、cargoapi(根目录无 pom/package,待查)、cargo-report-server-haichuang(Java/SpringBoot,`mvn test`)。knowledge 仓库：cargo-knowledge（OKF）。
- **dev Loop 不认识任何渠道**：它只读写工作项 + 自己的记忆(STATE/RUNS/cargo-knowledge) + 目标代码仓库。

═══════════════════════════════════════════════
## 3. 要做什么（设计 §14，按 P2→P5 顺序）
═══════════════════════════════════════════════

### P2 — Phase 0 验证闸门（P3 前置）
- 跑通各仓库 checker 当闸门：cargoware `mvn -pl <module> -am compile && mvn -pl <module> test`；cargoware-h5 `npm run test:ci`(=lint+test:unit)；cargo-report-server-haichuang `mvn test`。确认用例量、确认能作 gate 牙齿。
- 定**敏感模块清单 v1**（费用/风控/鉴权/退关/对外接口）→ 写进 cargo-knowledge 的「模块→仓库/敏感映射表」结构化文档（设计 §8）。Importer 读它预填仓库/敏感标（P1 暂未做，P3 接通）。
- **验收**：每个仓库 checker 命令实测可跑；敏感清单落 cargo-knowledge。

### P3 — Exporter + 研发 Loop v1（结构闭环，**暂不全进化**）
1. **Exporter SPI**（`lib/exporters/types.ts`：`onWorkItemEvent(event, item)`）+ **`FeishuNotifier`**（订阅工作项 events.jsonl 新增事件 → 飞书，复用 `lib/feishu/client.ts`，确定性不走 LLM）。
2. **研发 Loop 定义**（cxin `loops/<id>/`）：`loop.yaml`(triggers=cron 工作日9:00 + manual, autonomy 选 L2 或 L3)、`LOOP.md`(任务契约)、`STATE.md`(校准表/敏感清单/选品策略/在途)、`agents/developer.md`+`agents/tester.md`。
3. **选品**（§7.1）：挑 `phase==待开发` ∧ 无在途 run ∧ 优先级最高 ∧ 首个；`eventId=exec-<workItemKey>`（同 key 去重）。
4. **三重判定**（§7.3）：信心(校准表修正) × 验证(checker 跑 build+模块测试 green/red) × 风险(查敏感清单)。全绿(high ∧ green ∧ 非敏感)→自动做；否则停 gate1。
5. **act**：gate1(敏感/低信心时批计划) → maker=developer subagent(TDD：起分支 branch_rules + 写/补测试 + 实现) → checker=tester subagent(跑 checker 命令)。绿→开 PR、phase=待评审；红→回滚、phase=受阻。
6. **gate2**：人审 diff、批合并——**永不跳过**（合并是唯一不可逆点）。
7. **measure + learn（P3 最简版）**：写 `RUNS.jsonl += {runId,workItemKey,module,repo,predictedConf,riskTier,outcome,tests,humanDecision,ts}`；写最简 STATE。
- **L0 不变式**（硬）：① 永不自动合并主干 ② 只能动工作项声明仓库 ③ 改动只在 feature/hotfix 分支 ④ 同时只一个工作项在途 ⑤ 每轮可观测(RUNS+SSE)。
- **开 PR 方式**是开放问题：仓库是本地 clone，确认是否有 remote、用 `gh`/git push 还是仅本地分支+PR 草稿——P3 起步时定。
- **验收**：1 个低风险工作项跑通（选品→三重判定→TDD→开 PR→人审合并），全程 events/RUNS 可观测，飞书通知到达。

### P4 — 进化上线（§7.4，可计算=确定性纯函数，需判断才给 LLM）
1. `lib/loop/learn/aggregate.ts`（**纯函数，无 LLM，不让 LLM 数数**）：跑一遍 RUNS.jsonl → 覆写 STATE 派生块（每模块 high-conf 实际准确率、strike 数(changes_requested+rejected)、卡住率）。派生可重算→覆写安全。
2. **LLM 笔记**：round 有可泛化结论 → cargo-knowledge append（`type:learning, author:loop, autoManaged:true, derivedFrom:run:xxx`）。
3. **不对称演化**（§7.5 L3）：敏感 strike 到阈值→**自动加入**；移除→**必须人确认**。信心准确率低→自动抬高 effective tier；降低→人确认。RUNS.jsonl 不可变；STATE 在 git 里可 revert。
4. **知识防污染**（§7.6）：信任序 human>loop；人改过的笔记→authoritative，Loop 不再覆写，只允许 append。
- **验收**：连跑数轮，STATE 派生块/cargo-knowledge 笔记可见增长，某模块 high 准确率<0.7 时 round N+1 自动降级触发 gate1（肉眼可见的进化）。

### P5 — 收敛
- 风险清单调优；对可信模式**放宽 gate1**（仍需人确认，不对称）。
- **验收**：稳定串行跑队列，打回率下降。

═══════════════════════════════════════════════
## 4. 规则
═══════════════════════════════════════════════
- 严格照抄现有模式：loop authoring(`lib/loop/authoring.ts`)、subagent、work-items、feishu client、importer runner 的深模块缝风格。
- 每步小提交，每步过 `tsc` + `lint` + `npm test`。加 `lib/**/*.test.mjs` 测试（纯函数/maker-checker 编排/aggregate/Exporter）。
- 凭据运行时索取，绝不硬编码。
- **不改 Loop 引擎核心**（runtime/pi-execution/store/scheduler）；研发 Loop 是引擎的使用者。复用 eventId 去重、gate、subagent 委派、SSE 代理。
- 进化记忆按「模块/代码库」键，**不按工作项键**（换渠道带得走）。

═══════════════════════════════════════════════
## 5. 最深模块缝（小接口藏复杂度）
═══════════════════════════════════════════════
- **Exporter SPI**（`onWorkItemEvent`）——藏渠道差异。
- **`learn/aggregate.ts`**（纯函数）——藏 RUNS→STATE 派生计算。
- **研发 Loop「一轮」编排**（orient/decide/act/measure/learn）——藏自主开发全流程。

═══════════════════════════════════════════════
## 6. 完成后输出
═══════════════════════════════════════════════
- 阶段 A 计划文档路径（参考 autonomous-dev-loop-plan.md）。
- 阶段 B 已实现内容 + 提交列表 + 测试结果（tsc/lint/test 全绿）。
- 阶段 C 自验收（对设计 §7/§7.3/§7.4/§7.5/§7.6/§14 + AGENTS.md）+ 真机验证（cxin 跑一个低风险工作项，给证据）。
