# 自主研发闭环（Autonomous Dev Loop）— 架构设计 v3（终稿）

> 状态：**已对齐，待实现** · 关联工作区：`cxin`（`~/.pi/workspaces/workspace-c`）
> 本文是 pi-web 的能力扩展设计。v3 相对前版的核心收敛：
> 1. **工作项 = 集成枢纽**，所有三方渠道（进/出）都是它两侧的对称适配器；
> 2. **禅道只是一个 Importer**，可换；
> 3. **只有研发 Loop 会进化**（确定性核 + LLM 定性），其余全是可插拔 I/O；
> 4. 进化受**不对称约束**保护（自动收紧自由、放宽需人）。

---

## 0. TL;DR

- **工作项是唯一真相源 / 集成枢纽**：所有三方渠道只跟它打交道。
- **Importer SPI**（入站，可换）：禅道 → 工作项（含图片）。禅道是首个适配器。
- **Exporter SPI**（出站，可换）：工作项事件 → 飞书通知 / 禅道回写。
- **研发 Loop**（唯一会进化的核心）：定时选一个工作项，自主写码，受「信心×验证×风险」三重判定；每轮把结果**反馈回 STATE / cargo-knowledge / RUNS**，让第 N+1 轮更准。**Loop 不认识任何三方渠道。**
- 触发器（cron / webhook / event / manual）只是"叫醒方式"，与是否 Loop 无关。

---

## 1. 背景与范围

### 1.1 起因
- 研发任务/缺陷由**禅道**管理，希望在 pi-web 内统一追踪并**直接开发**。
- 人工搬运成本高；禅道可能被替换 → 架构必须**源无关**。

### 1.2 在范围（v1）
1. `Importer` SPI + `ChandaoImporter`（禅道 REST API，含图片）。
2. `Exporter` SPI + `FeishuNotifier`（工作项事件 → 飞书）。
3. 研发 Loop：选品 → 自主开发（TDD maker/checker）→ 分支/PR → 写工作项。
4. Phase 0 验证闸门确认（build/test 当 checker 牙齿）。
5. **进化闭环**：确定性核 + LLM 定性；信心校准 / 敏感清单演化 / 代码库理解沉淀 / 选品策略自调。

### 1.3 暂不在范围（v2+）
- 禅道之外的 Importer（Jira 等）、之外的 Exporter（Email/Slack）—— SPI 已留口。
- 双向回写禅道（`ChandaoWriteback` Exporter）—— SPI 已留口，v1 仅通知。
- 自动合并主干、自动发布、多工作项并行开发。

---

## 2. 核心概念：什么在这里配叫 "Loop"

**Loop 的定义属性 = 闭环反馈 → 进化**：第 N+1 轮必须因第 N 轮的结果而**不同**（更准/更快/更少被打回）。`cron`/`webhook`/`event`/`manual` 只是触发器，回答"什么时候醒"，不回答"为什么是 Loop"。

按此定义审视：**拉取禅道、发飞书通知**——每轮独立、确定性、做完即忘 → 不是 Loop，是适配器。**研发**——orient→decide→act→measure→**learn**，learn 改变下一轮的 orient → 是 Loop。

pi-web 的 Loop 框架本就备好进化的器官：

| 器官 | 在进化中的角色 |
|---|---|
| `STATE.md` | 短中期工作记忆：校准表、敏感清单、选品策略、在途状态 |
| `RUNS.jsonl` | 原始反馈数据集：每轮"预测 vs 实际"，append-only 永不删 |
| monitor verdict | 感知（changed/unchanged） |
| maker/checker + gate | 行动 + 度量；**gate 是人反馈的注入点** |
| `cargo-knowledge` | 长期沉淀的代码库理解/模式（跨轮跨工作项） |

---

## 3. 总体架构（骨干）

```
        三方渠道 (全部可换 · 全部只跟工作项打交道)
 ┌───────────── inbound ─────────────┐   ┌───────────── outbound ────────────┐
 │ Importer SPI                       │   │ Exporter SPI                       │
 │  禅道 ──► ChandaoImporter          │   │  FeishuNotifier   ◄── 工作项事件    │
 │  Jira ──► JiraImporter (future)    │   │  ChandaoWriteback ◄── (phase→完成)  │
 │  人工 ──► 手动创建                  │   │  EmailNotifier... ◄──               │
 └────────────────┬───────────────────┘   └─────────────────▲──────────────────┘
                  │ 写入                                     │ 订阅 events.jsonl
                  ▼                                          │
       ╔═════════════════════════════════════════════════════════╗
       ║  工作项 = 集成枢纽                                       ║
       ║  唯一真相源 · canonical state + events.jsonl(append)     ║
       ╚═════════════════════════╤═══════════════════════════════╝
                                 │ 读 + 写 phase/outcome
                                 ▼
       ┌─────────────────────────────────────────────────────────┐
       │  研发 Loop                                                │
       │   • 推理 (orchestrator)                                   │
       │   • 自有记忆 STATE/RUNS/cargo-knowledge  ← 非渠道·直接拥有 │
       │   • 目标仓库 cargoware/...               ← 非渠道·直接拥有 │
       │   ★ 不认识任何三方渠道 ★                                  │
       └─────────────────────────────────────────────────────────┘
```

**设计原则**：
- **工作项是集成枢纽**：所有三方渠道（进/出）都是它两侧的对称适配器。加任何渠道 = 加一侧适配器，Loop 与其它渠道零感知。
- **Loop 渠道无关**：它只读写工作项 + 拥有自己的记忆和目标仓库。换禅道、换飞书，Loop 零改动。
- **什么不算"渠道"**（Loop 直接拥有，不经枢纽）：cargo-knowledge（记忆）、目标代码仓库（执行对象）、推理本身。

---

## 4. 工作项 = 集成枢纽

复用 pi-web 现有工作项（`lib/work-items/`），**零改动其核心**，仅：
- 新增可选字段 `external: { source, sourceId, url, lastSyncedAt }`（Importer 写，去重 + 溯源）。
- 复用 `repositories` / `tags`（Importer 预填，Loop 消费）。
- 复用 `phase` 状态机（驱动 Loop 选品 + Exporter 触发）。
- 复用 `events.jsonl`（append-only 时间线）作为 **Exporter 的事件源**。
- 复用 `manifest.git.branch_rules`：requirement=`feature/{date}/{slug}`，bug=`hotfix/{date}/{slug}`，`create_after: plan_approved` **已配好**。

> 工作项既对外（渠道枢纽）又对内（Loop 的工作记忆）。它的富特性（README 原始描述 verbatim、events 时间线、人工批注）是 Importer 物化进来的价值落点。

---

## 5. Importer SPI（入站，可换）

```ts
// lib/importers/types.ts
export interface Importer {
  readonly kind: string;                    // "chandao" | "jira" | ...
  listAssigned(filter: AssigneeFilter): Promise<SourceItem[]>;
  getDetail(sourceId: string): Promise<SourceItemDetail>;   // 含 <img> 原始引用
  getAttachment(fileId: string): Promise<{ bytes: Buffer; ext: string }>;
}
```

**Importer 的 runner**（= 旧设计里的"传感器"，现降级为定时 I/O）：cron/webhook/manual 触发，对每条：
1. 按 `external.sourceId` 查工作项：不存在→建（下载图片 §9 + 写 README verbatim + 读映射预填仓库/敏感标）；存在且 open→追加更新；已归档→跳过。
2. 汇总写一条工作项 event（`type: imported`，含新增/更新计数）→ 触发 Exporter 通知。

**runner 跑在哪**：loop host 进程里的一个**非 Loop 系统定时任务**（pi-web 调度都在 host；web 服务器不持定时器）。manual/webhook 经 web 端点转发给 host。
**拉取是确定性 I/O，不交给 LLM**（防幻觉/参数错）。

---

## 6. Exporter SPI（出站，可换）

```ts
// lib/exporters/types.ts
export interface Exporter {
  readonly kind: string;                    // "feishu" | "chandao-writeback" | "email" | ...
  onWorkItemEvent(event: WorkItemEvent, item: WorkItemRecord): Promise<void>;
}
```

- **事件源**：工作项 `events.jsonl`（新建 / phase 变 / milestone）。Exporter 订阅新增事件。
- **`FeishuNotifier`**：phase→待评审、受阻、完成等 → 飞书消息。**直接用 `lib/feishu/client.ts`**（确定性，不走 LLM）；可选 LLM 渲染摘要。
- **`ChandaoWriteback`**（v2）：phase→完成 → 禅道 resolve bug / 评论。
- **触发即消息**：Loop 只负责写工作项 phase/event，**不调用任何渠道**。通知完全由工作项事件驱动。

> 这意味着飞书从"Loop 调的扩展"变成"Exporter 适配器"。Loop 彻底渠道无关；`feishu-transport` 的 LLM 扩展仍保留给 ad-hoc 场景。

---

## 7. 研发 Loop（唯一会进化的核心）★

### 7.1 触发与选品
- **cron**（推荐工作日 9:00）+ **manual**。事件触发（工作项进 dev-ready）v1 不开，仅更新工作项；稳定后再加。
- 每 tick **串行选一个**：`phase==待开发` ∧ 无在途 run ∧ 优先级最高 ∧ 首个。
- `eventId = "exec-<workItemKey>"`（如 `exec-BUG-7`）→ 同工作项重复触发天然去重。

### 7.2 一轮的闭环（OODA + Learn）
```
orient  读 STATE.md(校准表/敏感清单/选品策略) + cargo-knowledge(模块要点)
        + RUNS.jsonl(近期反馈) + 工作项backlog
decide  选品 + 信心自评(校准表修正) + 风险分级(查敏感清单)
act     [gate1 批计划] → TDD maker(起分支+写码) → checker(跑测试)
measure PR 命运(合/拒/要求改) + 测试结果 + 人评审意见
learn   ↘ 机器写 RUNS.jsonl += {module,conf,outcome,...}
        ↘ 纯函数 aggregate(RUNS) → 覆写 STATE 派生块
        ↘ LLM 写  有可泛化结论 → cargo-knowledge += 笔记
        ▼ 下一轮 orient 读到更厚/更准的记忆 → round N+1 更准
```

### 7.3 治理模型：信心 × 验证 × 风险分级
```
① 信心: agent 对"需求理解+方案明确"的自评 (high/med/low) —— 用校准表修正过
② 验证: checker 跑 build + 模块测试 的客观结果 (green/red)
③ 风险: 改动是否落在「敏感清单」(费用/风控/鉴权/退关/对外接口)

①high ∧ ②green ∧ ③非敏感 → 自动"做": 写码→测试→开PR，写工作项phase=待评审
其余                    → 停 gate1，写工作项phase=待计划评审
```
**红线**：「自动做」**只到开 PR**；合并主干**永远是人点头的可回滚动作**（gate2 永不跳过）。

### 7.4 进化机器（确定性核 + LLM 定性）★

**核心原则：可计算的用确定性纯函数，需判断的才给 LLM。绝不信任 LLM 数数。**

三个存储 + 写法：

**a. `RUNS.jsonl` —— append-only 永不删，确定性 schema，机器写**
```json
{ "runId":"...", "workItemKey":"BUG-7", "module":"finance-service", "repo":"cargoware",
  "predictedConf":"high", "riskTier":"sensitive",
  "outcome":"changes_requested", "tests":"green", "humanDecision":"...", "ts":"..." }
```

**b. STATE.md 派生块（Calibration / Sensitive-auto）—— 纯函数推导，可覆写**
`learn/aggregate.ts`（纯函数，无 LLM）跑一遍 RUNS.jsonl，重算并**覆盖**写入：每模块 high-conf 实际准确率、每模块 strike 数（changes_requested+rejected）、每模式卡住率。派生数据可重算 → 覆写安全。

**c. cargo-knowledge 笔记 + STATE 自由段 —— LLM 写，append-only**
orchestrator 的 learn 阶段，**只在有可泛化结论时**写知识笔记（§7.6）。

**行为变化怎么发生（具体例子）**：
> round 1–5 都在 finance-service：3 次 high-conf→merged，2 次 high-conf→changes_requested。aggregate 算出 (finance-service, high) 准确率 = 0.6 < 阈值 0.7 → 派生块标"该模块 high 视为 medium"。round 6 再碰 finance-service：orient 读到 → 把 high 当 medium → **gate1 自动启用**。这就是肉眼可见的进化。

**learn 步骤归谁**：v1 不另起 learner subagent，由 orchestrator 在 measure 之后自己做（跑 aggregate + 写笔记）。maker/checker 只管代码（developer/tester）。

### 7.5 约束分层（L0–L4 + 不对称演化）★

| 层 | 约束 | 性质 |
|---|---|---|
| **L0 不变式** | ① 永不自动合并主干 ② 只能动工作项声明仓库 ③ 改动只在 feature/hotfix 分支 ④ 同时只一个工作项在途 ⑤ 每轮可观测(RUNS+SSE) | 硬，不可违 |
| **L1 三重闸** | 信心×验证×风险，决定 auto-do vs 人审 | §7.3 |
| **L2 人闸** | gate1(批计划，敏感/低信心时) + **gate2(批合并，永不跳过)** | 合并是唯一不可逆点 |
| **L3 演化安全** | **不对称自动调整** + 不可变审计日志 + git 可回滚 | ★见下 |
| **L4 资源界** | 单轮超时、单工作项尝试上限(N 次失败泊车通知)、token 预算 | 防失控 |

**★L3 不对称演化**：进化能**自动收紧**，**放宽必须人确认**——永远朝更谨慎方向自由跑，朝更激进方向要人点头。
- 敏感清单：strike 到阈值 → **自动加入**敏感；想移除（连续 K 次干净）→ **必须人确认**。
- 信心校准：准确率低 → 自动把模块 effective tier **抬高**；想**降低**（放松）→ 人确认。
- 知识笔记：append-only，永不自动删；人改过的笔记 Loop 不再覆写（§7.6）。
- 保险：**RUNS.jsonl 不可变**（可重算/审计）+ **STATE.md 在 git 里**（坏进化可 revert）。

### 7.6 知识库契约 ★

cargo-knowledge 是 OKF（Markdown+frontmatter），`knowledge` 能力一开会自动挂 `kb_search`（L1）。双向：

**读（orient）**：开发某模块前，`kb_search("<module> 陷阱 注意")` + L0 `grep`，把相关笔记喂进 plan。
**写（learn）**：round 有可泛化结论时，append 一条 OKF 笔记：
```yaml
---
type: learning
module: finance-service
author: loop                 # 区分来源
autoManaged: true
derivedFrom: run:01KZ...     # 溯源到具体 run
tags: [fee, charge]
---
finance-service 的费用计算依赖 BookingRoute.isTransfer，改 charge 逻辑前必查。
```

**防污染规则（已确认）**：
- 信任序：`author: human` > `author: loop`。orient 优先采信人写的。
- **一旦人编辑过某笔记**（git 检测）→ 标 authoritative，**Loop 不再覆写**（只允许 append 新笔记）。
- Loop **只增不删**；冲突笔记上浮通知人裁决。

**统一知识工件**：§8 的「模块→仓库/敏感映射表」本身做成 cargo-knowledge 里一份结构化文档——Importer 读它预填、Loop 的 learn 阶段校正它，映射可审计。

### 7.7 记忆三件套分工
- **STATE.md**：校准表 + 敏感清单 + 选品策略 + 在途状态（短中期，派生块可覆写、自由段 append）。
- **RUNS.jsonl**：原始反馈（每轮预测 vs 实际），**append-only 永不删**，校准/统计源头。
- **cargo-knowledge**：长期代码库理解（跨轮跨工作项），只增、人可编辑修正。

> 进化记忆按「模块/代码库」键，**不按工作项键** → 换 Importer/换渠道，对 cargoware 的累积理解原封不动带得走。Loop 学的是代码库，不是某条工作项。

---

## 8. Phase 0 — 验证脚手架（已大幅满足）

**探测结论（事实）**：cxin 目标仓库**已有成熟验证面**，Phase 0 = "确认现有命令当闸门" + "定敏感清单 v1"。

| 仓库 | 技术栈 | checker 命令 | 现状 |
|---|---|---|---|
| `cargoware` | Java/Spring Boot/Maven，19 模块 | `mvn -pl <module> -am compile` + `mvn -pl <module> test` | **353 个 `*Test.java`、36 test 目录** ✅ |
| `cargoware-h5` | Vue + Jest + ESLint | `npm run test:ci`(=lint+test:unit) | `@vue/cli-plugin-unit-jest` 已配 ✅ |
| `cargo-report-server-haichuang` | Java/Spring Boot | `mvn test` | 单模块，待确认用例量 |
| `cargoapi` | （根目录无 pom/package，待查） | — | 待 Phase 0 核实 |

Phase 0 任务（研发 Loop 的第 0 号工作项，人审批后 agent 做）：① 跑通各仓库 build/test 确认可作闸门；② 定敏感模块清单 v1；③（可选）给零测试关键模块补 1~2 冒烟测试。

---

## 9. 图片处理

禅道 `<img src="/index.php?m=file&f=read&t=png&fileID=507">`（会话认证，脆弱）。
**已验证**：`GET /api.php/v1/files/{fileID}` + Token header **直接返回二进制**。
Importer 流程：① 正则抓 `fileID=NNN`；② `getAttachment(NNN)`；③ 落盘 `<work-item-dir>/attachments/chandao-NNN.<ext>`；④ 改写 README 的 `src` 为相对路径；⑤ 随工作项进 git，离线可渲染。

---

## 10. 类型映射

工作项只 `requirement|bug`（不新增 type，避免动 KEY 计数器/git 规则/UI/events）：禅道 **bug→`bug`(BUG-####)**、**task→`requirement`(REQ-####)**，KEY 取自 `manifest.work_items.next{Bug,Requirement}Number`。

---

## 11. 凭据存储（对标 feishu）

`~/.pi/agent/importers/<workspaceId>.json`（mode `0600`）：
```json
{ "chandao": { "base":"https://chandao.hi-strong.com", "account":"qiancheng",
  "password":"…", "token":"…", "assignee":"qiancheng", "productId":2, "executionId":3 } }
```
token 401 时用 account+password 自动重签（`POST /api.php/v1/tokens`）。飞书凭据沿用 `~/.pi/agent/feishu/<wsId>.json`，Exporter 复用其 client。

---

## 12. 流程图

### 12.1 总览
```
┌──────────────────────────────────────────────────────────────────┐
│  外部世界                                                            │
│   禅道 ──webhook──┐                              人(human)          │
└───────────────────┼──────────────────────────────┬─────────────────┘
        cron(30m)   │  Importer runner               │ PR评审 / gate
        /manual ────▼│  (非Loop·I/O)                  │
╔══════════════════════════════════════╗                            │
║ ① Importer (ChandaoImporter)          ║                            │
║   listAssigned→getDetail→getAttachment║                            ║
║   ↓ 去重  图片落盘  改写src  读映射预填  ║                            ║
╚════════════════╤═══════════════════╝                            │
                 │ 写                                                  │
┌────────────────▼───────────────────────┐                          │
│ ② 工作项 backlog (枢纽)                 │                          │
│   REQ/BUG phase=待开发  events.jsonl     │                          │
└────────┬───────────────┬────────────────┘                          │
         │ cron(9:00)/manual选品          │ events 触发               │
         ▼                               ▼                           │
╔═══════════════════════════╗   ┌──────────────────┐                 │
║ ③ 研发 Loop (会进化·详12.2)║   │ ④ Exporter        │                 │
╚═════════════╤═════════════╝   │  FeishuNotifier   │◀──── 人反馈 ────┘
              │ 写phase/event   └────────┬─────────┘
              └───────────────────────────┘
                       │ 待人审PR
                       ▼  人合并主干 → phase=完成
```

### 12.2 研发 Loop · 一轮（6 阶段 + 闸门 + maker/checker + learn）
```
╔════════════════ 研发 Loop · 一轮 ════════════════╗
║ [触发] cron每日/manual    eventId=exec-<key> (同key去重)
║     ▼
║ ORIENT  读 STATE.md + cargo-knowledge + RUNS.jsonl + 工作项
║     ▼
║ DECIDE  选品 + 三重判定(信心[校准表修正]×验证×风险[敏感清单])
║     ├ 全绿(high∧非敏感) ──► 直跑 ACT
║     └ 否则 ──────────────► 【gate1: 人批计划】 approve ▼
║ ACT  maker(developer): 写/补测试(TDD)→起分支(branch_rules)→实现
║      checker(tester):  mvn -pl <module> test / npm run test:ci
║                        绿→开PR  红→回滚·受阻
║     ▼
║ MEASURE  PR命运 + 测试 + 人评审意见
║     ▼
║ 【gate2: 人审diff·批合并】 ◀── 永不跳过   人合并 ▼
║ LEARN  (确定性核 + LLM定性)
║   ├ 机器写: RUNS.jsonl += {module,conf,outcome,...}
║   ├ 纯函数: aggregate(RUNS) → 覆写 STATE 派生块(校准/敏感·自动收紧)
║   └ LLM写:  有可泛化结论 → cargo-knowledge += 笔记(author:loop)
║     │
╚═════│════════════════════════════════════════════╝
      └► 回 ORIENT: 下一轮读到更厚/更准的记忆 = 进化
```

### 12.3 进化闭环（为什么它是 Loop）
```
   每轮 LEARN 产出
   RUNS.jsonl ── append-only·永不删
       │ ▼ 确定性纯函数 aggregate() (不让LLM数数)
   STATE 派生块(可覆写·可重算): 校准表/敏感(自动)/选品策略
   cargo-knowledge (LLM写·append): 模块要点/陷阱笔记
       │ 下一轮 ORIENT 读 ▼
   DECIDE 行为改变: 高准确率→直跑 / 低准确率→high也降级触发gate1
                   新敏感→走人闸 / 卡住模式→不再选
   ⇒ round N+1 ≠ round N   ← 这才是 Loop

   约束(贯穿): L0不变式 / L1三重闸 / L2人闸(合并永不跳) /
             L3不对称演化(自动收紧·放宽需人)+RUNS不可变+STATE在git / L4资源界
```

---

## 13. 落到现有 pi-web 构件（不发明新范式）

| 新增/复用 | 构件 | 说明 |
|---|---|---|
| **新增** | 工作区能力 `requirement-sources` | `ALL_WORKSPACE_CAPABILITIES`+type+配置 UI（管理 Importer/Exporter 凭据） |
| **新增** | `lib/importers/` | `types.ts`(SPI)+`chandao-importer.ts`+`runner.ts`+`config.ts`(0600) |
| **新增** | `lib/exporters/` | `types.ts`(SPI)+`feishu-notifier.ts`（订阅工作项 events） |
| **新增** | Importer 系统定时任务 | loop host 里一个**非 Loop** cron job + web 端 sync/manual/webhook 入口 |
| **新增** | 一个研发 Loop 定义（cxin `loops/`） | `loop.yaml`/`LOOP.md`/`STATE.md`/`agents/{developer,tester}.md` |
| **新增** | `lib/loop/learn/aggregate.ts` | 确定性纯函数：RUNS.jsonl → STATE 派生块 |
| 复用 | Loop 引擎 | cron/manual 触发、maker/checker、L2 gate、eventId 去重、SSE 代理 |
| 复用 | `subagent` 工具 | developer/tester 作 loop-scoped subagent（`extraAgentDirs`） |
| 复用 | 工作项 | 加可选 `external` 段；phase 状态机驱动 Loop+Exporter；events.jsonl 喂 Exporter |
| 复用 | `manifest.git.branch_rules` | feature/hotfix + `create_after:plan_approved` **已配好** |
| 复用 | `lib/feishu/client.ts` | FeishuNotifier 直接用（确定性，不走 LLM） |

---

## 14. 实施阶段（结构先行，进化后上）

| 阶段 | 产出 | 验收 |
|---|---|---|
| **P0** Importer SPI + ChandaoImporter | 能力+适配器+配置 UI+测试连接 | token 拉到列表/详情/图片 |
| **P1** Importer runner | cron/webhook/manual 拉取→工作项(含图片)→去重→event | 3 bug+4 task 正确落工作项，重跑不重复 |
| **P2** Phase 0 验证闸门 | build/test 当 checker 闸门 + 敏感清单 v1 | `mvn test`/`npm run test:ci` 可作闸门 |
| **P3** Exporter + 研发 Loop v1（**结构闭环，暂不全进化**） | FeishuNotifier + 选品+三重判定+TDD maker/checker+分支/PR+gate+通知；learn 先只追加 RUNS + 写最简 STATE | 1 个低风险工作项跑通，人审 PR 合并 |
| **P4** 进化上线 | 接通四信号（确定性 aggregate + LLM 笔记）：信心校准/敏感演化/理解沉淀/选品自调 | 连跑数轮可见 STATE/knowledge 增长、打回率下降 |
| **P5** 收敛 | 风险清单调优、对可信模式放宽 gate1（仍需人确认） | 稳定串行跑队列 |

每阶段独立上线、独立回滚。**P3 先把闭环结构搭对，P4 才喂进化**——避免又把"结构"和"学习"搅在一起。

---

## 15. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| LLM 自评信心过度自信 → 错误方案到 PR | 信心不单独放行；叠 ②验证绿+③非敏感；敏感域一律 gate；校准表持续纠偏 |
| 进化方向跑偏（学到错的模式） | RUNS 永不删=可审计；人可编辑 cargo-knowledge/STATE 纠偏；敏感清单放宽需人确认 |
| 多模块跨仓库（后端+前端） | v1 一工作项只指一仓库；跨仓库拆两个 |
| 禅道 token 失效/接口变更 | Importer 层隔离；token 自动重签；适配器单测 |
| execution 长时间在途阻塞 | 无在途才选新品；PR 挂 N 天自动标受阻通知 |
| 自动开 PR 噪音 | 默认串行 + 飞书汇总；可配仅工作日 |

**待定（非阻塞）：**
- [ ] 敏感模块清单 v1 谁定（建议你 + Phase 0 一起核）
- [ ] cron 频率（Importer 30min / Loop 工作日 9:00，文中推荐值）
- [ ] P5 放宽 gate1 的具体阈值

---

## 附录 A — Chandao Importer API 事实表（已实测）

| 用途 | 方法 | 端点 | 备注 |
|---|---|---|---|
| 取 token | POST | `/api.php/v1/tokens` body `{account,password}` | 明文走 HTTPS，返回 `{token}` (201) |
| 我的 Bug 列表 | GET | `/api.php/v1/products/{pid}/bugs?assignedTo={user}` | 分页 `{page,total,bugs[]}` |
| 我的任务列表 | GET | `/api.php/v1/executions/{eid}/tasks?assignedTo={user}` | 同形（executions 复数） |
| 单条详情 | GET | `/api.php/v1/bugs/{id}` · `/api.php/v1/tasks/{id}` | `steps`/`desc` 含 `<img>` |
| 下载图片 | GET | `/api.php/v1/files/{fileID}` + `Token` header | **直接返回二进制流** ✅ |
| （备用）网页登录 | POST | `/index.php?m=user&f=login` | md5(md5(pw)+rand)+verifyRand+keepLogin；**v1 不用**，优先 token API |

## 附录 B — cxin 工作区现状（实测）

- 路径 `~/.pi/workspaces/workspace-c`，id `01KYRBBY917PW4X0VHMY5GC8TE`
- 能力：software-development 模板
- skills：grilling / domain-modeling / codebase-design / **tdd** / software-copyright-materials
- git.branch_rules：requirement=`feature/{date}/{slug}`，bug=`hotfix/{date}/{slug}`，`create_after: plan_approved` ✅
- work_items：next_requirement_number=11，next_bug_number=7
- code 仓库：cargoware / cargoware-h5 / cargo-h5-mp / cargoapi / cargo-report-server-haichuang
- knowledge：cargo-knowledge

## 附录 C — 决策记录（grilling 结论）

| 决策 | 选择 | 理由 |
|---|---|---|
| 集成边界 | 工作项=集成枢纽，渠道是两侧对称适配器 | 唯一真相源；加渠道零感知；Loop 渠道无关 |
| 禅道定位 | 一个 Importer（可换），非主角 | 源无关；换平台只换适配器 |
| Loop 数量 | 1 个会进化的研发 Loop（拉取/通知降级为适配器） | 会学的才叫 Loop；cron 只是触发器 |
| 执行范围 | A 全自主开发（写码到 PR，不自动合并） | B 提升太小；生产代码合并需人审 |
| 验证策略 | Phase 0 + 测试随工作生长 | cargoware 已有 353 测试，闸门现成 |
| 治理 | 信心×验证×风险三重判定；gate2 永不跳 | LLM 信心不可靠，叠客观验证+风险 |
| 进化核 **A** | 可计算=确定性纯函数，LLM 只做定性 | 不信任 LLM 数数；保证校准可靠 |
| 不对称演化 **B** | 自动收紧自由、放宽需人 | 进化只往安全方向自由跑 |
| 知识防污染 **C** | 人改过即权威、Loop 不覆写 | 防 Loop 污染知识库 |
