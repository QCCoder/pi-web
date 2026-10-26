# 终局第二步：ask 一等结果 + attention 队列 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 角色会话可以用第六件工具 `delivery_ask_human` 向人提问并结束回合（清 claim、phase 不变、不计预算）；问题作为数据落在 `delivery.clarifications[]`，人用新人工动作 `answer-clarification` 答复后项自动回池，下一回合的任务包携带全部问答。引擎从活动项投影统一的 **attention 队列**（question / confirm / release / blocked 四类；acceptance 第四步），dispatcher 按 `attention.{nudgeAfterDays,parkAfterDays}` 年龄线落 `delivery.nudged` 事件与 automation-paused 泊车。不变式规则 3 切换为终文「submit / fail / ask 三者之一」。

**Architecture:** 数据面扩 `DeliveryMetadata`（delivery-types）；事务在 `claim.ts` 加一组四角色同形的 `askHuman*`；工具第六件注册在 `tools.ts`；人工动作走既有 `planDeliveryTransition` / `applyDeliveryAction` 与 `[action]` 路由（零新路由）；池共用谓词加一条 reason；新模块 `lib/work-items/attention.ts`（纯投影）+ dispatcher 每拍一次催办/泊车 + 一条只读路由；UI 两处（中央页待处理条、详情页回答表单）。**接口冻结面变更**：工具从五件到六件（spec §4.3 终局即六件）——`tools.test.mjs` 的「恰五件」钉改为「恰六件」。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent（原样）、node:test + jiti、TypeBox 工具 schema。

**Spec:** `docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md` §4.3.1（规则 3 终文 + 修订记录「第二步」）/ §5.4（含 2026-10-26「第二步落地决策」）/ §6.1（任务包含问答）/ §7（`attention` 块）/ §8 / §10 差距 5–6 / §11 第 2 步。用户已批准终局（2026-10-25/26）。

## Global Constraints

- 不修改 `@earendil-works/pi-*` 源码或依赖版本；**绝不运行 `next build`**；验证只跑 `node --test`、`node_modules/.bin/tsc --noEmit`、`npm run lint`。
- **delivery 工具参数禁止 union / any-of schema**（pi SDK 调用侧解析不工作，测试钉死）——`delivery_ask_human` 的 `options` 用 `Type.Optional(Type.Array(Type.String()))`，`recommended` 用 `Type.Optional(Type.String())`，不得用 `Type.Union`。
- **人工动作永不做 LLM 工具**：`answer-clarification` 只走 UI/API；工具面恰六件（list / claim / submit / fail / ask / run_check）。
- `events.jsonl` 只追加；一切更新带 `expectedRevision`；带 `conversationId` 的事件自动合并会话（ask 事务透传 sessionId，与 submit/fail 同习语）。
- **ask 不计失败预算**：不写 `failure-window.json`、不计入 `countRecentFailures`（attempt `outcome: "asked"` 与 submitted/failed 正交；预算计数遇 `asked` **既不计数也不断连**——越过继续往回数）。
- **phase 不变**：ask 事务对任何角色都不回退 phase（回退是 fail 的语义）；`status` 回 `open`。
- 催办/泊车**不加运行态文件**：「催过/泊过」以 events 中晚于 `since` 的同 kind `delivery.nudged` / `delivery.parked` 判定；泊车复用 automation-paused（`reason: "attention-parked"`），人用既有 resume 翻案。
- `attention` 配置：`nudgeAfterDays` / `parkAfterDays` 正整数，`park ≥ nudge`，缺省 3 / 7；v1/v2 文件缺块照常解析。
- 范围守恒：`role-templates.ts`、`role-preview.ts`、`worktrees.ts`、`checks.ts`、`role-grants.ts` 不改；dispatcher 只增一步 `attend`（不改现有 reap/dispatch 逻辑）。
- 每任务以可运行测试结尾并提交；conventional 前缀；只暂存任务列出的文件（工作树含用户 WIP）。

### 本计划引入的默认选择（请用户复核）

1. ask 后 `status: "open"`、phase 不变、不产 blocked——与 spec §5.4 一致；人答后项回池由谓词条件解除实现，无需显式「resume」。
2. `attention.since` 锚点：question = 最早未答 `askedAt`；confirm = 最近一次 `delivery.start-design` 事件时间（无则 item.updatedAt）；release = 最近一次进入 release_ready 的事件时间（`delivery.submitted` outcome verified / `record-verification` passed，无则 updatedAt）；blocked = 最近 `delivery.block` / `delivery.automation_paused` / 中断记录时间。
3. 催办只落事件（`delivery.nudged`），不发通知（通知/digest 属巡逻，第五步）；泊车写 paused + `delivery.parked` 事件，人 resume 即恢复，泊车后不再催。
4. attention 路由不设 capability 门（只读，与 roles/preview 同款）；UI 条只在 work-items 能力开启的工作区显示。
5. `answer-clarification` 不改 revision 以外的任何阶段字段；重复答同一条 → 409 Conflict（已答不可覆盖——改答案建新问题是 agent 的事）。

---

### Task 1: 数据面 — clarifications 类型、解析、events 词表、attention 配置

**Files:**
- Modify: `lib/work-items/delivery-types.ts`（`DeliveryClarification`、`DeliveryMetadata.clarifications?`、`DELIVERY_ACTIONS` 增 `"answer-clarification"`、`DeliveryAction` 联合增值、`parseDelivery` 逐字段校验）
- Modify: `lib/work-items/delivery-types.test.mjs`
- Modify: `lib/work-items/delivery-runner/config.ts`（`attention?: { nudgeAfterDays: number; parkAfterDays: number }`，缺省 3/7，`parseAttention`：正整数、park ≥ nudge）
- Modify: `lib/work-items/delivery-runner/config.test.mjs`
- Modify: `lib/work-items/delivery-runner/attempts.ts`（`AttemptRecord.outcome` 增 `"asked"`；`countRecentFailures` 遇 `asked` 跳过不断连——见 Global Constraints）
- Modify: `lib/work-items/delivery-runner/attempts.test.mjs`

**Interfaces:**

```ts
// delivery-types.ts
export interface DeliveryClarification {
  id: string;                 // ULID
  role: DeliveryRole;         // 从 roles.ts 引（零依赖，安全）
  question: string;
  options?: string[];
  recommended?: string;
  askedAt: string;            // ISO
  attemptId: string;
  answer?: string;
  answeredAt?: string;        // 与 answer 同在同缺
}
export interface DeliveryMetadata { /* 既有 */ clarifications?: DeliveryClarification[] }
export type DeliveryAction = /* 既有 11 */ | "answer-clarification";
// parseDelivery：clarifications 可选数组；每条 id/role(isDeliveryRole)/question/askedAt/attemptId 必填非空；
//   options 字串数组可选；answer 与 answeredAt 必须同在同缺；坏形 → Validation。
// config.ts
export interface DeliveryRunnerConfig { /* 既有 */ attention: { nudgeAfterDays: number; parkAfterDays: number } }  // 解析后必有（缺块回填默认）
// attempts.ts
outcome?: "submitted" | "failed" | "interrupted" | "asked";
// countRecentFailures：遇 "asked" continue（不计、不 break）；遇 "submitted" break 不变。
```

- [ ] **Step 1: 失败测试**——parseDelivery：合法 clarifications 透传；缺 id/question/askedAt → Validation；role 非词表 → Validation；answer 有 answeredAt 无 → Validation；options 非字串数组 → Validation；无 clarifications 键照常。DELIVERY_ACTIONS 含 `answer-clarification`（且 `lastRequest.action` 校验接受它）。config：缺 attention → 默认 3/7；`nudgeAfterDays: 0` / 小数 / `park < nudge` → Validation；round-trip 保留。attempts：`countRecentFailures` 序列 `[failed, asked, failed]` 计 2；`[failed, asked, submitted, failed]` 计 1（submitted 断连）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全量 + tsc + lint** → **Step 5: Commit** `feat: delivery clarifications data model, attention config and asked attempt outcome`

---

### Task 2: ask 事务（四角色同形）+ 池谓词 `awaiting-answer`

**Files:**
- Modify: `lib/work-items/delivery-runner/claim.ts`（新 `askHumanQuestion(input)`——单函数按 `expectedRole` 分派校验，四角色共享实现；复用 fail 的释放骨架但 phase 不变、status open、attempt outcome asked、不写 failure-window）
- Modify: `lib/work-items/delivery-runner/claim.test.mjs`
- Modify: `lib/work-items/delivery-runner/pool.ts`（共用 `sharedReasons` 增 `awaiting-answer`：`item.delivery?.clarifications?.some(c => c.answer === undefined)`；`DesignerPoolReason` 联合增值）
- Modify: `lib/work-items/delivery-runner/pool.test.mjs`

**Interfaces:**

```ts
// claim.ts
export interface AskHumanInput {
  workspacePath: string; key: string; attemptId: string; generation: number; ownerToken: string;
  role: DeliveryRole;                 // = grant.role；与 claim.role 不符 → Conflict
  question: string; options?: string[]; recommended?: string; conversationId?: string;
}
export async function askHumanQuestion(input: AskHumanInput): Promise<{ detail: WorkItemDetail; clarificationId: string }>;
// 锁内：三凭据（requireActiveClaim expectedRole=input.role）+ cancel 守卫 → clarification {id: ulid, role, question, options?, recommended?, askedAt: now, attemptId}
//   追加到 delivery.clarifications → 清 claim（同 fail 路径）→ phase 不变、status "open"、revision+1 → 事件 delivery.asked
//   (actor agent, data {attemptId, generation, clarificationId, question 摘要≤120}) → attempt outcome "asked" → conversationId 自链接 → commit。
//   question 空白 → Validation；不写 failure-window；不触 automation-paused。
```

- [ ] **Step 1: 失败测试**——四角色各一 happy path（phase 不变、status open、claim 清、clarification 落盘含全字段、attempt asked、事件、自链接、revision+1）；凭据不符 409；role 与 claim.role 不符 409；cancel 后 409；question 空 400；**预算不受影响**（ask 后 `countRecentFailures` 不变、`failure-window.json` 不存在）；幂等（同 attemptId 重放 → Conflict，claim 已清）。pool：有未答 clarification 的项四角色谓词均含 `awaiting-answer`、不在 ready；答复后（手工补 answer）谓词恢复；无 clarifications 零变化回归。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: ask-human claim transaction and awaiting-answer pool predicate`

---

### Task 3: 第六件工具 + 不变式规则 3 终文 + 任务包携带问答

**Files:**
- Modify: `lib/work-items/delivery-runner/tools.ts`（注册 `delivery_ask_human`；描述与 promptGuidelines；execute 走 `askHumanQuestion`，成功后 `resetToBareGrant`；工具计数六件）
- Modify: `lib/work-items/delivery-runner/tools.test.mjs`（「恰五件」→「恰六件」；schema 无 union 守卫覆盖新工具；分派与错误映射）
- Modify: `lib/work-items/delivery-runner/role-session.ts`（`AGENT_INVARIANT_CONTRACT` 规则 3 → 「本轮以 submit / fail / ask 三者之一结束；结束时不得留进行中的领取。」；`openingPromptFor(role, task, context?)` 增可选 `clarifications` 段——按 askedAt 升序「问 → 答」，只列已答；无已答则不出该段）
- Modify: `lib/work-items/delivery-runner/role-session.test.mjs`（钉死文本更新；opening 含/不含问答段）
- Modify: `lib/work-items/delivery-runner/role-preview.ts` **不改**（`composed` 自动随常量变）；`role-preview.test.mjs` 若钉了规则 3 旧文则更新
- Modify: `lib/work-items/delivery-runner/dispatcher.ts`（launch 前读项 `delivery.clarifications` 已答部分，透传给 `launchRoleSession({ …, clarifications })`——只读，不改派发逻辑）
- Modify: `lib/work-items/delivery-runner/dispatcher.test.mjs`（透传断言）

**Interfaces:**

```ts
// tools.ts
pi.registerTool({ name: "delivery_ask_human", parameters: Type.Object({
  key: Type.String(), question: Type.String(),
  options: Type.Optional(Type.Array(Type.String())), recommended: Type.Optional(Type.String()),
}), execute: grant 门 + 凭据 → askHumanQuestion({ ..., role: gate.role, conversationId: sessionId }) → resetToBareGrant → result({ ok, clarificationId, message: "已向人提问并释放领取——结束本轮" }) ; Conflict → 「领取凭证已失效…结束本轮即可」 });
// role-session.ts
export interface LaunchRoleOptions { /* 既有 */ clarifications?: Array<Pick<DeliveryClarification, "question" | "answer" | "askedAt">> }
export function openingPromptFor(role, task, context?: { clarifications?: ... }): string;
//   段标题「## 人的答复（按时间）」；每条「Q: … / A: …」；仅 answer 非空的条目。
```

- [ ] **Step 1: 失败测试**——工具恰六件；`delivery_ask_human` schema 零 `anyOf`/`oneOf`（现有 no-union 守卫扫到它）；无 grant → denied；无凭据 → denied；成功 → 调用 askHumanQuestion 入参正确、grant 回 bare；Conflict 映射文案。不变式：钉死全文更新为终文（规则 3 含 `ask`），其余五条逐字不变。opening：有已答 → 含「人的答复」段与问答对、按 askedAt 升序、未答条目不出现；无已答 → 不含该段。dispatcher：launch 调用含 `clarifications`（只含已答）。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: delivery_ask_human tool, final invariant rule 3 and clarifications in the task package`

---

### Task 4: 人工动作 `answer-clarification`

**Files:**
- Modify: `lib/work-items/delivery.ts`（`planDeliveryTransition` case `"answer-clarification"`：payload `{ clarificationId: string; answer: string }`；守卫：条目存在（404 NotFound 语义用 Validation 400「clarification not found」）、未答（已答 → Conflict 409）、answer 非空；写 `answer`/`answeredAt`，phase/status 不变；事件 `delivery.answered`（actor user, data {clarificationId}）；`RELEASED_ALLOWED_ACTIONS` 不含它）
- Modify: `lib/work-items/delivery.test.mjs`
- Modify: `lib/work-items/legal-actions.ts`（`legalDeliveryActions`：有未答 clarification 且未 released/cancelled → 含 `answer-clarification`；`legalActionBarActions` **不含**——它由详情页内联表单触发，不进通用动作条）
- Modify: `lib/work-items/legal-actions.test.mjs`（若存在；否则在 delivery.test 中断言）
- `[action]` 路由零改动（slug 门读 `DELIVERY_ACTIONS`）——在 `routes.test.mjs` 加一条源断言确认新 slug 经权威表自动放行

- [ ] **Step 1: 失败测试**——happy：answer 落盘、answeredAt、phase/status 不变、revision+1、事件；不存在 id → 400；已答 → 409；answer 空 → 400；released 项 → 400（基线冻结）；`lastRequest` 幂等重放返回现态；legal：有未答 → 含动作，答完 → 不含，动作条列表不含。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: answer-clarification human action`

---

### Task 5: attention 投影 + 路由 + dispatcher 催办/泊车

**Files:**
- Create: `lib/work-items/attention.ts`
- Create: `lib/work-items/attention.test.mjs`
- Create: `app/api/workspaces/[id]/attention/route.ts`（GET → `{ entries: AttentionEntry[] }`；只读、无 capability 门；错误经 `workItemErrorResponse`）
- Modify: `lib/api-types.ts`（`AttentionEntry`、`AttentionResponse` 镜像类型）
- Modify: `lib/work-items/delivery-runner/dispatcher.ts`（`tickWorkspace` 增第三步 `await this.attend(workspace, config)`：投影 → 对每条 `ageDays ≥ nudge && !nudged` 追加 `delivery.nudged`；`ageDays ≥ park && !parked` → 写 paused(reason attention-parked) + `delivery.parked`；deps 注入 `projectAttention` / `appendEvent` / `writePaused` 便于测试）
- Modify: `lib/work-items/delivery-runner/dispatcher.test.mjs`
- Modify: `lib/work-items/delivery-runner/routes.test.mjs`（attention 路由源断言：GET only、无 capability 门）

**Interfaces:**

```ts
// attention.ts（纯函数，不读盘；输入 = listWorkItems 详情 + 事件 + paused/中断集合）
export type AttentionKind = "question" | "confirm" | "release" | "blocked";   // acceptance 第四步加
export interface AttentionEntry {
  key: string; title: string; kind: AttentionKind;
  since: string; ageDays: number;          // floor((now - since)/86400000)
  nudged: boolean; parked: boolean;        // events 中晚于 since 的 delivery.nudged / delivery.parked（同 kind）
  detail: string;                          // question 原文 / 「设计待确认」/ 「待登记发布」/ block 原因
  clarificationId?: string;                // question 类
}
export interface AttentionInput { items: Array<{ item: WorkItemRecord; events: WorkItemEvent[] }>; paused: Set<string>; interrupted: Set<string>; now: Date }
export function projectAttention(input: AttentionInput): AttentionEntry[];   // P0→P3→key 排序；archived/cancelled/released 不投影
export async function collectAttention(workspacePath: string, now?: Date): Promise<AttentionEntry[]>;   // 读盘装配后调 projectAttention（路由与 dispatcher 共用）
```

- [ ] **Step 1: 失败测试**——projectAttention：question（未答 → 条目、since = 最早未答 askedAt、答完消失）；confirm（phase design 且未 designConfirmed）；release（phase release_ready 且无 release 记录）；blocked（status blocked / paused / interrupted 各一）；ageDays 计算；nudged/parked 由事件判定（早于 since 的旧事件不算）；排序 P0→P3→key；archived/released/cancelled 零条目。dispatcher.attend：过 nudge 线且未催 → 恰一条 `delivery.nudged`，二拍不重复；过 park 线且未泊 → paused 写入 + `delivery.parked`，二拍不重复；泊车后不再催；未过线零事件；config 缺 attention 用默认。路由形状与只读断言。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: attention queue projection, route and dispatcher nudge/park`

---

### Task 6: UI（待处理条 + 回答表单）+ 文档三层

**Files:**
- Create: `components/work-items/AttentionBar.tsx`（中央页顶部：按 kind 分组计数 + 展开列表（KEY · 标题 · 年龄 · 催办/泊车徽标），点击 → 选中项；数据来自 `GET …/attention`，随既有 5s 增量刷新节拍）
- Modify: `components/work-items/WorkItemsPage.tsx`（挂 AttentionBar；选中联动）
- Create: `components/work-items/ClarificationPanel.tsx`（详情页：clarifications 列表——已答显示问答与时间；未答显示问题 / options 单选或文本 / 推荐值预填 / 「回答」按钮 → POST `[action]=answer-clarification`，payload `{clarificationId, answer}` + expectedRevision + requestId；成功 → invalidate）
- Modify: 详情视图挂载点（`WorkItemsPage.tsx` DetailView 或既有执行卡旁——实施者按现有结构选）
- Modify: `components/work-items/work-item-execution.test.mjs` 或新组件测试（若仓内有组件测试惯例；否则手测清单）
- Modify: `AGENTS.md`（「工作项 / 交付流」增两条：① ask 是一等回合结果——清 claim、phase 不变、不计预算；答复是人的手（`answer-clarification` 刻意不做 LLM 工具）；② 工具面恰六件（list / claim / submit / fail / ask / run_check）；catch-all 「催办/泊车只落事件 + paused，不加运行态文件」）
- Modify: `docs/reference/work-items.md`（Delivery 自动执行节：ask 事务、clarifications 数据面、池 `awaiting-answer`、任务包问答段、attention 投影与 dispatcher attend、UI 两组件）
- Modify: `docs/reference/file-map.md`（`attention.ts`、attention 路由、两组件）
- Modify: `docs/architecture.md`（人工门一句话旁加「人的通道 = attention 队列」一行）

- [ ] **Step 1: 失败测试 / 手测清单**——AttentionBar：四类分组计数正确、空队列不渲染、点击定位；ClarificationPanel：未答项显示 options/推荐值、提交走正确 payload、成功后变已答、已答只读；文档守卫同第一步（grep 旧规则 3 文本「二者之一」在 lib/docs 中为空）。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: attention bar and clarification answer panel with docs`

---

## 端到端冒烟（controller，dev server，`enabled: false` 的 API 级 + 一次真 launch 可选）

1. 新建项进 design → 用 API 直接构造一条 clarification（或开自动化让 designer 真问一次）→ `GET …/attention` 出 question 条目、池 `awaiting-answer`。
2. `POST …/delivery/answer-clarification` → 条目消失、池恢复 ready、`delivery.answered` 事件。
3. 把 `askedAt` 回拨 4 天 → 下一拍 `delivery.nudged` 恰一条；回拨 8 天 → paused + `delivery.parked`；resume → 恢复。
4. preview 路由 `invariant` 含「submit / fail / ask 三者之一」。
5. 重复答同一条 → 409；答不存在的 id → 400。

## 自审记录（写计划时已核对）

- Spec 覆盖：§4.3.1 规则 3 终文 → T3；§5.4 全部落地决策 → T1（存储）/ T2（事务 + 谓词）/ T3（工具 + 任务包）/ T4（人工动作）；§7 attention 块 → T1；§8 投影/催办/泊车/路由 → T5；UI → T6；§10 差距 5、6 → T2–T6。
- 已核事实：`DELIVERY_ACTIONS` 是 `[action]` 路由 slug 门与 `lastRequest.action` 校验的唯一权威（新 slug 自动放行）；`planDeliveryTransition` 是人工动作唯一入口（released 冻结守卫在前）；`sharedReasons` 是四角色谓词的共用尾段（加一条 reason 四角色即生效）；`countRecentFailures` 以 `submitted` 断连、`failed` 计数——`asked` 需显式跳过；`AttemptRecord.outcome` 三值联合需扩；dispatcher `tickWorkspace` 三步序 reap → dispatch 可追加 attend；`appendEvent` 不改 item.yaml（催办不 bump revision）；automation-paused 文件 + `resumeAutomation` 既有。
- 取舍：ask 事务单函数按 role 分派校验而非四个副本（四角色行为完全相同——phase 不变、status open，不像 fail 有角色相关回退）；催办状态存 events 而非运行态文件（spec 原则「不是新存储」+ 不 bump revision）；`answer-clarification` 不进动作条（有专属表单，动作条塞不下问题原文）；attention 路由只读无门（与 roles/preview 同款）。
- 未做：acceptance 类条目与 `record-acceptance`（第四步）；digest 渲染与通知（第五步巡逻）；reviewer（第三步）。
