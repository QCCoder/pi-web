# 终局第五步：loop 退役编排（pi-web 侧）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 loop 收窄为「定时任务调度器」：kit 协议与模板退役宪法三件 / ledger / STATE.md 编排语言（loop = cron + max_minutes + 入口，跑完即走、无状态幂等）；digest 成为 attention 队列的定时渲染物（业务语言 markdown，巡逻 loop 取用）；`item.loop` 收窄为「巡逻参考」；cargoware 切换以 **runbook 文档**交付（不改用户工作区文件——改挂剧本与停编排由人按 runbook 执行）。

**Architecture:** `packages/pi-loop/init.ts` 停播宪法两件；kit 模板重写为巡逻形态；`LoopsConfig.tsx` 宪法面板与 loops docs 路由的宪法服务移除；attention 路由增 `?format=digest` 渲染；kit 增 `patrol` 模板（digest 巡逻入口）；AGENTS.md Loop 硬规则改写；runbook 落 `docs/superpowers/specs/`。**dispatcher/心跳/轮锁协议零改动**（那是调度器本体，终局保留）。

**Tech Stack:** node:test + jiti、Next.js App Router。

**Spec:** `docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md` §8（digest=定时渲染）/ §9（loop 终局）/ §11 第 5 步。用户站立授权（2026-10-26）；cargoware 侧人工部分见 runbook。

## Global Constraints

- 不修改 `@earendil-works/pi-*` npm 包（`packages/pi-loop` 是本仓 workspace 成员，**可改**）；不碰用户工作区（cargoware / smoke-* 的 `.pi/loops/`、LOOP.md、STATE.md）。
- `.pi/loop/pause-all`、`.lastrun`、`.round.lock`、`PAUSED` 保留（宿主文件）；`.pi/loop/` 目录保留（仅不再放宪法两件）。
- 工具面恰六件不受影响；delivery 引擎零改动（digest 只读 attention 投影）。
- pathspec 提交（索引含用户预暂存 knowledge/ 文件）；`knowledge/**` 与 `AGENTS.md` 编辑不提交；**绝不 `next build`**。

### 默认选择（请用户复核）

1. 宪法两件的**存量文件不迁移不删除**（用户磁盘上的 `.pi/loop/constraints.md` 等原样保留——它们已无消费者，删除由人决定）；退役的是「协议仍生成/展示/引用它们」。
2. digest 语言 = 业务语言、零内部术语（KEY、标题、去哪验/怎么操作、天数）；内部细节（attempt、digest 值）不出现。
3. 巡逻模板命名 `patrol`（kit 模板），入口指令 = 取 digest → 按用户的投递渠道输出（默认打印到轮会话，由人/渠道接管）。

---

### Task 1: kit 协议退役（init 停播宪法 + 模板重写 + LoopsConfig/docs 宪法面移除）

**Files:**
- Modify: `packages/pi-loop/init.ts`（删 `.pi/loop/constraints.md`、`budget.md` 的播种块；`.pi/loop/` 目录不再由 kit 创建——pause-all 由宿主管）
- Modify: `packages/pi-loop/paths.ts`（`.pi/loop/` 注释改为「宿主文件（pause-all）」；若 `loopConstraintsPath`/`loopBudgetPath` 导出无消费者则删，有则保留并标 deprecated）
- Modify: `packages/pi-loop/init.test.mjs`、`contract.test.mjs`（断言 init 不再写宪法文件；contract 注入的硬规则不含宪法字样）
- Modify: `kit/README.md`、`kit/templates/basic/**`（root/constraints.md、root/budget.md 删除；loop/LOOP.md、loop/STATE.md、skill/SKILL.md 重写为巡逻形态：读 SKILL 入口 → 干活 → 结束，无 STATE 分区/断路器/宪法；github/loop.yml 同步）+ 新增 `kit/templates/patrol/`（SKILL.md：调 `GET /api/workspaces/<id>/attention?format=digest` 输出 digest；cron 每晚一拍）
- Modify: `components/LoopsConfig.tsx`（git status 核实；HEAD-clean 则提交，否则编辑不提交——宪法文件面板两节删除；`app/api/workspaces/[id]/loops/[name]/docs/route.ts` 宪法服务删除或改空实现——先读该路由确认形态）
- Modify: 相关测试（`loops` 面板/docs 路由测试若存在）

- [ ] **Step 1: 失败测试**——init 不写 `.pi/loop/`；模板目录无 root/ 宪法两件；patrol 模板存在且 SKILL 含 digest 取用指令；LoopsConfig 无宪法字样（源断言）；docs 路由不服务 constraints/budget。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: retire loop constitution and STATE orchestration from kit protocol and templates`

---

### Task 2: digest 渲染 + docs 同步

**Files:**
- Modify: `app/api/workspaces/[id]/attention/route.ts`（`?format=digest` → `text/markdown`：标题「待处理清单 · <日期>」；每条 = `- <KEY> <标题> — <业务话 detail>（已 N 天[，已催办][，已泊车]）`；空队列 → 「今日无待处理」；仍受既有只读路径，capability 无门不变）
- Modify: `lib/work-items/attention.ts`（`renderAttentionDigest(entries, date): string` 纯函数 + 测试——业务语言映射表：question→待您解答、confirm→待确认设计、acceptance→待人工验收、release→可登记发布、blocked→受阻待处理）
- Modify: `attention.test.mjs`
- Modify: `AGENTS.md`（编辑不提交：Loop 硬规则改写——「agent 禁改禁删：`.lastrun`、`.round.lock`、`PAUSED`、LOOP.md 的 level/cron」；删宪法文件句；`item.loop` = 巡逻参考；loop = 定时巡逻（digest 等），交付执行一律走 delivery 引擎）
- Modify: `knowledge/reference/loops.md`（编辑不提交：宪法/ledger/STATE 编排语言退役改写；`item.loop` 收窄；digest 渲染一节）
- Modify: `knowledge/architecture.md`（编辑不提交：loop 一行改巡逻）
- Create: `docs/superpowers/specs/2026-10-26-dev-loop-retirement-runbook.md`（可提交）：cargoware 切换 runbook——① 前置：pi-web 重启至新代码；② `.pi/agents/` 四剧本人工校订后改挂（analyst→designer、implementer→developer、tester→reviewer、learner→巡逻/删除），`delivery.yaml` roles 指向别名或同名；③ checks 按 AGENTS.md 各仓 gate 填入 `verification.checks`（JDK8/-am/node-sass 语义写进命令或脚本）；④ 开 `stages.review`；⑤ REQ-0044 等在制项人工走完或迁移；⑥ 关 dev-loop（删除/停用 `.pi/loops/dev-loop/`），禅道同步改 `patrol` 模板挂 cron；⑦ digest 渠道接管 20:00 播报；⑧ 回滚 = 恢复 `.pi/loops/dev-loop/`（git 保留）。**本计划不执行 runbook**。

- [ ] **Step 1: 失败测试**——digest 渲染：空队列文案、每类业务话、天数/催办/泊车标记、无内部术语（grep attempt/impl_ready/designer 等）；`?format=digest` content-type 与正文（路由源断言或 functional）。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: attention digest rendering, patrol template and loop retirement docs`

---

## 端到端冒烟（controller；无 LLM）

1. `GET …/attention?format=digest`（smoke-s2 有 released/verification 各态项）→ markdown 业务语言、无内部术语。
2. `kit/templates/patrol/` SKILL 含 digest 指令；init 一个临时工作区 loop → 不再生成宪法文件。
3. LoopsConfig/docs 路由 grep：无宪法服务。

## 自审记录

已核事实：`packages/pi-loop/contract.ts` 注入规则已无宪法字样（2026-09-04 退役注释在）——协议本体已干净，退役面 = init 播种 + kit 模板/README + LoopsConfig/docs 面板 + 文档语言；`LoopsConfig.tsx` 与 loops docs 路由的 git WIP 状态待实现者核实（用户 WIP 则编辑不提交）；cargoware 工作区文件一律不碰。
