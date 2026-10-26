# 终局第四步：integrate + acceptance 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 可选的两段收尾：`stages.integrate`（checks 全过后在候选 checkout 里逐仓跑集成命令；失败 = blocked 待人）与 `stages.acceptance`（`record-release` 门前必须有人工 `record-acceptance`）；attention 增 `acceptance` 第五类；顺带修既有 M2 死胡同（`confirm-design` 归一 `status: "open"`，返工后的项可重新被 LLM 领取）。

**Architecture:** `checks-step.ts` 增集成段（同回合锁外、逐仓、cwd=候选 checkout）；config v2 `stages` 增 `integrate` / `acceptance`；`delivery.acceptance` 记录 + `record-acceptance` 人工动作（DELIVERY_ACTIONS 权威表 + planDeliveryTransition case）+ `record-release` 门；attention `AttentionKind` 扩值。**工具面仍恰六件**；池谓词零改动（acceptance 门在 record-release，不在 release-preparer 谓词——材料与验收并行，spec §12）。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent（原样）、node:test + jiti。

**Spec:** `docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md` §5.1 / §5.3（「第四步落地决策」）/ §7 / §8 / §12 / §11 第 4 步。用户站立授权「继续处理，直到全部做完」（2026-10-26）。

## Global Constraints

- 不修改 `@earendil-works/pi-*`；**绝不 `next build`**；验证只跑 `node --test`、`tsc --noEmit`、`npm run lint`。
- **record-acceptance 永不做 LLM 工具**；工具面恰六件；工具参数禁 union/any-of。
- integrate 失败语义与 checks unverified 完全同构：blocked、verification 不写、不进预算、unblock 后整回合重 due；**不加运行态文件**（状态走事件 + item.yaml）。
- `events.jsonl` 只追加；`expectedRevision` + `requestId` 幂等（record-acceptance 走 `applyDeliveryAction` 自动获得）。
- 范围守恒：`role-templates.ts`、`role-preview.ts`、`tools.ts`、`role-session.ts`、`role-grants.ts`、`attention.ts` 的锚点逻辑仅按 §8 扩 `acceptance` 类。
- 每任务以可运行测试结尾并提交；conventional 前缀；只暂存任务文件（用户 WIP 共享文件编辑不提交；**提交一律 pathspec**——索引里有用户预暂存的 knowledge/ 文件）。

### 本计划引入的默认选择（请用户复核）

1. integrate 命令超时 10 分钟/仓（常量 `INTEGRATE_TIMEOUT_MS`，不进配置）；失败 detail 携带 exitCode 与 stderr 末 400 字符。
2. integrate 失败后整个回合重跑（checks + integrate 都重跑）——checks 幂等，代价可接受；不为「只补跑集成」做第二套 due 逻辑。
3. `record-acceptance` 只记「通过 + notes」；不通过走 `rework`（不新增 fail-acceptance 动作）。
4. `confirm-design` 归一 `status: "open"` 是人工动作语义变更（修复 M2 死胡同）：设计未变时重复 confirm-design 幂等（digest 相同 → 不失效、不 bump？——沿用现语义：confirm 写 confirmation 块；digest 相同的重复 confirm 由人自行避免，引擎不做幂等拒绝）。
5. attention `acceptance` 类只在 `stages.acceptance.enabled` 时投影（关闭时 release_ready 项只有 `release` 类）。

---

### Task 1: 配置 + acceptance 记录 + confirm-design 归一

**Files:**
- Modify: `lib/work-items/delivery-runner/config.ts`（`stages` 解析扩 `integrate: { enabled: boolean; command?: string }`（enabled 时 command 必填非空、Validation 文案 `stages.integrate.command is required when integrate is enabled`）与 `acceptance: { enabled: boolean }`；缺省 `{review:{enabled:false}, integrate:{enabled:false,command:undefined}, acceptance:{enabled:false}}`）
- Modify: `lib/work-items/delivery-runner/config.test.mjs`
- Modify: `lib/work-items/delivery-types.ts`（`DeliveryAcceptanceRecord { notes: string; candidateDigest: string; at: string }`；`DeliveryMetadata.acceptance?`；`parseDelivery` 校验；rework 清单确认 acceptance 一并失效——`reworkTransition` 的清下游列表加 `acceptance: undefined`，`record-release` 后基线冻结不变）
- Modify: `lib/work-items/delivery-types.test.mjs`
- Modify: `lib/work-items/delivery.ts`（`case "confirm-design"`：`status: "open"` 显式写入；`case "record-release"`：`stages.acceptance.enabled`（从哪来？plan 是纯函数——由 `applyDeliveryAction` 传入 digests 同款：加可选参数 `options?: { acceptanceRequired?: boolean }`，apply 读 config 后传入；默认 false = 现状）门：`options.acceptanceRequired && (!base.acceptance || base.acceptance.candidateDigest !== candidatesDigest(base.candidates ?? []))` → Validation「先验收（record-acceptance）」）
- Modify: `lib/work-items/delivery.test.mjs`

- [ ] **Step 1: 失败测试**——config：integrate enabled 无 command → Validation；三开关 round-trip；未知 stage 键仍拒。types：acceptance 记录透传 / notes 空 → Validation / candidateDigest 必填；rework 清 acceptance（计划层断言）。delivery：confirm-design 落 `status: "open"`（新钉，替换原样保留的断言）；acceptanceRequired=false 时 record-release 无 acceptance 照常（回归）；=true 且无 acceptance / digest 不符 → Validation；有且 digest 符 → 照常落 release 记录。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: stages integrate/acceptance config, acceptance record and confirm-design status normalization`

---

### Task 2: 集成段（checks-step 扩展）

**Files:**
- Modify: `lib/work-items/delivery-runner/checks-step.ts`（`runChecksStep`：finalizeChecks 前置判断改为「全 passed ∧ integrate.enabled → 执行集成段」；`INTEGRATE_TIMEOUT_MS = 600_000`；逐候选仓：cwd = 该仓 checkout 路径（claim.worktrees）、`{repositoryId}` `{branch}` 替换（branch = `verifyBranch(key, generation)` 同一推导）、`spawnSync("bash", ["-c", command], { cwd, timeout })`；失败/超时 → `status: "blocked"`（phase 不变）、verification 不写、事件 `delivery.integrate_failed {repositoryId, exitCode|signal, stderrTail}` → 清 claim → 返回 `"integrate-failed"`（`ChecksStepOutcome` 扩值）；全部成功 → 结算照旧。deps 注入 `integrateCommandRunner` 便于测试）
- Modify: `lib/work-items/delivery-runner/checks-step.test.mjs`
- Modify: `lib/work-items/delivery-runner/attempts.ts`（`verificationOutcome` 增 `"integrate-failed"`? ——不用：integrate 失败时 attempt outcome 用 `"failed"` + reason 字段，或 `verificationOutcome: "unverified"` 同族？**裁定：attempt `outcome: "failed"`、`reason: "integrate failed (<repositoryId>)"`，与 failed checks 的 attempt 形状一致**）

- [ ] **Step 1: 失败测试**——真临时仓：integrate 关闭 → 行为零变化（回归）；开启 + 命令成功 → verification + release_ready + 无 integrate 事件；命令 `exit 3` → blocked + `delivery.integrate_failed`（data 含 repositoryId/exitCode）+ verification 不写 + attempt failed + 无 failure-window；命令引用 `{repositoryId}` `{branch}` → 断言替换后的字符串出现在临时文件（命令 `echo {repositoryId} {branch} > out.txt` 读 checkout 内产物）；超时注入 → 同失败路径；cwd = checkout 目录（断言 `git rev-parse HEAD` 在命令里等于候选 sha）；unblock 后整回合重新 due（复用 fix-round 的 blocked→unblock e2e 模式）；disaster：命令删文件 → 不影响 item.yaml（锁外段）。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: integrate stage in the system checks run with per-repo checkout cwd`

---

### Task 3: record-acceptance 动作 + attention acceptance 类

**Files:**
- Modify: `lib/work-items/delivery-types.ts`（`DELIVERY_ACTIONS` 增 `"record-acceptance"`）
- Modify: `lib/work-items/delivery.ts`（`case "record-acceptance"`：requirePhase release_ready；payload `{ notes }` requireText；`delivery.acceptance = { notes, candidateDigest: candidatesDigest(base.candidates), at }`；事件 `delivery.accepted`；phase/status 不变；无 candidates → Validation「先有候选」）
- Modify: `lib/work-items/delivery.test.mjs`
- Modify: `lib/work-items/legal-actions.ts`（`legalDeliveryActions`：release_ready 且 acceptance enabled? ——legal-actions 是纯客户端、无 config；**裁定：动作合法性不带 config 条件**（enabled=false 时 record-release 门不生效，record-acceptance 多给一个无害动作，人可以记验收但门不卡——可接受且简单）；release_ready 阶段动作表加 `record-acceptance`（在 prepare-release 旁）；动作条不含（与 answer-clarification 同理？——**不含：它有语义但 UI 上放动作条按钮亦可……裁定：进动作条**（有 label 即可，无表单需求，notes 用现有动作 payload 弹窗输入）→ `legalActionBarActions` 不过滤它；`WorkItemActionbar.tsx` 的 `Record<DeliveryAction,…>` 补 label「登记验收」）
- Modify: `lib/work-items/attention.ts`（`AttentionKind` 增 `"acceptance"`；投影：release_ready ∧ 无当前 digest acceptance → acceptance 条目（锚点同 release）；release 类条件不变）
- Modify: `lib/work-items/attention.test.mjs`
- Modify: `lib/api-types.ts`（`AttentionKind` 镜像扩值）
- Modify: `components/work-items/WorkItemActionbar.tsx`（label 表补 `record-acceptance: "登记验收"`；HEAD-clean 则提交，否则编辑不提交并报告）
- Modify: `lib/work-items/delivery-runner/routes.test.mjs`（slug 权威表源断言已覆盖；无需改）

- [ ] **Step 1: 失败测试**——record-acceptance：happy（记录落盘含 digest、事件 actor user、phase/status 不变、幂等重放）；release_ready 无候选 → 400；notes 空 → 400；record-release 门（acceptanceRequired，Task 1 已测——这里只补 apply 集成层一条）；legal：release_ready 动作表含 record-acceptance、动作条含；attention：acceptance 类出现/消失（record 后）、digest 变化后重现、acceptance 关闭时不出现；`AttentionKind` 扩值后 UI Record 编译（tsc）。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: record-acceptance human action, acceptance gate wiring and attention acceptance kind`

---

### Task 4: UI + 文档

**Files:**
- Modify: `components/work-items/WorkItemDetailView.tsx`（acceptance 记录块：notes / digest 短 / 时间；HEAD-clean 则提交，否则编辑不提交报告）
- Modify: `components/WorkspaceManager.tsx`（交付块：「集成命令」输入（integrate.enabled + command）与「验收门」开关；用户 WIP——编辑不提交）
- Modify: `components/work-items/work-item-execution.test.mjs` 或相关测试同步（不提交若用户 WIP）
- Modify: `AGENTS.md`（规则：integrate 是 checks 步延伸段、失败同 unverified（blocked 待 unblock、不进预算）；acceptance 门只卡 record-release、与 release-preparer 起草并行；record-acceptance 刻意不做 LLM 工具；confirm-design 归一 open——编辑不提交）
- Modify: `knowledge/reference/work-items.md` / `file-map.md` / `knowledge/architecture.md`（第四步各节——编辑不提交）
- Modify: `components/work-items/AttentionBar.tsx`（acceptance 类 chip 「待验收」——若该文件 HEAD-clean 提交，否则编辑不提交）

- [ ] **Step 1: 测试/手测**——设置块三开关 round-trip（review / integrate+command / acceptance）；acceptance 块渲染；AttentionBar 五类；文档 grep：`record-acceptance` 与 `integrate_failed` 与代码名一致。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: acceptance record display, integrate/acceptance settings and attention chip`

---

## 端到端冒烟（controller；jiti 驱动新 dispatcher；磁盘短暂 enabled 前先确认池无 LLM-ready 项或注入 launch 抛错）

1. 真 git 仓候选 + integrate 命令 `git rev-parse HEAD > sha.txt`（cwd=checkout）→ checks_passed + release_ready + sha.txt 内容 = 候选 sha。
2. integrate 命令 `exit 9` + 新候选 → blocked + `delivery.integrate_failed`；unblock → 整回合重跑（checks + integrate 再次执行）。
3. acceptance 开启：release_ready 无 acceptance → attention 出 acceptance 条目；record-release 被拒（先验收）；`record-acceptance` 后 → attention 条目消失、record-release 通过 → released（基线冻结）。
4. confirm-design 重复场景：rework target=design → design/in_progress → confirm-design → status open（可被 LLM 重领）。

## 自审记录（写计划时已核对）

- Spec 覆盖：§5.1 integrate/acceptance 行 → T2/T3；§5.3 第四步决策全部条目 → T1–T3；§7 stages 扩展 → T1；§8 acceptance 类 → T3；§12 默认 → T1–T3。
- 已核事实：`reworkTransition` 在 delivery.ts（:135 附近）清四键——加 acceptance 一键；`record-release` case 在 delivery.ts :374（requirePhase release_ready + candidates 守卫）；`confirm-design` case :276 不写 status；`prepareVerifyCheckouts` 产物 worktrees 在 claim 上（integrate cwd 可用）；`ChecksStepOutcome` 四值可扩；`AttentionKind` 在 api-types 单点定义、UI `Record<AttentionKind,…>` 编译强制；`legal-actions.ts` 纯客户端（无 config 注入——动作合法性不带 enabled 条件的裁定已写明）。
- 未做：digest 渲染 / 巡逻（第五步）；init 向导 / 模板对比 / profile 哈希（第六步）；checks-start 失败表面化（终审建议，并入第六步就绪清单）。
