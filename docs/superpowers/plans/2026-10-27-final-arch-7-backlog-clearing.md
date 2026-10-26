# 收尾步：清各步记档项 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉终审记档的行为项：checks 启动失败表面化（事件 + attention 锚点，每串一条）、泊车抑制派生 blocked 的重复 park、`askedAt`/`answeredAt` 日期校验、AgentsConfig 交付感知接线（宿主传 `workspaceId`）、WorkspaceManager PUT 携带 `attention` 块、init `from` 前置校验、managed 块 ENOENT 收窄、过时注释清理。**cargoware 切换演练不在本计划**（人工按 runbook 执行）。

**Architecture:** `checks-step.ts`（失败事件 + 去重）、`attention.ts`（锚点 + 抑制）、`delivery-types.ts`（日期校验）、`delivery-init.ts`（前置校验）、`delivery-managed.ts`（catch 收窄）、两个 shell + WorkspaceManager + AgentsConfig（UI，多为用户 WIP 文件，编辑不提交）。

**Spec:** §13.7（收尾步落地决策）/ §8 / §13.5.1。用户指示「继续写，还是用之前的方式，直到做完」（2026-10-27）。

## Global Constraints

同前六步：不修改 `@earendil-works/pi-*`；**绝不 `next build`**；`node --test` / `tsc` / `lint`；工具面恰六件；不加运行态文件；pathspec 提交（索引含用户暂存 knowledge/ 文件）；用户 WIP 文件编辑不提交；每任务测试收尾。

### 默认选择（请用户复核）

1. `checks_start_failed` 去重 = 「事件流最后一条是该类型且 candidateDigest 相同则不重复」——重试被人为干预（新候选等）后自然重新可记。
2. 泊车抑制范围 = blocked 条目且存在**晚于 since** 的任意 `delivery.parked`（不匹配 kind——派生 blocked 的 kind 本来就不是人泊的那个）。
3. AgentsConfig 的 `workspaceId` 设为可选 prop；宿主（DesktopShell/MobileShell）传激活工作区 id；无 workspaceId 时交付感知面板整体隐藏（现行为），徽标不显示。

---

### Task 1: 引擎三项（checks 失败表面化 + 泊车抑制 + 日期校验）

**Files:**
- Modify: `lib/work-items/delivery-runner/checks-step.ts`（`runChecksStep` 的 startChecksRun 失败路径（claim 写入前）：追加 `delivery.checks_start_failed`（actor system，data {reason, candidateDigest?}）；去重 = 项的 events 最后一条为该类型且 data.candidateDigest 相同则跳过（`readWorkItem` 的 events 已在手）；attention 无需新机制——锚点在 T1 的 attention.ts 侧）
- Modify: `lib/work-items/attention.ts`（`blockedSinceDetail` 候选增 `delivery.checks_start_failed`（detail = reason）；`attend` 的 blocked 条目：events 存在晚于 since 的任意 `delivery.parked` → 跳过 nudge/park（`hasAnyParkedSince(events, since)` 新helper）；对应测试）
- Modify: `lib/work-items/attention.test.mjs`、`lib/work-items/delivery-runner/checks-step.test.mjs`
- Modify: `lib/work-items/delivery-types.ts`（`parseClarification`：`askedAt`/`answeredAt`（在场的）须 `Number.isFinite(Date.parse(...))`，否则 Validation `clarifications[i].askedAt is not a valid ISO date`；answeredAt 同）
- Modify: `lib/work-items/delivery-types.test.mjs`

- [ ] **Step 1: 失败测试**——checks-step：startChecksRun 注入失败 → 事件 `checks_start_failed`（首条）、二连失败不重复、换 candidateDigest 后可再记、修复后无残留；attention：checks_start_failed 锚点出现（blocked、detail=reason）、parked-after-since 抑制 nudge/park、无 parked 时照旧；types：askedAt 坏串 → Validation、合法 ISO 通过、answeredAt 同。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: surface checks start failures, suppress derived-blocked parking and validate clarification dates`

---

### Task 2: UI 接线与阈值保持（用户 WIP 文件，编辑不提交）+ init/managed 小项

**Files:**
- Modify: `components/shell/DesktopShell.tsx`、`components/shell/MobileShell.tsx`（向 AgentsConfig 传 `workspaceId` = 激活工作区 id——宿主现有状态里有；用户 WIP，编辑不提交）
- Modify: `components/AgentsConfig.tsx`（用户 WIP：可选 `workspaceId` prop 已存在——确认门控逻辑：有 id 时拉 roles 并显示徽标/锁定不变式/组合预览）
- Modify: `components/WorkspaceManager.tsx`（用户 WIP：PUT body 增 `attention: deliveryConfig.attention`（未触碰原样回传）；init 向导从输入解析期前置校验 from 布局属服务端——见 delivery-init）
- Modify: `lib/workspaces/delivery-init.ts`（`parseInitInput` 阶段：`from` 给定时 `statSync(from/.pi)` 前置校验（非目录 → Validation），替代 T1 时代的晚校验；对应测试）
- Modify: `lib/workspaces/delivery-managed.ts`（catch 收窄：ENOENT 静默、其余 `console.error`）
- Modify: `lib/workspaces/delivery-init.test.mjs`、注释清理：`components/work-items/WorkItemActionbar.tsx`（answer-clarification 过时注释）、`components/work-items/AttentionBar.tsx`（头部「四类」——已修则跳过）、`lib/work-items/delivery-runner/role-session.ts:2`（历史头注释提及 verifier → 改现役+legacy 表述）

- [ ] **Step 1: 失败测试/清单**——delivery-init：from 布局坏 → 400 且零副作用（无 config/播种写入）；managed：EACCES 模拟（chmod 000 或注入 reader）→ 日志非静默；UI 按手测清单（徽标出现/面板三段/PUT 回传 attention）。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: agents delivery-awareness wiring, attention threshold round-trip and input pre-validation`（仅提交 HEAD-clean 可提交文件：delivery-init.ts、delivery-managed.ts 及测试）

---

### Task 3: 文档 + 回归

- Modify: `knowledge/reference/work-items.md`（checks_start_failed 事件、泊车抑制、日期校验——编辑不提交）、`knowledge/reference/file-map.md`
- Modify: `AGENTS.md`（工作项/交付流两条小补充——编辑不提交）
- 守卫：全量 `npm test`、tsc、lint；HEAD worktree 全绿复核。

- [ ] Step 1 文档 → Step 2 回归（工作树 + HEAD 双验证）→ Step 3 Commit（可提交文件则 pathspec，否则无提交报告）

---

## 冒烟（controller）

1. 真 smoke 工作区：候选指向不存在的 sha → jiti 驱动一拍 → `checks_start_failed` 事件 + attention blocked detail；二拍不重复；换候选修复后消失。
2. REQ 泊车后派生 blocked → attend 不再二次泊车。
3. clarification 坏日期 → 400。

## 自审记录

全部项来自第 1–6 步终审的建议/记档，无新设计面；范围小、无新接口。cargoware 演练不在内（人工）。
