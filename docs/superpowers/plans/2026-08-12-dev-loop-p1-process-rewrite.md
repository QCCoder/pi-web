# dev-loop P1（流程层重写）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the dev-loop template (`LOOP.md` + 4 agents) to enforce scope discipline, front-loaded correctness, a lean pipeline, and gate收敛; then land it in the cxin workspace and clean up REQ-0012 saga residue.

**Architecture:** Pure process-layer change — only files under `lib/loop/dev-loop/template/` + `lib/loop/dev-loop/install.test.mjs`. **No engine (`lib/loop/`) changes.** Each new rule becomes a content assertion in `install.test.mjs` (TDD: assert → fail → edit prompt → pass). Then deploy to `~/.pi/workspaces/workspace-c/` (filesystem, no git) + sync cxin-specific `dev-loop-modules.md` + reopen orphan REQ-0011.

**Tech Stack:** TypeScript via jiti (`node:test`), Markdown prompt files (`LOOP.md` + `agents/*.md`).

## Global Constraints

- **Zero changes under `lib/loop/` engine.** Only `lib/loop/dev-loop/template/*` and `lib/loop/dev-loop/install.test.mjs`.
- **Preserve every existing `install.test.mjs` anchor** (don't break them): LOOP.md must still match `/永不自动合并主干/`, `/repositories\/<alias>/`, `/loop\.started/`, `/conversations/`, `/runId/` and must NOT match `/三重判定/`, `/kb_search/`, `/BUG-0008/`, `/cargoware/`, `/cargo-knowledge/`, `/repositories\/code\//`, `/repositories\/knowledge\//`; planner must match `/name: planner/`, `/三重判定/`, `/kb_search/`; developer `/name: developer/`, `/永不提交到主干/`; tester `/name: tester/`, `/verdict: green/`; designer `/name: designer/`.
- **Doc style (user mandate):** tight, action-first. Hard rules boxed/numbered. No philosophy prose. One sentence over two.
- **cxin workspace files** (`~/.pi/workspaces/workspace-c/`) are NOT in pi-web git — deploy by file copy, never `git add` them.
- **Branch:** `develop` (already on it). Each task commits its own slice.
- **Run tests with:** `node --test lib/loop/dev-loop/install.test.mjs` (or `npm test` for the whole suite). Type-check with `node_modules/.bin/tsc --noEmit`.

---

## File Structure

pi-web repo (committed):
- `lib/loop/dev-loop/template/LOOP.md` — **rewrite** (scope invariants + new gate flow + tight style). Responsibility: orchestrator contract / round sequence.
- `lib/loop/dev-loop/template/agents/planner.md` — **modify** (confidence note, batch questions, no self-created work items).
- `lib/loop/dev-loop/template/agents/designer.md` — **rewrite** (full-chain trace + counter-evidence = the correctness gate).
- `lib/loop/dev-loop/template/agents/developer.md` — **modify** (trust upstream, worktree isolation, incremental build, reproduce-first rework).
- `lib/loop/dev-loop/template/agents/tester.md` — **modify** (boundary coverage, owns the single full gate).
- `lib/loop/dev-loop/install.test.mjs` — **extend** (new content assertions per task).

cxin workspace (NOT committed — filesystem only):
- `~/.pi/workspaces/workspace-c/loops/dev-loop/{LOOP.md,agents/*.md}` — refresh from template.
- `~/.pi/workspaces/workspace-c/knowledge/cargo-knowledge/standards/dev-loop-modules.md` — sync to P1 rules.
- `~/.pi/workspaces/workspace-c/AGENTS.md` — verify no conflict with §1 (read-only check).
- `~/.pi/workspaces/workspace-c/requirements/REQ-0011-*/item.yaml` (+ `events.jsonl`) — reopen to intake.

---

## Task 1: Rewrite LOOP.md (scope discipline + gate flow + tight style)

**Files:**
- Modify: `lib/loop/dev-loop/template/LOOP.md` (full rewrite)
- Test: `lib/loop/dev-loop/install.test.mjs` (add LOOP.md assertions after line 52, the `assert.doesNotMatch(loop, /cargo-knowledge/);` line)

**Interfaces:**
- Produces: the orchestrator contract that Tasks 2–5's agents are dispatched by. New round flow = orient → planner → **designer(trace)** → gate-decide → developer → tester → merge+final-verify. Designer now returns `{scope, confidence, DESIGN.md?}` which the gate-decide step consumes.

- [ ] **Step 1: Add failing LOOP.md assertions**

In `install.test.mjs`, immediately after the line `assert.doesNotMatch(loop, /cargo-knowledge/);` (inside the main test), insert:

```js
    // P1 §1 scope discipline invariants.
    assert.match(loop, /单工作项·单分支/);
    assert.match(loop, /禁止创建任何新工作项/);
    assert.match(loop, /全范围做完才验收/);
    assert.match(loop, /禁止在部分范围上 gate/);
    assert.match(loop, /纯技术工作/); // 超限判定：纯技术一律做完
    // P1 §4 gate rules.
    assert.match(loop, /一次性问全/);
    assert.match(loop, /gate 消息 terse/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: FAIL — the main test fails on the new `/单工作项·单分支/` etc. (current LOOP.md lacks them).

- [ ] **Step 3: Replace LOOP.md with the new tight content**

Overwrite `lib/loop/dev-loop/template/LOOP.md` entirely with:

```markdown
# dev Loop · orchestrator

你只调度，不判断。按下面的 Round 序列跑；判断全派 subagent（planner/designer/developer/tester）。
项目事实（分支规则、构建/checker 命令、敏感模块、模块→仓库映射）查工作区 AGENTS.md / 知识库，本文件不写。
仓库路径：扁平 `repositories/<alias>`，以磁盘实际为准。

## L0 不变式（硬，不可违）
1. **永不自动合并主干**（master/main 受保护，人手合）。只合并到 AGENTS.md 约定的集成分支。
2. 只动工作项 `repositories` 声明的仓库；未声明先推断写回。
3. 改动只在 feature/hotfix 分支（按 AGENTS.md / `git.branch_rules`）。
4. **单工作项·单分支**：本 run 只动 planner 选中的**那一个**工作项、**唯一一条** feature/hotfix 分支。**禁止创建任何新工作项**（含 follow-up、子需求）；**禁止开第二条分支**。
5. **全范围做完才验收**：工作项声明的**所有**改动点（N 个菜单/落点）必须在**同一次 run 内全部完成**后才发 `LOOP_GATE`。整 run 只允许两个 gate：① `plan-approval`（写代码前，非全绿项才发）② `final-verify`（全做完后）。**中间不插 gate；禁止在部分范围上 gate。**
6. **范围超限才停**：需人介入（需求方澄清/拆需求/跨团队/依赖外部）→ 立即停、泊车、交人。**纯技术工作（跨仓、给别的菜单加字段）一律做完，不算超限。** 绝不自建、不自拆、不部分交付。
7. 每轮可观测：写工作项 phase/event + RUNS.jsonl（引擎）+ LEARN.jsonl（你）。
8. 永不 force-push、永不删远端分支。

任一 L0 不变式被触及时立即停下报告。

## Round 序列（纯调度）

**0 orient + 边界** — 读 STATE.md、RUNS.jsonl 近几轮、LEARN.jsonl。判定该不该干活：cron/手动新 run 只处理 `phase==intake` 且无 `loop.parked` 的工作项；非 intake 项归首次选中它的 run，**不碰**。无新工作 → `LOOP_VERDICT: idle`，**不写 LEARN**，结束。

**1 选品（planner）** — 把 Round 0 筛出的新 intake 候选（前 3）派 `subagent({agent:"planner", task:"<短名单 + 工作区根 + 工作项目录约定>", cwd:<工作区根>})`。处理返回：`parked[]` 去重 record（首次或 reason 变才记 `loop.parked`）；`selectedKey` → `workspace_update_work_item(selectedKey,{conversations:[...现有,"<本 sessionId>"]})`、`record_milestone(selectedKey,{type:"loop.started",data:{runId,repo,module}})`、`repositories` 空则推断写回、phase→`plan_approval`。`decision=park-all` → 终态（LEARN `outcome=blocked`，`LOOP_VERDICT: no candidate`）。

**2 全链路追踪/设计（designer）** — 派 `subagent({agent:"designer", task:"读 PLAN.md[+README]，全链路追 UI→SQL + 反证搜索，确认真 scope（前端 only / 含后端 / 几个仓）与真信心；needsDesign 则写 DESIGN.md", cwd:<仓库路径>})`。全链路追踪 + 反证是**硬要求**（见 designer.md）——scope 与信心都以此为准，不许没追全就下结论。

**3 gate 判定**（用 designer trace 后的结果）：
- **全绿**（`high 信心[trace 后] ∧ 非敏感 ∧ 校准允许`）→ 跳过 plan-approval，直接进实现。
- **非全绿** → 发 `plan-approval`（普通项审 PLAN；敏感项审 PLAN+DESIGN），**一次性问全**所有待澄清项，输出 `LOOP_GATE:` 停 `waiting_for_gate`；人答经 resumeRound 到达，进实现。
- plan-approval 后、final-verify 前**不再插任何 gate**。

**4 实现（developer）** — 派 `subagent({agent:"developer", task:"读 PLAN.md[+DESIGN.md]，TDD 交付集成分支-ready feature 分支，写 IMPLEMENTATION.md", cwd:<仓库路径>})`。phase→`implementation`。**全声明的改动点（所有菜单/落点）必须在这一步全做完**——不许做一部分就交。developer 收到 rework/打回：**先写复现失败测试，再改**（见 developer.md）。

**5 验证（tester）** — 派 `subagent({agent:"tester", task:"读 PLAN+IMPLEMENTATION，跑 gate（覆盖接线边界，不只纯函数），写 VERDICT.md", cwd:<同上>})`。读 `VERDICT.verdict`：`no-checker`→终态 `blocked`；`red`→`git reset` 回滚、终态 `blocked`/返工。

**6 合并集成分支 + final-verify（green）** — 读 AGENTS.md 拿集成分支名（无约定→泊车交人）；`git push origin <branch>`；`fetch` + `merge --no-ff <branch>` 到集成分支（冲突最多重对齐 2 次，仍冲突→终态 `blocked` 交人，集成分支不动）。合并成功 → phase→`verification`，输出 terse `LOOP_GATE: 去 <菜单> 验 <操作>，期望 <结果>`，停 `waiting_for_gate`。
- 人答"通过/已验证"→ phase→`complete`+`done`，`git worktree remove` 清理。
- 人答"打回"→ `blocked`/`implementation`，集成分支清理交人。

**终态 / learn** — 到终态时（final-verify 解析后、或早期泊车；**Round 0 idle 除外——不写 LEARN**）：append 一条 JSON 到 `loops/dev-loop/LEARN.jsonl`（字段从 PLAN/VERDICT 抄，**不自己重判**）：`{runId, workItemKey, module, repo, predictedConf, riskTier, outcome(merged|rejected|blocked), tests(green|red|none), ts}`。输出 `LOOP_VERDICT: <结论>`。

## gate 规则
- **一次性问全**：plan-approval 必须把所有待澄清项一次列尽；答后冒出真·新未知最多再合并问一次，**不反复 re-open**。
- **gate 消息 terse**：plan-approval = 待决项 + 选项（A/B）；final-verify = 去哪验 + 怎么操作 + 期望结果。**不写长总结**。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: PASS — all assertions (existing anchors + new §1/§4) green.

- [ ] **Step 5: Commit**

```bash
git add lib/loop/dev-loop/template/LOOP.md lib/loop/dev-loop/install.test.mjs
git commit -m "dev-loop(P1): rewrite LOOP.md — scope invariants + 2-gate flow + tight style"
```

---

## Task 2: planner.md — confidence note, batch questions, no self-created work items

**Files:**
- Modify: `lib/loop/dev-loop/template/agents/planner.md`
- Test: `lib/loop/dev-loop/install.test.mjs` (add planner assertions after line 58, the `assert.match(planner, /kb_search/);` line)

**Interfaces:**
- Consumes: orchestrator's candidate short-list (Task 1).
- Produces: `PLAN.md` with a single batched「待澄清项」section; `decision`, `selectedKey`, `parked[]`.

- [ ] **Step 1: Add failing planner assertions**

After `assert.match(planner, /kb_search/);` insert:

```js
    // P1: batch all clarifications; never self-create work items.
    assert.match(planner, /一次性列全/);
    assert.match(planner, /永不创建新工作项/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: FAIL on `/一次性列全/`.

- [ ] **Step 3: Edit planner.md (three targeted changes)**

In `lib/loop/dev-loop/template/agents/planner.md`:

(a) In step 4, the `① 信心` bullet — append after "用 STATE 校准表修正（某模块历史 high 准确率低 → 把 high 当 med）。":

```
   信心是 **preliminary**（基于复杂度/不确定性）；最终 `high` 须由 designer 全链路追踪 + 反证确认（见 designer.md）。
```

(b) Under `## 输出`, after the "正文：范围·方案概述·验收标准·测试命令·敏感点" bullet, add:

```
  - **待澄清项**：把**所有**未决问题在本 PLAN **一次性列全**（语义/落点/范围），不分批、不留到 gate 后再问。
```

(c) Under `## 硬约束`, add a new bullet:

```
- **永不创建新工作项**（含 follow-up / 子需求）；范围若超限，交回 orchestrator 泊车，不自建、不自拆。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/loop/dev-loop/template/agents/planner.md lib/loop/dev-loop/install.test.mjs
git commit -m "dev-loop(P1): planner — batch clarifications, no self-created work items, confidence note"
```

---

## Task 3: designer.md — full-chain trace + counter-evidence (the correctness gate)

**Files:**
- Modify (full rewrite): `lib/loop/dev-loop/template/agents/designer.md`
- Test: `lib/loop/dev-loop/install.test.mjs` (add designer assertions after line 60, the `assert.match(designer, /name: designer/);` line)

**Interfaces:**
- Consumes: `PLAN.md` (from planner).
- Produces: `{scope, confidence, DESIGN.md?}` (full-chain + counter-evidence verified) — consumed by orchestrator's gate-decide (Task 1 Round 3). `confidence=high` only when full-chain traced ∧ counter-evidence searched ∧ reproducible.

- [ ] **Step 1: Add failing designer assertions**

After `assert.match(designer, /name: designer/);` insert:

```js
    // P1 §2.1: full-chain trace + counter-evidence before any scope conclusion.
    assert.match(designer, /全链路追踪/);
    assert.match(designer, /反证/);
    assert.match(designer, /全链路清单/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: FAIL on `/全链路追踪/`.

- [ ] **Step 3: Replace designer.md with the new content**

Overwrite `lib/loop/dev-loop/template/agents/designer.md` entirely with:

```markdown
---
name: designer
description: dev Loop 的设计官。读 PLAN.md，全链路追踪 UI→SQL + 反证搜索，确认真 scope 与真信心；needsDesign 时写 DESIGN.md。只设计，不改代码。
---

# designer（全链路追踪 + 设计）

orchestrator 在选品后派你。你读 `PLAN.md`（及工作项 `README.md`），**先全链路追踪 + 反证**，确认真 scope 与真信心；`needsDesign==true` 时再写 `DESIGN.md`。

## 硬要求：全链路追踪 + 反证（下 scope 结论前必做）
1. **逐跳追全链路**：UI 控件 → 前端查询组装 → 请求 → 后端解析/组装器 → SQL。每一跳列出碰该字段的函数，核实 `file:line`。
2. **反证搜索**：下"X 层不用动"结论前，主动 grep"**通用路径之外，有没有专用拦截/组装器也在碰这个字段**"（例如某 ServiceImpl 在通用 util 之外单独拼条件）。反证范围框死：本字段链路 + grep 该字段/flag 的所有调用点，**不扩成全仓漫游**。
3. 任一跳核实不到 → 信心降为 `med`/`low`，在返回里标"未核实跳"，**不许高信心下结论**。

## scope 结论（基于追踪，不许凭印象）
明确：前端 only / 含后端 / 几个仓。给 orchestrator 的真信心：`high` 仅当"全链路追完 ∧ 反证搜索做完 ∧ 能写出复现路径"三条满足；否则 `med`/`low`。

## needsDesign==true 时，写 DESIGN.md
在工作项目录：frontmatter `workItem`、`repo`；正文含 **「全链路清单」（每跳 file:line）** + **「反证结果」** + 架构/接口/数据模型/关键决策/风险表。

## 硬约束
- 只设计、只产出文档，**不改代码、不碰 git**。
- 永不碰主干/受保护分支；集成分支合并是 orchestrator 的事。
- 返回文本：`scope=<前端only|含后端|多仓>`、`confidence=<high|med|low>`、`DESIGN.md 在 <path>（若写）`、`未核实跳=[...]`。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/loop/dev-loop/template/agents/designer.md lib/loop/dev-loop/install.test.mjs
git commit -m "dev-loop(P1): designer — full-chain trace + counter-evidence correctness gate"
```

---

## Task 4: developer.md — trust upstream, worktree isolation, incremental build, reproduce-first rework

**Files:**
- Modify: `lib/loop/dev-loop/template/agents/developer.md`
- Test: `lib/loop/dev-loop/install.test.mjs` (add developer assertions after line 63, the `assert.match(developer, /永不提交到主干/);` line)

**Interfaces:**
- Consumes: `PLAN.md` + `DESIGN.md` (scope/落点/接口 from designer — trust, don't re-derive).
- Produces: integration-ready feature branch + `IMPLEMENTATION.md`.

- [ ] **Step 1: Add failing developer assertions**

After `assert.match(developer, /永不提交到主干/);` insert:

```js
    // P1 §3.1/§3.2/§3.3/§2.2.
    assert.match(developer, /非自己产生的改动/);   // worktree isolation: dirty → report
    assert.match(developer, /复现.*失败测试/);      // rework reproduce-first
    assert.match(developer, /受影响的测试/);        // incremental build
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: FAIL on `/非自己产生的改动/`.

- [ ] **Step 3: Edit developer.md (four targeted changes)**

In `lib/loop/dev-loop/template/agents/developer.md`:

(a) `## 输入` section — after the `cwd = 仓库路径` line, add:

```
- **信任上游产物**：直接用 PLAN/DESIGN 的 scope/落点/接口结论，**不重做 designer 的源码定位**；要推翻上游须显式标"上游错了，理由…"。
```

(b) In the `## 交付物` step 1 (worktree add command) — change the worktree path to be run-unique and add a dirty-check. Replace step 1 with:

```
1. `git fetch origin`；起**本 run 唯一 worktree**（路径带 runId，如 `repositories/<repo>/worktrees/<runId>-<slug>`，不吃别人的）：`git worktree add -b <branch> <worktree-path> <主干>`（branch 取自 PLAN；主干按 AGENTS.md）。
```

(c) In step 2 (TDD) — append:

```
   开发期只跑**受影响的测试文件/模块**（targeted）；全量 gate 是 tester 的活，你不跑全套。
```

(d) Replace the `## 收到"重对齐"请求` section with a broader rework section:

```
## 收到 rework / 打回请求（orchestrator 因 gate7 打回、merge 冲突重派你）
1. **先写复现失败测试**：对准**上报症状**（如"等于{清关,派车} 返回 B 不是 A"），写一个失败测试、看它红，**再改**、看它绿。禁止读码猜改。
2. `fetch` 最新集成分支 → 重新对齐解冲突 → tester 重验 → 更新 `IMPLEMENTATION.md`。
3. **交付前 `git status` 核**：工作区有**非自己产生的改动 → 立即停下报告，不盲目 reconcile**（脏工作区 = 交人，不 = 自己擦）。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/loop/dev-loop/template/agents/developer.md lib/loop/dev-loop/install.test.mjs
git commit -m "dev-loop(P1): developer — trust upstream, worktree isolation, incremental build, reproduce-first rework"
```

---

## Task 5: tester.md — boundary coverage, owns the single full gate

**Files:**
- Modify: `lib/loop/dev-loop/template/agents/tester.md`
- Test: `lib/loop/dev-loop/install.test.mjs` (add tester assertions after line 66, the `assert.match(tester, /verdict: green/);` line)

**Interfaces:**
- Consumes: `PLAN.md` + `IMPLEMENTATION.md`.
- Produces: `VERDICT.md` (`green|red|no-checker`).

- [ ] **Step 1: Add failing tester assertions**

After `assert.match(tester, /verdict: green/);` insert:

```js
    // P1 §2.3 boundary coverage; §3.3 tester owns the full gate.
    assert.match(tester, /症状所在边界/);
    assert.match(tester, /接线/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: FAIL on `/症状所在边界/`.

- [ ] **Step 3: Edit tester.md (two targeted changes)**

In `lib/loop/dev-loop/template/agents/tester.md`:

(a) `## 步骤` step 2 — append after "先 build（若有），再 test。":

```
   覆盖**症状所在边界**：查询类 = UI 输入→组装出的查询 + 查询→SQL 条件两段，不只测孤立纯函数（maker 漏的 bug 多在接线层）。这是全 run 唯一一次**全量 gate**。
```

(b) `## 裁定` — after the `green` bullet, add a coverage note:

```
- 若 IMPLEMENTATION 涉及查询/组装类改动，green 前必须含一段接线层测试（UI 多选→组装 / 查询→SQL），否则降为 red 并标"接线覆盖缺失"。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/loop/dev-loop/install.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/loop/dev-loop/template/agents/tester.md lib/loop/dev-loop/install.test.mjs
git commit -m "dev-loop(P1): tester — boundary coverage, owns the single full gate"
```

---

## Task 6: Full verification (type-check + whole suite + lint)

**Files:** none modified — verification only.

- [ ] **Step 1: Type-check**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green (install.test.mjs + every other suite).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors introduced by P1 (template `.md` files should not affect lint; if any pre-existing baseline errors, they must be unchanged).

- [ ] **Step 4: If anything fails, fix and re-run; only proceed when all three pass.**

(No commit — verification only. Fixes, if any, get their own commit.)

---

## Task 7: Deploy to cxin workspace (filesystem, NOT in pi-web git)

**Files (all under `~/.pi/workspaces/workspace-c/`, no git):**
- Refresh: `loops/dev-loop/LOOP.md`, `loops/dev-loop/agents/{planner,designer,developer,tester}.md`
- Sync: `knowledge/cargo-knowledge/standards/dev-loop-modules.md`
- Verify (read-only): `AGENTS.md`
- Reopen: `requirements/REQ-0011-*/item.yaml` + `events.jsonl`

**Global constraint reminder:** never `git add` any path under `~/.pi/workspaces/`. These are deployed by file copy.

- [ ] **Step 1: Backup the current cxin dev-loop files**

```bash
W=~/.pi/workspaces/workspace-c
cp "$W/loops/dev-loop/LOOP.md" "$W/loops/dev-loop/LOOP.md.preP1.bak"
cp "$W/loops/dev-loop/agents/planner.md" "$W/loops/dev-loop/agents/planner.md.preP1.bak"
cp "$W/loops/dev-loop/agents/designer.md" "$W/loops/dev-loop/agents/designer.md.preP1.bak"
cp "$W/loops/dev-loop/agents/developer.md" "$W/loops/dev-loop/agents/developer.md.preP1.bak"
cp "$W/loops/dev-loop/agents/tester.md" "$W/loops/dev-loop/agents/tester.md.preP1.bak"
cp "$W/knowledge/cargo-knowledge/standards/dev-loop-modules.md" "$W/knowledge/cargo-knowledge/standards/dev-loop-modules.md.preP1.bak"
```

- [ ] **Step 2: Refresh dev-loop instance from the P1 template**

```bash
W=~/.pi/workspaces/workspace-c
T=lib/loop/dev-loop/template
cp "$T/LOOP.md"            "$W/loops/dev-loop/LOOP.md"
cp "$T/agents/planner.md"  "$W/loops/dev-loop/agents/planner.md"
cp "$T/agents/designer.md" "$W/loops/dev-loop/agents/designer.md"
cp "$T/agents/developer.md" "$W/loops/dev-loop/agents/developer.md"
cp "$T/agents/tester.md"   "$W/loops/dev-loop/agents/tester.md"
```

- [ ] **Step 3: Verify the refresh (diff must be empty for each)**

```bash
W=~/.pi/workspaces/workspace-c; T=lib/loop/dev-loop/template
for f in LOOP.md agents/planner.md agents/designer.md agents/developer.md agents/tester.md; do
  diff -q "$T/$f" "$W/loops/dev-loop/$f" && echo "OK $f" || echo "MISMATCH $f"
done
```
Expected: `OK` for all five. (`RUNS.jsonl` / `LEARN.jsonl` untouched — confirm they still exist.)

- [ ] **Step 4: Sync cxin-specific `dev-loop-modules.md` (3 string edits)**

File: `~/.pi/workspaces/workspace-c/knowledge/cargo-knowledge/standards/dev-loop-modules.md`

(a) Line 25 — replace:
```
> 全绿（high 信心 ∧ 非敏感 ∧ 校准允许）才自动做到开 PR；其余停 gate1。
```
with:
```
> 全绿（high 信心 [= 全链路追完 ∧ 反证搜索 ∧ 可复现] ∧ 非敏感 ∧ 校准允许）才自动推进（直跑 final-verify，不发 plan gate）；其余发 plan gate。
```

(b) Line 61 — replace the heading:
```
## checker 命令（Phase-0 核实，见 `lib/loop/checkers.ts`）
```
with:
```
## checker 命令（见工作区 AGENTS.md 的仓库 gate 段）
```
(`lib/loop/checkers.ts` was deleted as dead code in the redesign — this reference is stale.)

(c) Line 17 table header — replace `| 类别 | 含义 | 触发 gate1（非自动做） |` with `| 类别 | 含义 | 触发 plan gate（非自动做） |` (terminology align with P1).

- [ ] **Step 5: Verify dev-loop-modules.md edits applied**

```bash
M=~/.pi/workspaces/workspace-c/knowledge/cargo-knowledge/standards/dev-loop-modules.md
grep -q "全链路追完 ∧ 反证搜索 ∧ 可复现" "$M" && echo "OK L25" || echo "MISS L25"
grep -q "lib/loop/checkers.ts" "$M" && echo "STALE ref remains" || echo "OK no stale ref"
grep -q "触发 plan gate" "$M" && echo "OK terminology" || echo "MISS terminology"
```
Expected: `OK L25`, `OK no stale ref`, `OK terminology`.

- [ ] **Step 6: Verify AGENTS.md does not conflict with §1 (read-only)**

```bash
A=~/.pi/workspaces/workspace-c/AGENTS.md
grep -nE "自建工作项|自建需求|follow-up|允许多?个?分支" "$A" || echo "OK no conflict"
```
Expected: `OK no conflict` (no wording allowing the loop to self-create work items / branches). If a hit is found, flag to the user — do not edit AGENTS.md without confirmation.

- [ ] **Step 7: Reopen orphan REQ-0011 to intake**

First read its current state:

```bash
W=~/.pi/workspaces/workspace-c
ls -d "$W/requirements/"REQ-0011* && cat "$W"/requirements/REQ-0011-*/item.yaml
```

Then edit that `item.yaml`: set `phase: intake` and `status: open` (from `plan_approval` / `blocked`), bump `revision` by 1, update `updated_at` to `2026-08-12T12:00:00.000Z`. Append one line to its `events.jsonl`:

```bash
W=~/.pi/workspaces/workspace-c; D=$(ls -d "$W/requirements/"REQ-0011* | head -1)
cat >> "$D/events.jsonl" <<'EOF'
{"id":"01KZT7P1REOPEN00000000000001","at":"2026-08-12T12:00:00.000Z","type":"work_item.updated","actor":"user","data":{"revision":<NEWREV>,"changes":{"status":{"from":"blocked","to":"open"},"phase":{"from":"plan_approval","to":"intake"}},"summary":"P1 部署前清理：原 run 已 aborted，重开 intake 让 dev-loop P1 干净重评"}}
EOF
```
(Replace `<NEWREV>` with the bumped revision number. Use a fresh ULID-style id.)

- [ ] **Step 8: Verify REQ-0011 reopened**

```bash
W=~/.pi/workspaces/workspace-c
grep -q "phase: intake" "$W"/requirements/REQ-0011-*/item.yaml && echo "OK reopened" || echo "FAIL"
```
Expected: `OK reopened`.

- [ ] **Step 9: Manual smoke note**

Record (in the commit message of the next pi-web task, or a scratch note) that cxin is now on P1 and REQ-0011 is back in the intake pool for a clean P1 re-evaluation. The next dev-loop run on workspace-c will exercise the new LOOP.md.

(No `git commit` here — none of these paths are in pi-web.)

---

## Self-Review (completed)

**Spec coverage:**
- §1 范围纪律（不变式 单工作项·单分支 / 全范围做完才验收 / 超限判定）→ Task 1 (LOOP.md) ✓
- §2.1 全链路+反证 → Task 3 (designer) ✓
- §2.2 复现优先 → Task 4 (developer) ✓
- §2.3 边界覆盖 → Task 5 (tester) ✓
- §2.4 信心定义 → Task 2 (planner note) + Task 3 (designer high-bar) + Task 1 (gate-decide uses trace-confidence) ✓
- §3.1 信任上游 → Task 4 (developer) ✓
- §3.2 worktree 隔离 → Task 4 (developer) ✓
- §3.3 增量构建 → Task 4 (developer) + Task 5 (tester owns full gate) ✓
- §4 gate 收敛（2 gates / 一次性问全 / terse / 全绿免 gate）→ Task 1 (LOOP.md) ✓
- 文档风格 → applied across all rewrites ✓
- §5 cxin 落地 A/B/C/D → Task 7 ✓
- §7 风险 mitigations encoded (反证范围框死 in Task 3; 超限判定 in Task 1) ✓

**Placeholder scan:** none. Every step has concrete file paths, exact text, exact commands, exact test assertions.

**Type/name consistency:** `designer` return shape `{scope, confidence, DESIGN.md?}` produced in Task 3 is consumed by Task 1's Round 3 gate-decide — names match. LEARN schema field `runId` preserved (Task 1) matches existing test anchor. Assertion strings match the prose written in the same task.

**Note on RUNS.jsonl discrepancy** (spec §5-D1): left for P2 (engine bug: round-timeout marks `failed` but session continues). Not cleaned here — RUNS.jsonl is append-only evidence.
