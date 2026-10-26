# 交付引擎终局架构：深引擎、三接缝、门在人手

日期：2026-10-26

状态：用户已批准（2026-10-25 会话「同意」终局方向）；未实施。本文是交付自动化的**终局基线**——后续各实施阶段都朝本文收敛，不再有过渡架构。实施计划另行落 `plans/`。

前置：Phase-1~5 已合入（designer / developer / verifier / release-preparer 四角色全链 + 单进程宿主 + 工作项中央页）。2026-10-22 草案已定「四个角色是资源配置与会话职责，不是四个 Extension」；Phase-2~5 为最小增量把角色合同暂放 lib。本文把它归位，并补齐终局缺口（ask / attention / review / integrate / acceptance / loop 退役编排）。

## 1. 意图与已确认决定

用户判断（2026-10-25 会话）与本文确认的决定：

1. **裁决与干活彻底分离**。谁能动手、产出算不算数、阶段能否推进——全部在引擎（lib 代码，随产品分发）；怎么设计、怎么实现、怎么评审——全部在工作区（数据，随工作区演化）。分界判据是**删除测试**：把一句话删掉，若它会在每个工作区的剧本里重新长出来（如「先 claim 再动手」「只领指派项」）→ 属引擎；不会（如「全链路追踪每跳给 file:line」）→ 属剧本。
2. **角色是工作区资源**（2026-10-22 草案原意归位）：`.pi/agents/<role>.md` **正文整段注入**角色会话的 system prompt；frontmatter `model:` 是模型覆写来源之一。产品不再在运行时注入任何干活指令文字——它只在开启自动化时**播种模板**（见 §6.2）。
3. **接缝只开三个**：剧本（profile 正文）、命令（verification.checks / integrate 命令）、模型（每角色 model）。三个接缝都已有两份真实差异（cargoware 剧本 vs lib 默认、JDK8/H5 双 gate、角色分档），是真接缝。
4. **人工门不是接缝**：confirm-design、验收、record-release 只能 actor=user，**永远不存在 LLM 工具形态**（延续既有硬规则）。
5. **ask 是一等回合结果**：角色会话可以「向人提问」结束回合——问题作为数据落进工作项、进 attention 队列；人答复后项回池，下一次 attempt 的任务包携带全部问答。grilling 的「一次一问」降为剧本风格（designer 模板可写「一次最多一问」），不再是引擎规则，也不再依赖一个活着的聊天窗口。
6. **人的通道只有一个**：attention 队列统一「待确认设计 / 待验收 / 待登记发布 / 待答问题 / 阻塞泊车」五类待办；digest 只是这个队列的定时渲染；催办与泊车按配置年龄线。grilling 插话、验收卡、digest 专属轮、催办升级逻辑作为**独立机制**消失。
7. **先审后跑回归**：现在的 verifier 拆成两步——`review`（agent 评审，可选阶段）+ `checks`（system 确定步，引擎在冻结候选上执行 checks）。LLM 不再只做 `delivery_run_check` 的 for 循环；diff 评审（Phase-2 之前 dev-loop tester 的核心价值）回归流水线。
8. **两环境模型入产品**：`integrate`（系统命令步，可选）与 `acceptance`（人工门，可选）成为可选阶段。cargoware 式「feature 合 develop = 测试发布、人在测试环境验收」在流水线里有了主人；单环境项目关掉即可。
9. **loop 只剩巡逻**：loop 机制保留为定时任务调度器（cron / 补跑 / 轮锁 / 超时杀），失去全部流水线职权——无 STATE.md、无选品、无阶段戳、无派发、无工作项写路径。**结构性保证而非合同保证**：loop 会话没有 role grant，`delivery_*` 工具直接拒绝；不需要 LOOP.md 写「禁建工作项」来约束。
10. **退役清单**：dev-loop 编排者会话与 LOOP.md 全生命周期合同；STATE.md 的流水线记忆职责（流水线状态 = item.yaml + events.jsonl + claim.json / attempts）；`loop.*` 阶段戳族；loop kit 协议中的宪法文件（`.pi/loop/constraints.md`、`.pi/loop/budget.md`）与 lib 内对它们的一切引用（现存于 designer 合同，系过期细节）。`.pi/loop/pause-all` 保留（宿主文件，路径不改，避免 kit 协议 churn）。
11. `delivery.yaml` 升 `schemaVersion: 2`；v1 文件照常解析且**语义等价**（无 stages 块 = 可选阶段全关 = 现状），在途项不受迁移影响。

## 2. 目标、范围与明确排除

完成后的终局：

- 引擎是一个深模块：对模型暴露的接口 = **6 个工具 + 按执行者类型的一段不变式合同（≤10 行）**；池投影、领取事务、证据执行、预算、中断、attention 全部藏在接口后面。
- 角色剧本、验证命令、集成命令、模型分档全部由工作区数据决定；换一个工作区（不同栈、不同 gate、不同分支纪律），lib 一行不改。
- 人的全部介入收口在一个 attention 队列：看一眼知道等谁、等多久、怎么答。
- loop = 无状态幂等的巡逻任务（同步 / learner / digest 推送），与流水线零耦合。

明确排除（本终局不做，也不给接缝）：

- 通用 DAG / 可拖拽工作流编辑器（接缝只有三类执行者 agent/system/human，阶段词表固定，工作区不可自定义阶段或人工门）。
- 工作区自定义角色集合（需要新角色时作为产品特性加一次、全体受益，同 Phase-2→5 先例）。
- agent 证据自证（证据类别封闭：引擎执行的 checks + 人登记的记录；agent 自述永不构成证据）。
- 多槽位并发、子任务依赖图、发布执行自动化（发布永远人的手）、多人账号体系。

## 3. 方案选择

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| loop 定义 agent、lib 不定义（2026-10-25 用户初始直觉） | 工作区完全自由；但裁决回到文字合同——双会话竞态靠模型自觉（2026-10-25 dev-loop 双会话异常即实例）、自述可当证据、编排者自身需要反自欺表约束 | 不采用：裁决必须在代码 |
| 现状延伸（四合同留 lib，profile 继续只当 model 指针） | 改动最小；但接口撒谎（`profile` 名不副实）、工作区知识没有角色级落脚点、lib 携带工作区过期细节（宪法文件引用） | 不采用：接缝错位 |
| 声明式 DAG 流水线（工作区自定阶段图） | 最通用；但真实差异目前只有「两环境」一种（一个 adapter 是假接缝），且阶段语义随工作区漂移会瓦解 UI 与证据承诺 | 不采用：用固定可选阶段覆盖已知差异 |
| **深引擎 + 三接缝 + 固定可选阶段** | 裁决全代码、干活全数据、已知差异产品化、接口尺寸可度量 | 本文 |

接口尺寸度量（模块深度的操作化判据，设计评审沿用）：

| 代 | 模型必须知道的接口 | 深度 |
| --- | --- | --- |
| dev-loop（二代） | LOOP.md 两百余行 + 四 profile + 十一种阶段戳 + STATE.md 约定 + 反自欺表 | 接口≈实现，深度≈0 |
| Phase-2~5（三代现状） | 5 工具 + 一段合同 | 深；但合同混入干活内容，profile 是假接缝 |
| 终局 | 6 工具 + ≤10 行不变式；干活内容全在工作区 adapter | 深，接缝对位 |

## 4. 分层与接缝

### 4.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ 人                                                          │
│ attention 队列：问题 / 确认设计 / 验收 / 发布登记 / 阻塞       │
├────────────────────────────────────────────────────────────┤
│ 引擎  lib/work-items/                      ← 产品，纯代码    │
│  状态机+三个人工门+基线冻结（delivery.ts，已有）               │
│  池投影 / 领取事务 / digest 复验 / 预算 / 中断（已有）          │
│  证据执行器 checks / integrate（system 步）                   │
│  回合装配：不变式合同 + 工作区剧本 + 任务包（改）               │
│  attention 队列 + ask 结果类型（新）                          │
├────────────────────────────────────────────────────────────┤
│ 工作区  <ws>/.pi/                           ← 数据，三接缝   │
│  agents/<role>.md 剧本正文（整段注入）                         │
│  delivery.yaml v2：可选阶段 / 全角色 model / checks / 集成命令 │
│  AGENTS.md 仓库事实（pi 从 cwd 注入，既有通道）                │
├────────────────────────────────────────────────────────────┤
│ 巡逻  <ws>/.pi/loops/                       ← 定时任务        │
│  禅道同步 / learner / digest 推送；无领取权（无 grant）        │
└────────────────────────────────────────────────────────────┘
```

### 4.2 接缝与永不开放清单

| 接缝 | 变的是什么 | 工作区提供 | 现状 |
| --- | --- | --- | --- |
| 剧本 | 追踪深度、design.md 形态、评审清单、分支纪律 | `.pi/agents/<role>.md` 正文 | 假接缝：`role-session.ts:255-276` 只读 `model:` |
| 命令 | gate 命令、集成脚本、超时、目标仓 | checks / integrate | checks 已有；integrate 无 |
| 模型 | 角色分档 | `roles.<role>.model` | 仅 designer/developer 双键（`config.ts:24`） |

**永不开放**（开放即产品承诺失效）：阶段词表与顺序；三个人工门及其人手属性；证据类别；回合结果词表（submit / fail / ask）；单槽位领取与预算语义；digest 绑定与复验；不变式合同文字本身。

### 4.3 引擎的模型接口（终局冻结面）

工具恰六件：`delivery_list_ready_tasks`、`delivery_claim_task`、`delivery_submit_result`、`delivery_fail_task`、`delivery_ask_human`（新）、`delivery_run_check`（仅 checks 所属阶段的回合可用）。不变式合同按执行者类型（agent / system 无 prompt；human 无会话）固定一段，内容即 4.3.1；**新增工具或加长合同需在本文件修订并留痕**。

4.3.1 agent 不变式合同（全文，lib 常量，工作区不可覆写）：

> 1. 先 `delivery_claim_task` 成功才动手；本轮只领指派项，不可领取即说明并结束。
> 2. 只在 claim 返回的 worktree / 目录内写，其余一律只读；不合并、不推送、不碰受保护分支——集成与发布是引擎与人的事。
> 3. 本轮以 submit / fail / ask 三者之一结束；结束时不得留进行中的领取。
> 4. 自述不是证据；检查只经 `delivery_run_check` 触发。
> 5. 确认、验收、发布登记没有工具——那是人的手。
> 6. 项目事实（gate 命令、构建环境、分支纪律）查工作区 AGENTS.md 与你的剧本。

修订记录：2026-10-26 写第一步实施计划时，规则 2 并入「不合并、不推送、不碰受保护分支」——现行四段合同共有此条，且终局中集成是引擎 system 步、发布是人手，按删除测试属不变式而非剧本。同日注：第一步落地时规则 3 暂为「submit / fail 二者之一」——`delivery_ask_human` 随第二步上线即改为上文终文；代码常量由测试钉死当前文本，改文先改此处。同日注（final-fix）：代码常量（`AGENT_INVARIANT_CONTRACT`）内的工具名一律裸写、不加 markdown 反引号——本文的反引号是文档排版；代码库 prompt 习语从不给工具名加反引号。第二步（2026-10-26）：规则 3 切换为终文「submit / fail / ask 三者之一」，常量与钉死测试同步切换。

## 5. 流水线终态

### 5.1 执行视图

| 步骤 | 执行者 | 可选 | 产出 / 门 |
| --- | --- | --- | --- |
| intake | 人 / 导入 | | README 原始描述 |
| design | agent `designer` | | design.md + 验收条件；或 ask |
| confirm-design | **人工门** | | 绑 design digest |
| implementation | agent `developer` | | 每仓候选 commit（worktree 引擎预建） |
| review | agent `reviewer` | ✓ | 评审结论 → 通过 / rework（source: code 或 spec） |
| checks | **system** | | 引擎在冻结候选执行 checks——唯一机器证据 |
| integrate | **system 命令** | ✓ | 合进集成分支；失败/冲突 → attention（不自动重试） |
| acceptance | **人工门** | ✓ | 测试环境验收记录，绑 candidate digest |
| release_ready | agent `release-preparer` | | 发布材料草稿（releasePlan） |
| record-release | **人工门** | | released，基线冻结 |

### 5.2 phase 存储词表不变

`intake / design / ready_for_implementation / implementation / verification / release_ready / released` 七值不动（UI、看板、旧项兼容全部锚在它上面）。上表是**执行视图**：review 属 verification 的前半步；checks（+integrate）成功由引擎把 verification 推进到 release_ready；acceptance 是 release_ready 内的门条件——`stages.acceptance.enabled` 时 record-release 缺验收记录即拒绝（记录绑 candidateDigest，候选被换即失效，与既有确认/验证失效规则同族）。所有新产物（review 结论、clarifications、acceptance）落 `delivery/` 元数据并走 events.jsonl 追加，artifact 文件落工作项内。

### 5.3 verifier 拆解与返工路由

- review 启用时：implementation 提交候选 → reviewer 领取评审 → 通过才跑 checks；rework 按源头路由（code → implementation；spec → design，走既有 rework）。review 关闭时直跑 checks（现状语义）。
- checks 由引擎执行（现状 verifier 会话对 run_check 的循环改为 system 步）：冻结候选 checkout、逐条跑、结果落 checkResults——机器侧不变，只是不再消耗一次 LLM 会话与预算。
- checks 全绿 → （integrate 启用则执行集成命令，成功才推进）→ phase=release_ready。任一环失败：checks 红 → rework(code)；integrate 失败 → 项停 verification + attention 条目（人裁决重试或返工，引擎不自动重试集成）。
- 人工 `submit-verification` / `record-verification`（手动模式）语义不变。

第三步落地决策（2026-10-26 修订记录，写第三步实施计划时钉死）：
- **角色词表**：`DELIVERY_ROLES = designer | developer | reviewer | release-preparer`（verifier 退役）；`LEGACY_DELIVERY_ROLES = ["verifier"]` 仅供读旧 attempts / claim / seeding 记录（类型 `AnyDeliveryRole`），永不再派发。配置 `roles.verifier` 键**接受并忽略**（deprecated，console.warn 一次）——不让第一步落地的 v2 文件变 400。已播种的 `verifier.md` 是工作区文件，不动；reviewer 模板按一次性记录正常播种（记录里无 reviewer → 写）。
- **reviewer**：池谓词 = `stages.review.enabled` ∧ phase verification ∧ candidates 非空 ∧ 无 `delivery.review` 或其 `candidateDigest` ≠ 当前 ∧ 共用门。领取预建只读候选 checkout（复用 `prepareVerifyCheckouts`）并冻结 `candidateDigest`；`delivery_run_check` 对 reviewer 开放（针对性佐证，结果同样只经服务端记录；**权威全量运行是 system 步**）。submit 形状 `{ key, outcome: "pass" | "rework", source?: "code" | "spec"（rework 必填）, notes }` → `delivery.review = { outcome, source?, notes, candidateDigest, at, attemptId }`，事件 `delivery.reviewed`；pass → phase 仍 verification（system 步接手）；rework → **与既有返工过渡共享同一 helper**：code → 与原 verifier 失败路径逐字同构（ready_for_implementation + 清下游证据）；spec → 与人工 `rework target=design` 逐字同构。rework 是裁定不是执行失败——不计预算（verifier 先例）。fail = 标准（release claim，phase 不变）。
- **system checks 步**（`lib/work-items/delivery-runner/checks-step.ts`）：due = phase verification ∧ candidates ∧ `verification.checks` 非空 ∧ （review 关闭 ∨ `review.outcome === "pass"` 且 digest 当前）∧ 无 `delivery.verification` 或其 digest ≠ 当前 ∧ 共用门（无 claim / 无中断 / 未 paused）。执行：锁内写 **system claim**（`ClaimState.role: "system"`、`sessionId: "system:<ulid>"`——复用 claim.json 占槽：池 `active-claim` 门、dispatcher 超时清道夫、单槽位全部自然生效，**不加运行态文件**）+ 事件 `delivery.checks_started` → 锁外预建 checkout、逐条 `runConfiguredCheck` 并经 `recordCheckResult` 落 `claim.checkResults` → 锁内结算（与原 `submitVerifierResult` 核心抽成共享 `finalizeChecks`）：全 passed → `delivery.verification`（actor system）+ phase release_ready + `delivery.checks_passed`；任一 failed → rework(code) 过渡 + `delivery.checks_failed`；任一 unverified（环境）→ 清 claim、`status: "blocked"`、`delivery.checks_unverified`（人修环境后 unblock 即再次 due）。checks 结果不计失败预算（verifier 先例）。dispatcher 在 LLM 派发**之前**跑 system 步（占槽即互斥）。
- **工具面不变（六件）**：`delivery_run_check` 的身份门从 verifier 改为 reviewer；submit/fail 的 verifier 分支删除、reviewer 分支加入。
- **配置** v2 增 `stages?: { review?: { enabled: boolean } }`（integrate / acceptance 第四步再加），缺省关闭 = 现状语义。
- **UI**：详情页 review 记录块（结论 / 源头 / 意见 / 时间）；执行卡 system claim 显示「系统检查」+ checkResults；设置块 review 开关；角色表随 `DELIVERY_ROLES` 自动四行（designer / developer / reviewer / release-preparer）。

### 5.4 ask 的语义

- `delivery_ask_human({question, options?, recommended?})`：清 claim（同 fail 的释放路径）、不计失败预算、不产 blocked；`delivery.clarifications[]` 追加 `{round, question, options?, askedAt}`；attention 入队（question 类）。
- 人答复走新人工动作 `answer-clarification`（答案追加进同条记录，actor=user）；答复后项自动回池（digest 未变则免重跑上游）。
- 任务包（§6.1）从此携带全部 clarifications 问答——grilling 的共识以数据形态沉淀在工作项里，而非会话记忆。

第二步落地决策（2026-10-26 修订记录，写第二步实施计划时钉死）：
- **存储**：`DeliveryMetadata.clarifications?: DeliveryClarification[]`，条目 `{ id, role, question, options?, recommended?, askedAt, attemptId, answer?, answeredAt? }`；`id` = ULID；走 `parseDelivery` 逐字段校验；events 只追加 `delivery.asked` / `delivery.answered`。
- **ask 事务**（claim.ts 新函数，四角色同形）：三凭据 + cancel 守卫 → 追加 clarification → 清 claim（同 fail 释放路径）→ **phase 不变**（designer 停 design、developer 停 implementation 等——人答后直接续跑，不回退；回退是 fail 的语义）→ `status: "open"`（不产 blocked）→ attempt 记 `outcome: "asked"` → **不计失败预算**（`failure-window` 不写）→ conversationId 自链接。
- **不被重领**：池共用谓词新增 `无未答 clarification`（`clarifications.some(c => c.answer === undefined)` → reason `awaiting-answer`，四角色同）；人答复后条件自然解除、项回池。
- **人工动作** `answer-clarification`：加入 `DELIVERY_ACTIONS`；payload `{ clarificationId, answer }`；守卫：条目存在且未答，否则 409/400；追加 `answer`/`answeredAt`，phase/status 不变；`lastRequest` 幂等同族。**刻意不做 LLM 工具**（答问题是人的手，与 confirm/record 同列）。
- **任务包**：opening prompt 增一段「人的答复」——按 `askedAt` 升序列出全部已答 clarifications（问 → 答），未答的不会出现（有未答项不可领取）。
- **attention 投影**：`lib/work-items/attention.ts` 纯函数 `projectAttention(items, config, now)` → `AttentionEntry[]`（`{ key, kind: question|confirm|acceptance|release|blocked, since, ageDays, nudged: boolean, parked: boolean, detail }`）；`GET /api/workspaces/[id]/attention`（只读，无 capability 门）。`since` 取各类的锚事件时间（question = 最早未答 `askedAt`；confirm = design 阶段进入时间；release = 进入 release_ready 时间；blocked = block/中断/paused 时间；acceptance 第四步再实装）。
- **催办与泊车**：dispatcher 每拍对每个 enabled 工作区跑 `projectAttention`；`ageDays ≥ nudgeAfterDays` 且未催过 → 追加事件 `delivery.nudged`（actor=agent，data {kind, ageDays}）；`ageDays ≥ parkAfterDays` 且未泊过 → 写 automation-paused（复用，`reason: "attention-parked"`）+ 事件 `delivery.parked`。「催过/泊过」以 events 里是否已有同 kind 的 `delivery.nudged` / `delivery.parked`（晚于 `since`）判定——**不加运行态文件**，不 bump revision 的需求由事件追加本身满足（appendEvent 不改 item.yaml）。`attention: { nudgeAfterDays, parkAfterDays }` 进 config v2，缺省 3 / 7，正整数且 park ≥ nudge。
- **UI**：工作项中央页顶部「待处理」条（attention 条目按 kind 分组，点击定位项）；详情页 question 类条目内联「回答」表单（走 `answer-clarification` 动作）。digest 渲染（巡逻）不在第二步。

## 6. 回合装配

### 6.1 装配序（唯一通道，`launchRoleSession` 的终态形态）

```
system prompt = 工作区 AGENTS.md（pi 从 cwd 注入，既有）
             + agent 不变式合同（§4.3.1，lib 常量）
             + .pi/agents/<role>.md 正文（工作区剧本，整段）
model = roles.<role>.model ?? profile frontmatter.model ?? 默认
opening prompt = 任务包指针：README 原始描述、上游产物（design.md /
             候选 commit / checkResults / clarifications 问答 /
             rework 理由）、worktrees 清单、checks 清单（如适用）
```

lib 中现存的四段角色合同与 opening 模板**删除**（职责 / 产出 / 方法全部归剧本与任务包数据）。

### 6.2 模板播种

产品内置四（+reviewer 共五）份**剧本模板**（`lib` 内常量或随包文件，内容=现四合同的干活部分改写 + reviewer 新模板）。开启交付自动化（或首次保存 delivery.yaml v2）时：`.pi/agents/<role>.md` **缺文件才写**，写后即工作区文件，产品永不重建、永不改写（与 AGENTS.md managed segments「标记没了就停」同精神，更简单：播种是一次性的）。一次性由产品持有的 `<ws>/.pi/delivery-seeded.json` 记录（`{schemaVersion, roles}`）：已记录的角色永不改写、用户删了不重建（删除即终局——`wx` 只看文件在场，挡不住复活，记录才是真相源）；未记录但文件在场（用户预置或竞态 EEXIST）收养记 `existing`，同样永不写；记录不可读/畸形 → fail-safe 一字不写、本次全跳过（「永不重建」压过播种）。

## 7. delivery.yaml v2

```yaml
schemaVersion: 2
enabled: true
stages:
  review:     { enabled: true }
  integrate:  { enabled: true, command: "bash .pi/scripts/integrate.sh {repositoryId} {branch}" }
  acceptance: { enabled: true }
roles:
  designer:         { profile: designer, model: { provider: zhipu, modelId: glm-4.6 } }
  developer:        { profile: developer }
  reviewer:         { profile: reviewer }
  release-preparer: { profile: release-preparer }
verification:
  checks:
    - { name: booking, repositoryId: cargoware, command: "JAVA_HOME=$HOME/.local/jdk8 mvn -pl booking-service -am test", timeout_seconds: 1800 }
    - { name: h5, repositoryId: cargoware-h5, command: "npm run test:ci" }
budget:    { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 }
attention: { nudgeAfterDays: 3, parkAfterDays: 7 }
```

- `roles` 四键同形（profile / model 均可选；缺省回默认模型）；`stages.integrate.command` 的 `{repositoryId}` `{branch}` 为引擎替换占位符（候选逐仓执行）。
- `attention` 两档年龄线驱动催办与泊车（§8）。
- v1 兼容：`schemaVersion: 1` 照常解析，语义 = v2 关闭全部可选阶段、roles 只认已写键；升级不自动改写在途项。

## 8. attention 队列

- **派生视图，不是新存储**：引擎从活动项投影五类条目——`question`（有未答 clarification）、`confirm`（design 待确认）、`acceptance`（启用且 release_ready 未验收）、`release`（release_ready 待登记 / 材料 drafting 完成可发布）、`blocked`（含 integrate 失败、泊车、未确认中断）。每条含项 KEY、类别、首挂时间、年龄、催办史。
- 催办与泊车：年龄过 `nudgeAfterDays` 重发一次提醒（进 digest / 通知），过 `parkAfterDays` 自动 `delivery.paused`（automation-paused 既有机制，标「待人」），人翻案即恢复。dev-loop 的 3 天线 / 7 天线语义至此归一。
- digest = 队列的定时渲染（巡逻任务或前端通知，业务语言、零内部术语——延续 dev-loop digest 的读者契约）。
- 新人工动作两件：`answer-clarification`（§5.4）、`record-acceptance`（绑 candidateDigest）。其余消化走既有动作。

## 9. loop 终局

- loop = `{cron, budget(max_minutes), 入口(skill 或 脚本)}`，跑完即走、无状态幂等；STATE.md / .lastrun 以外的运行态不再存在（.lastrun / .round.lock / pause-all 为宿主文件保留）。
- 巡逻任务族：禅道同步（现 `.pi/scripts/chandao-sync.py` 原样）、learner（读 attempts/events 提炼候选，写 `cxin-knowledge/learnings/`，泛化两问留剧本）、digest 推送。
- kit 协议退役：宪法文件（constraints / budget）从协议与文档中移除；loop 与工作项的绑定字段（`item.loop`）保留但语义收窄为「巡逻参考」，不再是流水线路由。
- dev-loop 的退役动作：编排合同与 STATE.md 停用；`.pi/agents/` 四份剧本经人工校订后改挂 roles（analyst→designer、implementer→developer、tester→reviewer、learner→巡逻）；在制项走完或迁移后关闭 loop。

## 10. 现状差距（2026-10-26 已核对代码事实）

引擎底盘全部保留复用：领取事务与三凭据、digest 复验、worktree 预建、心跳、中断记录、attempts 审计、automation-paused、`DeliveryRole` role grant 身份门、工具恰五件（list / claim / submit / fail / run_check）、人工动作族（start-design / confirm-design / start-development / submit-verification / record-verification / prepare-release / record-release / rework / block / unblock / cancel）。

差距（本设计的实施内容）：

1. `role-session.ts:53-192` 四段合同与 opening 模板 → 拆为不变式合同（新）+ 模板播种（新）+ 任务包（改）。
2. `role-session.ts:255-276` 假 profile（只读 model）→ 正文注入。
3. `config.ts:24` roles 双键 → 四键；新增 stages / attention / integrate 命令。
4. `pool.ts:44` `DeliveryRole` 四值 + phase→role 硬编码 → 增 reviewer；review/checks/integrate 的池投影与 system 步执行器（新）。
5. 新工具 `delivery_ask_human` + clarifications 数据面 + `answer-clarification` / `record-acceptance` 动作。
6. attention 队列投影与 UI（WorkItemsPage 详情「待处理」面收口）。
7. lib 与 kit 文档中宪法文件引用清除（含 `role-session.ts:60` designer 合同内过期引用）；`docs/reference/loops.md` / `work-items.md` / AGENTS.md 对应小节随实施同步。
8. 无 `initializeDelivery` / 就绪清单 / delivery managed 块 / 角色摘要与组合预览路由；`components/AgentsConfig.tsx` + `/api/subagents/profiles` 已是 `.pi/agents/*.md` 的完整编辑器（复用，不重造）；`saveSubagentProfile` 无哈希冲突检测；交付块仅 designer/developer 两个 profile 文本框。

## 11. 落地顺序（每步都是终局形状的一部分，无过渡架构）

1. **接缝归位**：profile 正文注入 + roles 四键 + 不变式合同 + 模板播种（四段硬编码合同删除）。——纯装配层改动，池/事务/工具零动。**已落地 2026-10-26**（719cd8ae..19bf3763；计划 `plans/2026-10-26-final-arch-1-seam-repositioning.md`）。
2. **ask 与 attention**：`delivery_ask_human`、clarifications、answer-clarification、队列投影与年龄线、digest 渲染。**已落地 2026-10-26**（a7035523..8ff123c9；计划 `plans/2026-10-26-final-arch-2-ask-and-attention.md`；digest 渲染留第 5 步巡逻）。
3. **review + checks 系统化**：reviewer 角色与可选阶段；checks 从 verifier 会话改为 system 步；verifier 角色退役（其 submit 形状由引擎结果接管）。
4. **integrate + acceptance**：集成命令执行器与失败语义、record-acceptance 门条件。
5. **loop 退役编排**：宪法文件出协议、dev-loop 停编排、剧本改挂、cargoware 切换演练。
6. **初始化与配置面完善**（不依赖 2–5，可并行）：`initializeDelivery` 与向导、checks 探测草稿、就绪清单、delivery managed 块、`--from` 复制、`seeded_from` 模板对比 / 另存、AgentsConfig 交付感知（角色徽标、锁定不变式）、profile 保存哈希冲突。（角色表 / 剧本下拉 / ModelSelector / 组合预览随第 1 步 Task 4 落。）

每步验证基线：引擎既有测试全绿；新增行为按本文件 §5/§8 断言；端到端冒烟覆盖 ask→答→续跑、review→rework 路由、integrate 失败挂 attention、acceptance 门拒绝无记录的 record-release；`tsc` / `lint` / `node:test`，不跑 `next build`。

## 12. 默认选择与实施者自由度

请用户在实施前重点复核的默认：

- 可选阶段默认**全关**（v1 语义等价；cargoware 开 review / integrate / acceptance 三件）。
- ask 不计失败预算、不产 blocked；答复后自动回池。
- acceptance 门只卡 record-release，不阻塞 release-preparer 起草（材料与验收可并行）。
- integrate 失败不自动重试（人裁决）；命令逐仓执行、占位符仅 repositoryId / branch 两个。
- 模板播种「缺文件才写、永不改写、删了不重建」（一次性记录在 `.pi/delivery-seeded.json`）；剧本自此归工作区。
- verifier 退役（checks 系统化后无剩余职责），reviewer 为新第五角色。
- init 永不代翻 `enabled`；checks 探测只出草稿不自动落盘；复制不继承（`--from` 剥 repositoryId、不复制 AGENTS.md）；模板漂移只提示 + 另存，永不原地覆盖。
- 配置面写文件不另建存储；profile 缺省同名；有效模型 = 覆写 › 剧本默认 › 工作区默认；profile 保存带哈希、冲突 409。

实施者自由：模板文案细节、任务包渲染形态、attention 队列的查询与 UI 实现、integrate 命令进程管理细节、各步内部文件拆分。不可改变：三接缝与永不开放清单（§4.2）、六工具 + 不变式的接口冻结面（§4.3）、七值 phase 词表（§5.2）、门在人手、证据类别封闭、以及「每步落地即终局形状」的增量原则。

## 13. 多工作区约定、初始化与配置面

> 2026-10-26 追加（用户同意）：回答「第 N 个项目怎么开始、怎么配」。多项目一致靠引擎是同一份代码、布局是同一份契约；差异只许出现在三个接缝；初始化是幂等、只补缺、永不覆盖的操作；跨项目复用走复制不继承；页面是文件的编辑器而不是第二个存储。

### 13.1 工作区契约

| 路径 | 内容 | 归属 | 更新策略 |
| --- | --- | --- | --- |
| `.pi/workspace.yaml` | 身份、capabilities、仓库登记、分支规则、计数器 | 产品 | 产品维护；仓库「扫描为事实」（既有） |
| `AGENTS.md` | 人写的项目事实 + managed 块（git / repositories / knowledge / **delivery**） | 人 + 产品（仅标记内） | 标记内产品改写、标记外不碰、标记删了即停同步（既有规则） |
| `.pi/delivery.yaml` | v2：可选阶段、角色 profile/model、checks、integrate、预算、attention | 人（经设置面板） | 产品只解析校验归一，不自动改 |
| `.pi/agents/<role>.md` | 角色剧本 | 产品播种一次 → 人 | 一次性播种（记录在 `.pi/delivery-seeded.json`）、永不改写、删了不重建 |
| `.pi/delivery-seeded.json` | 播种记录 | 产品 | 产品维护 |
| `.pi/agents/<其他>.md` | 别名剧本、普通 subagent profile | 人 | 不碰 |
| `.pi/scripts/integrate.sh` | 集成命令（开 integrate 时） | 产品播种骨架 → 人 | 缺文件才写 |
| `.pi/work-items/` | 数据 | 引擎 | 事务写 |
| `.pi/loops/<name>/` | 巡逻任务声明 | 人 | 调度器只读 frontmatter |
| `.pi/scripts/` 其余、`.pi/templates/`、知识库目录 | 人的东西 | 人 | 不碰 |

所有权一句话：**产品写的东西，要么在产品专属文件里，要么在显式标记之间，要么只写一次；其余全是人的。** 命名约定三条：角色文件名 = 角色名（别名经 `roles.<role>.profile` 指向）；集成脚本固定 `.pi/scripts/integrate.sh {repositoryId} {branch}`；checks 的 `name` 建议 `<仓别名>[-<类型>]`。新增 **delivery managed 块**（`<!-- workspace-managed:delivery:start/end -->`）渲染启用角色、checks 一行摘要、integrate / acceptance 开关——不变式第 6 条让模型查 AGENTS.md，此块使其对自动化状态自描述；机制与 repositories 块同构（无标记不建、标记删了即停）。

### 13.2 初始化 `initializeDelivery(workspacePath, { from? })`

新建（`createWorkspace`，capability 驱动、无模板）与导入（`importWorkspace`，cargoware 式外部目录）一视同仁；入口 = 设置 › 交付自动化「初始化」向导（亦可 API / CLI）。**只补缺、只建议、不自动启用、不自动跑命令**，重跑幂等：

1. 能力：显式勾选 `work-items` + `workflows`（沿用「不隐式修改 capabilities」）。
2. 仓库：触发扫描登记（既有），人确认 kind。
3. 工具链探测 → checks **草稿**：按仓根 `pom.xml` / `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` 生成 `mvn -q test` / `npm test` / `pytest` / `go test ./...` / `cargo test` 草稿，人逐条改删后落盘。这是 init 最值钱的一步——checks 是唯一机器证据，无它 verifier 池投影即 `no-checks-configured`；模块级 Maven、切 JDK 之类在此由人改命令。
4. 写 `delivery.yaml` v2 默认：`enabled: false`、可选阶段全关、roles 四键空（缺省同名）、预算 / attention 默认、checks 取确认结果。
5. 播种剧本（§6.2）或自 `from` 复制（§13.3）。
6. AGENTS.md delivery 块（有标记才渲染）。
7. integrate 骨架：仅勾选 integrate 时写 `.pi/scripts/integrate.sh`（注释写明参数、退出码、幂等要求）。
8. 启用由人翻 `enabled`；init 永不代翻。
9. 就绪清单（只读、非门禁）：无 checks / 角色无剧本 / 能力缺项 / checks 指向未登记仓——复用池投影 reason 词表，不另造。

### 13.3 跨项目复用：复制不继承

`init --from <工作区或任意同布局目录>`：复制 `.pi/agents/<role>.md`、`delivery.yaml`（**剥 repositoryId**：checks 留 name/command、仓绑定清空待面板重绑）、`.pi/scripts/integrate.sh`；**不复制 AGENTS.md**（项目事实，复制即错）。复制即新所有者，源头改动不传播——共享可变源头 = 一处改动炸多项目，与 cargoware LOOP.md 和 pi-web loops 文档各自漂移是同一种病。团队标准剧本 = 维护一个同布局目录作 `from` 源，升级靠显式再拷。

内置模板漂移：播种时 frontmatter 盖 `seeded_from: <role>@<模板版本>`；模板升级后面板提示「模板已到 vN，你的剧本基于 vM」并提供「新模板另存为 `<role>.template.md`」——永不原地覆盖。

### 13.4 多工作区运行时（已成立，无新机制）

dispatcher 每拍遍历 `discoverWorkspaces`、每工作区独立配置与单槽位、失败预算 per 工作区、role grant 带 workspacePath 隔离、巡逻 loop per 工作区。N 项目 = N 槽位。全局模型预算上限不做（单真实工作区，假接缝）。

### 13.5 配置面：页面是文件的编辑器

页面每个动作写的都是引擎与 agent 读的那几个文件（`.pi/delivery.yaml`、`.pi/agents/<role>.md`、AGENTS.md），不另建存储——agent 读文件、git 跟踪、手改与 `--from` 复制仍成立；与「中央页与侧栏不得各持一份业务状态」是同一条规则。现成底子：`components/AgentsConfig.tsx` + `/api/subagents/profiles?cwd=` 已是 `.pi/agents/*.md` 的完整编辑器（name / description / systemPrompt / tools / 模型），`ModelSelector` + `/api/models?cwd=` 已有，交付块的 checks 编辑器已有。

- **设置 › 交付自动化** = delivery.yaml 全字段：总开关、可选阶段（integrate 带命令）、预算、attention、checks、**角色表**（每行：角色 / 剧本下拉 = 项目作用域 profile 列表，缺省「同名」/ 模型 ModelSelector / 状态 = 存在·缺失·基于模板 vN / 操作 = 编辑剧本·预览 prompt）、就绪清单、初始化向导入口。「编辑剧本」经 `settings-navigation` 深链进 AgentsConfig 选中该 profile。
- **剧本编辑器** = 既有 AgentsConfig + 交付感知：被绑定 profile 显示角色徽标；编辑区上方**锁定显示**将前置的不变式（灰底、锁、链 §4.3.1）；**组合预览**三段叠出 `AGENTS.md`（可编辑，跳文件）▸ `不变式`（锁定）▸ `剧本正文`，各标来源——改哪里、改了变成什么，一眼看完；后续「与模板对比 / 另存副本」。
- **工作项执行卡**：attempt 旁「查看本回合 system prompt」。
- **看得见改不了**：不变式、阶段词表、人工门——显示 + 锁 + 链 spec。可配置与不可配置的边界在 UI 与代码是同一条线。
- **模型两落点统一认知**：有效模型 = delivery 覆写 › 剧本 frontmatter › 工作区默认；角色表显示有效值与来源，角色表改的是覆写、编辑器改的是剧本默认。
- **并存手改**：保存带内容哈希，外部改过 → 409 提示重载（现 `saveSubagentProfile` 直接覆盖，需补）。

### 13.6 明确不做

工作区间隐式继承或全局可变剧本源；init 自动启用 / 自动执行探测命令 / 自动复制项目事实；工作区自定义角色集合或阶段（§2）。
