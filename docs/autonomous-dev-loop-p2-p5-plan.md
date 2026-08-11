# 自主研发闭环 — 实施计划 P2→P5（第二迭代）

> 设计终稿：`docs/autonomous-dev-loop.md`（source of truth）。
> 上一迭代（P0+P1）：`docs/autonomous-dev-loop-plan.md`（Importer SPI + Chandao + runner，已上线）。
> 本文档把设计 §14 的 **P2→P5** 拆成可独立提交的小步，并标注每步的「深模块缝」与验收。

## 本迭代边界与硬约束（不可违）

- ❌ **不改 Loop 引擎核心**：`runtime.ts` / `pi-execution.ts` / `store.ts` / `scheduler.ts` 零改动。研发 Loop 是引擎的**使用者**，不是引擎本身。
- ❌ **web 服务器不持任何定时器**（`instrumentation.ts` 零改动）。所有定时器（Importer / Exporter / Learn）都在 loop host 进程，是 `ImporterScheduler` 的平级「非 Loop 系统定时任务」。
- ❌ **不新增工作项字段**（P1 已加 `external`）；不动 KEY 计数器 / phase 状态机 / events schema。
- ✅ **复用**：eventId 去重、L1/L2/L3 autonomy、gate（gate1/gate2）、subagent 委派、SSE 代理、`loopHostClient`。
- ✅ **照抄深模块缝风格**（对标 P1 的 `runner.ts` / `images.ts` / SPI）。

## 关键决策（grilling 已收敛，记录于此供后续校验）

| # | 决策点 | 选择 | 理由 / 事实依据 |
|---|---|---|---|
| D1 | dev-loop 的「进化」由谁触发 | **host 侧 `LearnScheduler` 定时器**（非 Loop、非引擎） | 不耦合 round 生命周期；零引擎改动；与 ImporterScheduler 同构 |
| D2 | dev-loop 反馈日志文件名 | **`LEARN.jsonl`**（不是 `RUNS.jsonl`） | 引擎的 `RUNS.jsonl` 存的是 `LoopRun` 快照；dev-loop 的「预测 vs 实际」是另一种 schema，分文件避免污染 |
| D3 | aggregate（纯函数）何时跑 | LearnScheduler 周期跑 + 可手动触发 | 纯函数幂等可重算；不依赖 round |
| D4 | LEARN 记录谁写 | **orchestrator 用 bash append**（qualitative 字段） | 「不让 LLM 数数」=不让 LLM 做 aggregate（统计）；写自己这一条的定性字段不是数数。schema 由 aggregate 读取时校验，坏行跳过 |
| D5 | 「开 PR」怎么做 | **`git push origin <branch>`**（仓库有 remote）+ 工作项记分支名 + 飞书通知 | 事实：无 `gh` CLI；仓库 remote 是 codeup.aliyun.com（git@）。gate2 人审在远端合并 |
| D6 | 知识防污染（§7.6）实现 | **Loop 永远只创建新笔记文件，绝不编辑既有文件** | 事实：cargo-knowledge 是 OKF，按文件组织。append-only-新文件 天然满足「人改过的 Loop 不覆写」（Loop 根本不碰既有文件） |
| D7 | phase ↔ 研发状态映射 | 待开发=`intake` / 待计划评审(gate1)=`plan_approval` / 实现中=`implementation` / 待评审(gate2)=`verification` / 完成=`complete`+`done` / 受阻=status`blocked` | 复用工作项既有 phase 状态机，零新增枚举 |
| D8 | 触发器 | cron 工作日 9:00 + manual（L2 起步，验证后可 L3） | 设计 §7.1；eventId=`exec-<workItemKey>` 同 key 去重 |
| D9 | cargo-knowledge 布局 | 复用既有 OKF（`services/`、`standards/`、`domains/`）；敏感清单 + 模块映射落 `standards/dev-loop-modules.md`；学习笔记落新目录 `learnings/` | 事实：cargo-knowledge 已是富 OKF，不覆盖既有结构 |
| D10 | dev-loop 注入 loop-scoped 能力的方式 | **不注入新工具**：orchestrator 用既有工具（work-item 工具 / bash / edit / subagent / kb_search）+ LOOP.md 契约 + STATE.md 记忆 | 零引擎/零 rpc-manager 改动；最深的缝是 LOOP.md 契约本身 |

### 决策树依赖（解析顺序）

```
D2(文件名) → D3(谁跑 aggregate) → D1(LearnScheduler) → D4(谁写 LEARN)
D5(PR方式: 无 gh) → 决定 maker 契约含 git push
D6(知识只新建文件) → D9(learnings/ 目录)
D7(phase 映射) → 选品/Exporter/契约全用它
D10(不注入工具) → 整个 dev-loop 只是「一个 loop 定义 + host 辅助定时器」
```

## 最深模块缝（小接口藏复杂度）

1. **Exporter SPI（`lib/exporters/types.ts`）** — `onWorkItemEvent(event, item)`，藏住「工作项事件 → 任意出站渠道」。换飞书=换一个实现。
2. **`dispatchWorkItemEvents(workspaceId, exporters, watermark)`（`lib/exporters/dispatcher.ts`）** — 一个入口藏住「扫描 events.jsonl → 去重 → 派发」。
3. **`aggregate(records)`（`lib/loop/learn/aggregate.ts`）** — 纯函数，藏住「RUNS→校准/敏感派生」的全部统计。**不让 LLM 进来数数。**
4. **`createDevLoopDefinition(workspace)`（`lib/loop/dev-loop/authoring.ts`）** — 一个入口藏住「写 loop.yaml/LOOP.md/STATE.md/agents」，dev-loop 契约是数据驱动的纯渲染。
5. **`lib/loop/checkers.ts`** — 仓库别名 → checker 命令模板（纯），tester agent 与 LOOP.md 共用。

---

## P2 — Phase 0 验证闸门（P3 前置）

### P2-1 · checker 命令注册表 `lib/loop/checkers.ts`（纯）

- **文件**：`lib/loop/checkers.ts`（新建）、`lib/loop/checkers.test.mjs`（新建）
- **接口**（全纯，无 I/O）：
  ```ts
  repoCheckerCommands(alias: string): { build: string[]; test: string[]; moduleScoped: boolean } | null
  resolveChecker(alias: string, module?: string): { build?: string[]; test: string[] } | null
  ```
- **数据**（实测 cxin 仓库）：
  - `cargoware` → build=`mvn -pl {module} -am compile`，test=`mvn -pl {module} test`，moduleScoped=true（19 模块）。
  - `cargoware-h5` → test=`npm run test:ci`（=lint+test:unit，Vue+Jest）。
  - `cargo-report-server-haichuang` → test=`mvn test`（单模块，有 mvnw）。
  - `cargoapi` → null（根目录无 pom/package，不是 checker 目标——Phase 0 核实结论）。
  - `cargo-h5-mp` → null（待 P2 核实是否有 test 脚本；先 null）。
- **验收/测试**：纯函数查表 + `{module}` 占位替换；cargoapi/cargo-h5-mp 返回 null。

### P2-2 · 敏感模块清单 v1 + 模块→仓库映射（cargo-knowledge）

- **文件**：`cargo-knowledge/standards/dev-loop-modules.md`（新建，OKF）、`cargo-knowledge/log.md`（append 更新记录）。
- **内容**（结构化表格，§8 的「统一知识工件」）：
  - 模块 → 仓库别名 → 是否敏感 + 敏感类别（费用/风控/鉴权/退关/对外接口）。
  - 来源：cxin 既有工作项标题 + cargoware 19 模块 + cargoware services 知识卡。
- **敏感判定 v1**：`finance-service`(费用)、`charge`/`recon`(费用/对账)、`risk`/风控相关(风控)、`auth`/鉴权、`退关`/`external-service`/`edi-service`(对外接口)。
- **验收**：文件落 cargo-knowledge（git 可见）；Importer 未来读它预填、Loop learn 校正它。

### P2-3 · checker 实测（人工核验，不改代码）

- **行为**：确认 `mvn -v` / `node -v` / `npm -v` 可用（已确认：mvn 3.6.3、node v24）；各仓库 `pom.xml`/`package.json` 在位（已确认）；**不跑全量 353 测试**（那是 round 时 tester agent 的牙齿，不是 P2 预跑）。
- **验收**：checkers.ts 命令与各仓库实际构建工具对得上。

**P2 验收闸门**：checkers.ts 纯函数可查 + 测试绿；敏感清单 + 模块映射落 cargo-knowledge。

---

## P3 — Exporter + 研发 Loop v1（结构闭环，暂不全进化）

### P3-E1 · Exporter SPI（深模块缝 #1）

- **文件**：`lib/exporters/types.ts`（新建）
- **接口**：
  ```ts
  export interface WorkItemEventPayload { id; at; type; actor; conversationId?; data? }   // 复用 work-items 形状
  export interface Exporter { readonly kind: string; onWorkItemEvent(workspaceId, event, item): Promise<void> }
  ```
- **照抄模式**：SPI 形状来自设计 §6；事件载荷复用 `WorkItemEvent`。

### P3-E2 · 飞书渲染纯函数 `lib/exporters/feishu-format.ts`（纯）

- **文件**：`lib/exporters/feishu-format.ts`（新建）、`lib/exporters/feishu-format.test.mjs`（新建）
- **接口**（全纯）：
  ```ts
  shouldNotify(event, item): boolean                                   // 只 phase 变 + 关注态
  formatPhaseChangeCard(item, fromPhase, toPhase): { title; markdown; template }
  ```
- **关注态**：→`verification`(待评审/PR就绪)、`complete`(完成)、status→`blocked`(受阻)。其余静默。
- **验收/测试**：纯函数；渲染卡片标题/模板按态着色（verification=blue、complete=green、blocked=red）。

### P3-E3 · FeishuNotifier `lib/exporters/feishu-notifier.ts`

- **文件**：`lib/exporters/feishu-notifier.ts`（新建）
- **实现**：`class FeishuNotifier implements Exporter`。`onWorkItemEvent`：`shouldNotify`→读 `readFeishuConfig`→无凭据静默跳过→`new FeishuClient(config).sendCard(receiveId, formatPhaseChangeCard(...))`。**确定性，不走 LLM**（设计 §6）。
- **照抄模式**：`lib/feishu/client.ts` + `config.ts` 直接复用。

### P3-E4 · 事件派发器 `lib/exporters/dispatcher.ts`（深模块缝 #2）

- **文件**：`lib/exporters/dispatcher.ts`（新建）、`lib/exporters/dispatcher.test.mjs`（新建）
- **接口**：
  ```ts
  dispatchWorkItemEvents(workspaceId, exporters, opts: { sinceEventId?: string })
    : Promise<{ lastEventId: string | null; dispatched: number }>
  ```
- **流程**：`listWorkItems` → 逐项读 `events.jsonl` → 过滤 `at`/`id` > watermark → 去重 by event id → 对每条调每个 `exporter.onWorkItemEvent`（错误吞掉只记）。watermark = 严格递增的 event `id`（ULID 天然有序）或 `at`。
- **幂等**：同一 event id 不二次派发（sinceEventId 持久化在 `.pi/cache/exporter-watermark.json`）。
- **验收/测试**：mock Exporter 计数；重复跑 dispatched=0；phase 变触发、非关注态不触发。

### P3-E5 · Exporter 系统定时任务（loop host，非 Loop）

- **文件**：`lib/exporters/scheduler.ts`（新建）：`class ExporterScheduler`（30s tick，对标 `LoopHostScheduler` 结构）。每 tick：遍历有 `loop` 或 `work-items` 能力的工作区 → 注册 `FeishuNotifier`（仅当有飞书凭据）→ `dispatchWorkItemEvents` → 持久化 watermark。
- **文件**：`lib/loop/host.ts`（改 wiring）：`createLoopHost()` 加 `exporterScheduler`；`startLoopHost` start/stop；`SIGINT/SIGTERM` stop。**host.ts 不是受保护核心**（核心是 runtime/pi-execution/store/scheduler）。
- **设计依据**：§6「触发即消息；Loop 只写 phase/event，不调渠道」。
- **验收**：host 启动日志含 exporter scheduler tick。

### P3-L1 · dev-loop 契约渲染纯函数 `lib/loop/dev-loop/contract.ts`（深模块缝 #4 的纯核）

- **文件**：`lib/loop/dev-loop/contract.ts`（新建）、`lib/loop/dev-loop/contract.test.mjs`（新建）
- **接口**（全纯字符串构建）：
  ```ts
  renderDevLoopInstructions(): string        // LOOP.md 全文（OODA + 三重判定 + phase 映射 + L0 不变式 + maker/checker 契约 + learn 最简）
  renderDevLoopState(): string               // STATE.md 初始（校准表空 / 敏感清单指向 cargo-knowledge / 选品策略）
  renderDeveloperAgent(): string             // agents/developer.md（TDD maker：起分支 branch_rules → 写测试 → 实现）
  renderTesterAgent(): string                // agents/tester.md（checker：跑 checkers.ts 命令，报 green/red）
  ```
- **内容要点（写进 LOOP.md 契约，orchestrator 遵守）**：
  - ORIENT：读 STATE.md + `kb_search`/`grep` cargo-knowledge + RUNS.jsonl 近期 + `workspace_list_work_items`(filter phase=intake)。
  - DECIDE 选品：`phase==intake` ∧ 无在途 run ∧ 优先级最高 ∧ 首个；`eventId=exec-<key>`。
  - 三重判定（§7.3）：信心(STATE 校准表修正) × 验证(checker green/red) × 风险(查 `standards/dev-loop-modules.md` 敏感)。全绿(high∧green∧非敏感)→直跑 ACT；否则 `LOOP_GATE: 批计划`。
  - ACT：gate1 批→ maker=developer subagent（branch_rules 起分支 + TDD 写测试 + 实现）→ checker=tester subagent（跑 checkers.ts）。绿→`git push origin <branch>` + phase=`verification`；红→回滚 + status=`blocked`。
  - gate2：`LOOP_GATE: 人审合并`（永不跳过）。approve 后写 LEARN 记录 + phase=`complete`/`done`；reject 后写 LEARN(outcome=rejected) + status=`blocked`。
  - LEARN 最简（P3）：bash append 一条 LEARN.jsonl 记录（schema 见 D2）。
  - **L0 不变式**（写死在契约里，硬）：①永不自动合并主干 ②只能动工作项 `repositories` 声明仓库 ③只在 feature/hotfix 分支 ④同时一个在途 ⑤每轮可观测。
- **验收/测试**：纯渲染；输出含关键不变式短语、三重判定、phase 映射、`LOOP_GATE`/`LOOP_VERDICT` 标记。

### P3-L2 · dev-loop 定义落地 `lib/loop/dev-loop/authoring.ts`

- **文件**：`lib/loop/dev-loop/authoring.ts`（新建）
- **接口**：
  ```ts
  createDevLoopDefinition(workspace): Promise<LoopDefinition>   // 写 loops/dev-loop/{loop.yaml,LOOP.md,STATE.md,agents/{developer,tester}.md,audit/,LEARN.jsonl 空}
  ```
- **照抄模式**：`lib/loop/authoring.ts` 的 `createLoopDefinition`（`flag: wx` 防覆盖 + 回滚）。但 dev-loop 的 LOOP.md/STATE.md/agents 用 `contract.ts` 渲染（不是泛型表单）。
- **loop.yaml**：`autonomy: L2`（起步；gate1 保留，gate2 必有）、triggers=[cron 工作日 9:00 Asia/Shanghai + manual]。
- **验收**：cxin 上创建成功；`readLoopDefinition` 能读回；`DefaultLoopRuntime.listLoops` 可见。

### P3-L3 · dev-loop 创建 API

- **文件**：`app/api/workspaces/[id]/dev-loop/route.ts`（新建）：POST → `createDevLoopDefinition`；GET → 返回 dev-loop 定义（若存在）。
- **照抄模式**：`app/api/workspaces/[id]/loop/loops/route.ts` 的鉴权 + 错误映射风格。

**P3 验收闸门**：1 个低风险工作项跑通（选品→三重判定→TDD maker→checker→push 分支/PR→gate2 人审→合并）；events 可观测（Exporter 派发）；飞书通知到达（若有凭据）或优雅降级。

---

## P4 — 进化上线（§7.4）

### P4-1 · LEARN 记录 schema + 阈值配置 `lib/loop/learn/{types,config}.ts`

- **文件**：`lib/loop/learn/types.ts`、`lib/loop/learn/config.ts`（新建）
- **LEARN 记录**（D2）：`{ runId, workItemKey, module, repo, predictedConf: "high"|"med"|"low", riskTier: "sensitive"|"normal", outcome: "merged"|"changes_requested"|"rejected"|"blocked", tests: "green"|"red"|"none", humanDecision?: string, ts }`。
- **阈值**（config，纯常量）：`ACCURACY_FLOOR=0.7`（< 此 → high 降级为 medium）、`STRIKE_THRESHOLD=3`（连续 strike → 自动入敏感）、`MIN_SAMPLES=3`（样本不足不判定）。

### P4-2 · aggregate 纯函数 `lib/loop/learn/aggregate.ts`（深模块缝 #3）★

- **文件**：`lib/loop/learn/aggregate.ts`（新建）、`lib/loop/learn/aggregate.test.mjs`（新建）
- **接口**（全纯）：
  ```ts
  parseLearnRecords(jsonl: string): LearnRecord[]                 // 坏行跳过
  aggregate(records: LearnRecord[]): DerivedState                 // 按 module 键（D 进化记忆按模块）
  effectiveTier(module, predictedConf, derived): "high"|"med"|"low"   // 校准表修正
  ```
- **派生**：每模块 high-conf 实际准确率（merged/(merged+changes_requested+rejected)）、strike 数、卡住率；**不对称**：准确率低自动抬 tier，降低不在此函数做（需人）。
- **验收/测试**：
  - 5 条 finance-service high（3 merged / 2 changes_requested）→ 准确率 0.6 < 0.7 → `effectiveTier("finance-service","high")="med"`（进化可见）。
  - 样本 <3 不判定。
  - 坏行不影响合法行统计。

### P4-3 · STATE 派生块读写 `lib/loop/learn/state.ts`（纯）

- **文件**：`lib/loop/learn/state.ts`（新建）、`lib/loop/learn/state.test.mjs`（新建）
- **接口**（全纯）：
  ```ts
  renderDerivedBlock(derived): string                                  // <!-- dev-loop:derived:start --> ... :end -->
  mergeStateFile(stateMd, derived): string                             // 替换派生块（幂等可重算）
  ```
- **设计依据**：§7.4「派生数据可重算 → 覆写安全」；§7.5「STATE 在 git 里可 revert」。
- **验收/测试**：无标记块→插入；有标记块→替换；多次 merge 幂等。

### P4-4 · LearnScheduler（host 定时器，深模块缝 #3 的调用方）

- **文件**：`lib/loop/learn/scheduler.ts`（新建）：`class LearnScheduler`（对标 ImporterScheduler）。每 tick：遍历有 `loop` 能力工作区 → 找 `loops/dev-loop/` → 读 `LEARN.jsonl` → `aggregate` → `mergeStateFile` 覆写 STATE.md 派生块。
- **文件**：`lib/loop/host.ts`（改 wiring）：加 `learnScheduler`；start/stop；`POST /v1/workspaces/:id/learn/aggregate` 手动触发（对标 importer sync 路由）。
- **设计依据**：D1+D3。零引擎改动。
- **验收**：host 启动含 learn scheduler tick；手动路由可调。

### P4-5 · 知识笔记格式化 `lib/loop/learn/knowledge.ts`（纯）

- **文件**：`lib/loop/learn/knowledge.ts`（新建）、`lib/loop/learn/knowledge.test.mjs`（新建）
- **接口**（全纯）：
  ```ts
  learningNotePath(module: string, runId: string): string            // learnings/<module>-<runId>.md（D6：永远新文件）
  formatLearningNote(input): string                                  // OKF frontmatter(type:learning,author:loop,autoManaged,derivedFrom,tags)
  ```
- **设计依据**：§7.6 + D6（只新建不编辑 → 天然防污染）。
- **验收/测试**：frontmatter 字段齐全；路径唯一（含 runId）。

**P4 验收闸门**：连跑数轮 STATE 派生块可见增长；某模块 high 准确率<0.7 时下一轮 effectiveTier 降级（肉眼可见进化）；LEARN/STATE/cargo-knowledge 可观测。

---

## P5 — 收敛

- **行为**：调 `learn/config.ts` 阈值（基于 P3/P4 真实 RUNS）；对可信模式在 LOOP.md 契约里写「放宽 gate1 仍需人确认」规则（不对称）。
- **验收**：稳定串行跑队列；打回率随轮次下降。

---

## 提交序列（依赖顺序）

```
P2-1 checkers.ts + 测试
P2-2 cargo-knowledge 敏感清单（数据，非代码提交）
P3-E1 exporters/types.ts (SPI)
  ├─ P3-E2 feishu-format 纯函数 + 测试
  └─ P3-E3 feishu-notifier
        └─ P3-E4 dispatcher + 测试
              └─ P3-E5 exporter scheduler + host wiring
P3-L1 dev-loop/contract.ts 纯渲染 + 测试
  └─ P3-L2 dev-loop/authoring.ts
        └─ P3-L3 dev-loop API 路由
P4-1 learn/{types,config}.ts
  └─ P4-2 learn/aggregate.ts 纯函数 + 测试
        └─ P4-3 learn/state.ts 纯函数 + 测试
              ├─ P4-4 learn/scheduler.ts + host wiring + 手动路由
              └─ P4-5 learn/knowledge.ts 纯函数 + 测试
P5 阈值调优 + 契约放宽规则
```

每步：`tsc --noEmit` + `npm run lint`(0 error) + `npm test`(全绿) + 独立 `git commit`。

## 真机验证（cxin）

1. 创建 cxin dev-loop（POST dev-loop 路由）。
2. 确认 `loopHostClient` 可见；手动 trigger 一个低风险项（首选 **BUG-0008**：航线部门带出，主数据派生，非费用/风控/鉴权；cargoware）。
3. 观察：选品→三重判定→developer 起 feature/hotfix 分支 + TDD→tester 跑 checker→push 分支→gate2。
4. 证据：RUNS.jsonl（引擎快照）+ events.jsonl（工作项 phase）+ LEARN.jsonl（反馈）+ STATE.md 派生块 + 飞书（或降级日志）。
