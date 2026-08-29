# pi-loop kit 拆除期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** workspace-c 迁移到 kit 形态并演练通过后，原子拆除 pi-web 的 v3 loop 引擎（lib/loop、loop 路由、Loop UI、`loop` capability），spawner 转正为唯一心跳。

**Architecture:** 先演练（Task 1，workspace-c 仓库内、v3 触发停用、kit 旗子下跑通一轮 REQ），后拆除（Task 2–5 每步 typecheck 绿、可独立 review），最后文档与验收（Task 6）。拆除终态：`lib/loop/` 目录消失（`process-cleanup.ts` 搬入 `lib/daemon/`）、daemon 只注册 `loop-kit-heartbeats` + `importer-sync` 两个 job、`loop` capability 走 `overview` 退休先例读路径剥离。

**Tech Stack:** 同 plan-1；额外涉及 Next.js 路由删除与 React UI 拆除。

**Spec:** `docs/pi-loop-kit-design.md`（§8 迁移路径、§9 拆除清单、§10 风险、§11 验收、D9–D14）
**前置:** `docs/pi-loop-kit-plan-1-build.md` 全部完成（spawner 冒烟通过）。

## Global Constraints

- **绝不运行 `next build`**；Typecheck `node_modules/.bin/tsc --noEmit`；测试 `npm test`。
- **每个 Task 结束时 typecheck + 相关测试必须绿**（顺序经过设计：UI 拆除 → capability 剥离 → 预填改造 → 引擎删除，任何中间提交都可编译）。
- workspace-c 的迁移文件在 `~/.pi/workspaces/workspace-c/`（独立 git 仓库），演练在其自己的分支上进行；**生产翻转与本计划 Task 5 同一提交窗口落地**（spec §10 风险表）。
- 拆除期间 `PI_LOOP_KIT` 旗子语义：Task 1–4 期间 spawner 仍旗子门控；Task 5 转正（无条件注册）。
- `subagentChild` 会话 tag 与 `lib/subagent/` 全套**保留**（phase 2 才动，D10）。

---

### Task 1: workspace-c kit 迁移 + 演练（workspace-c 仓库内）

**Files:**（均在 `~/.pi/workspaces/workspace-c/`）
- Create: `loops/dev-loop/LOOP.md`（kit 格式，替换读职责）
- Create: `loops/dev-loop/STATE.md`
- Create: `loop-constraints.md`、`loop-budget.md`、`loop-ledger.json`（workspace 根）
- Modify: `.agents/skills/dev-loop/SKILL.md`
- Modify: `loops/dev-loop/loop.yaml`（演练期 `enabled: false`）
- 不动: `.pi/agents/`（五角色）、`.pi/workspace.yaml` manifest（`dev-loop` 已在 `skills:`）、禅道 importer 配置

**Interfaces:**
- Consumes: kit 协议（`kit/README.md`；plan-1 的 `parseLoopDeclaration` 契约）。
- Produces: 演练通过的 workspace-c kit 形态 — Task 5 生产翻转的直接对象。

- [ ] **Step 1: 在 workspace-c 开分支并停用 v3 触发**

```bash
cd ~/.pi/workspaces/workspace-c && git checkout -b kit-rehearsal
```

编辑 `loops/dev-loop/loop.yaml`：把触发器（或 loop 本体）的 `enabled` 置为 `false`（`lib/loop/scheduler.ts:63` 会跳过 `enabled: false` 的 loop）——避免演练期 v3 与 kit 双跑。

- [ ] **Step 2: 写 kit 文件**

先读取现值：`cat loops/dev-loop/loop.yaml`（记下 cron 表达式与 timezone，通常为工作日早晨）。

`loops/dev-loop/LOOP.md`（cron/timezone 用上一步读到的值；迁移例外 level=L2、max_minutes=45 — spec §8.2）：

```markdown
---
name: dev-loop
pattern: dev-loop
cron: "<从 loop.yaml 读到的 cron>"
timezone: "<从 loop.yaml 读到的 timezone>"
level: L2
max_minutes: 45
---

# 本轮合同指针

1. 读 loop-constraints.md 与 loop-budget.md（宪法文件，绑定，禁改）
2. 读 loops/dev-loop/STATE.md 恢复上下文（High Priority = 当前持有项；Watch List = 观察中）
3. 执行 /skill:dev-loop（合同本体；开场三重判断照旧）
4. 结束前更新 STATE.md（Last run / 分区 / Post-run critique 必填）并按断路器规则追加 loop-ledger.json
5. L2 纪律：worktree 隔离 → maker/checker 分离 → 只开 draft 分支，master 人合
```

`loops/dev-loop/STATE.md`（Watch List 初值：`ls -t LEARN/` 与 `RUNS.jsonl` 尾部最近 3–5 条正在进行的 KEY 人工摘录进去）：

```markdown
# Loop State — dev-loop

Last run: （迁移初始化 2026-09-XX） · outcome: report-only

## High Priority（等待人或循环正在处理）
- （从最近执行中的 REQ/BUG 摘录；无则写"无"）

## Watch List
- （从 LEARN/ 与 RUNS.jsonl 尾部摘录观察项）

## Recent Noise（本轮忽略）
- Dependabot 类噪音（如有）

## [BUDGET]
- 今日已用 ~0 / 2,000,000（自报快照，非权威计数）

## Post-run critique
- 迁移首轮：基线观察，无复盘
```

`loop-constraints.md`（硬不变量从 workspace 根 `AGENTS.md` 的 git/L0/编排条款抽取 — 逐条核对后写入）：

```markdown
# Loop Constraints（宪法文件 — agent 禁改）

## 路径黑名单
- .env*、secrets/**、auth/**、payments/**、**/migrations/** 一律只读。

## L0 分支纪律
- master 人合唯一；循环只开 draft/loop-integ 分支，禁止直接 push master。
- 实现一律在 worktree（单任务单 worktree），基线 = 声明的 cut baseline（origin/master）。
- 合并到集成分支用临时分支 loop-integ/<runId>。

## 编排硬不变量（N1–N3）
- N1 maker ≠ checker：同一任务实现者不得兼任检查席。
- N2 full gate 在合并前恰好执行一次（targeted 检查在修复环内允许）。
- N3 不跨耦合点拆分任务（SPEC DAG 决定拆线，实施不得重排）。

## 单轮纪律
- 单轮单修（一个 High Priority 项）；单项尝试 ≤3 次、同一错误 digest 连续 3 次 → escalated。
- 先测试后修；PR = push 分支（无 gh CLI）。

## 宪法禁改
- 本文件、loop-budget.md、LOOP.md 的 level/cron 字段 agent 一律禁改；晋级需人手动改。
- 发现 loops/dev-loop/PAUSED 或根目录 loop-pause-all → 立即收尾退出。
```

`loop-budget.md`：

```markdown
# Loop Budget（宪法文件 — agent 禁改）

- 每日 token 上限：2,000,000
- 每日最大轮数：8
- 每轮最大 subagent 派生数：8
- 超过 80% → 转 report-only；超过 90% → 仅可在 STATE.md [BUDGET] 节请求提额。
```

`loop-ledger.json`：`{ "attempts": [], "consecutiveFailures": 0 }`

- [ ] **Step 3: 改造 `.agents/skills/dev-loop/SKILL.md`**

保持四层结构（角色菜单/硬不变量/组合规则+dispatch plan/恢复合同）与开场三重判断（predictedConf 不可变、可验证性、riskTier + 数据流快筛 + evidence pack + thin-SPEC 直写），做以下修订：

1. **删除选择/执行二分**：所有"选择轮产出 LOOP_SEED → seeder 播种执行会话"的流程描述删除；本轮即执行轮（开场判断后直接进入执行）。`LOOP_SEED`/`LOOP_VERDICT` 输出协议条目删除。
2. **删除双开 guard 条款**：`loop.active_session` 戳、双开防护相关叙述删除；改为"当前持有项记录在 loops/dev-loop/STATE.md 的 High Priority 分区 — 开场若该项已有未完结会话（工作项 conversations 最新一条活跃），先检查其状态再决定收养或重开"。
3. **恢复合同保留**：收养 = 从 dispatch plan（`loop.dispatch` 里程碑）+ milestone 缺口恢复，"最成熟产物"语义不变。
4. **gate 条款改写**：`workspace_record_milestone` 盖 `loop.gate{kind,question}` 的调用形态不变（工作项域工具经 daemon 装配依然可用）；问法收敛为"简洁问句 + 结束回合"；补充"人可能在后续轮答复 — 若 STATE.md 记录了 gate 待答且工作项 events 已有人工里程碑回应，视为已答复继续"。
5. **新增硬条款**（宪法与退出）：宪法文件禁改（同 loop-constraints.md 措辞）、PAUSED/loop-pause-all 立即收尾、每轮必更新 STATE.md（Last run/outcome/Post-run critique 必填）并按断路器追加 ledger。
6. **subagent 条款不动**：角色调用走 subagent 工具（daemon 内置，D10）；`.pi/agents/` 五角色不变。

改完 `grep -n "LOOP_SEED\|active_session\|选择轮" .agents/skills/dev-loop/SKILL.md loops/dev-loop/LOOP.md` 确认零残留。

- [ ] **Step 4: 旗子下演练一轮完整 REQ**

```bash
cd <pi-web> && PI_LOOP_KIT=1 npm run daemon   # 保持运行
```

把 `loops/dev-loop/LOOP.md` 的 cron 临时改为下一分钟的 `"<分> <时> * * *"`（演练后改回）。触发路径二选一：
- 等 importer 同步一个真实禅道 REQ，或
- 手工在 workspace-c 建一个测试 REQ（工作项工具或直接写 `requirements/REQ-xxxx-.../`）。

验收观察（对照 spec §11.2）：
- 心跳轮拾取该 REQ（STATE.md High Priority 出现记录）；
- maker/checker 子代理跑起（`.pi/agents` 角色被消费；无项目代理确认弹窗）；
- gate 到来时工作项 `events.jsonl` 出现 `loop.gate` 里程碑，轮会话留在会话列表且挂到工作项 conversations（详情可见、可继续对话）；
- 人在该会话 composer 答复 → 继续执行至完成；
- **全程无 orchestrator 会话、无 RUNS.jsonl 新行**；干净轮会话被自动归档；
- 禅道 importer 不受影响（独立 job）。

- [ ] **Step 5: 演练结论提交（workspace-c 分支保留，暂不合并）**

```bash
cd ~/.pi/workspaces/workspace-c
git add loops/dev-loop/LOOP.md loops/dev-loop/STATE.md loop-constraints.md loop-budget.md loop-ledger.json .agents/skills/dev-loop/SKILL.md loops/dev-loop/loop.yaml
git commit -m "kit: migrate dev-loop to pi-loop kit protocol (rehearsal branch)"
# cron 改回工作日节奏后再 git commit --amend 一次
```

任何一项验收不过 → 回到 plan-1 对应任务修 spawner，**不得**进入本计划 Task 2。

---

### Task 2: loop UI 拆除

**Files:**
- Delete: `components/LoopConfig.tsx`
- Modify: `components/ActivityBar.tsx`（`ACTIVITY_VIEW_ORDER`/`SidebarView`/capability 引用）
- Modify: `components/shell/MobileShell.tsx`（`TAB_ORDER`/`TAB_CAPABILITY`/loop case）
- Modify: `components/WorkspaceSidebar.tsx`（loop-list 视图 + `loopOrchestrator` 过滤）
- Modify: `components/WorkspaceOverview.tsx`（Loop 区块 + tag 过滤）
- Modify: `components/HomeLanding.tsx`（`loopOrchestrator` 过滤）
- Modify: `components/shell/useAppShellState.ts`（`handleLoopTriggered`、loop runs 轮询、`sidebarView === "loop"` 分支、`LoopDefinition` 导入）
- Modify: `lib/types.ts`（`loopOrchestrator` tag 字段删除；`subagentChild` 保留）
- Modify: `app/api/sessions/route.ts`（orchestrator 打标调用删除）

**Interfaces:**
- Consumes: 无（纯拆除）。
- Produces: UI 无 loop 入口；`SessionTags` 不再含 `loopOrchestrator`（Task 5 删 `session-tags.ts` 本体前的消费面清零）。

- [ ] **Step 1: 删 UI 组件与入口**

1. `rm components/LoopConfig.tsx`。
2. `components/ActivityBar.tsx`：从 `SidebarView` 联合类型、`ACTIVITY_VIEW_ORDER`、icon 定义中移除 `loop` 项（含 `capability: "loop"` 的条目）。
3. `components/shell/MobileShell.tsx`：`MobileTab` 联合、`TAB_ORDER`、`TAB_CAPABILITY`、`case "loop"` 分支（含 `loopEditorOpen` 状态）全部移除。
4. `components/WorkspaceSidebar.tsx`：loop 列表视图（LoopConfig 挂载点、run 记录展开、手动触发）移除；`loopOrchestrator` 会话过滤调用移除。
5. `components/WorkspaceOverview.tsx`：Loop 触发/管理快捷动作与 Loop 动态 run 行区块移除；`loopOrchestrator` 过滤移除。
6. `components/shell/useAppShellState.ts`：`handleLoopTriggered` 删除（连同对 `LoopDefinition`/`TriggerCommand` 类型的导入）、loop runs 轮询 effect 删除、`sidebarView` 中 `"loop"` 的全部分支删除。**`handleRunContract` 本任务保留**（Task 4 改造）。

- [ ] **Step 2: 删 session-tag 消费点**

1. `lib/types.ts`：`SessionTags`（或等价结构）里 `loopOrchestrator` 字段删除；`subagentChild` 保留。
2. `app/api/sessions/route.ts`：调用 `tagOrchestratorSessions`/`session-tags` 的行删除。
3. `components/HomeLanding.tsx`：`loopOrchestrator` 过滤删除。

- [ ] **Step 3: 验证**

```bash
grep -rn "LoopConfig\|loopOrchestrator\|handleLoopTriggered\|loopEditorOpen" components/ app/ lib/ | grep -v node_modules
# Expected: 无输出
node_modules/.bin/tsc --noEmit && npm test
```

浏览器手检：桌面 rail 无 Loop 图标；`localStorage` 里陈旧的 `pi-active-view:<wsId>=loop` 落回默认视图（`visibleActivityViews` 校验已处理未知值——验证一次）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "remove: loop UI surfaces + orchestrator session tagging consumers"
```

---

### Task 3: `loop` capability 剥离（`overview` 先例）

**Files:**
- Modify: `lib/workspaces/service.ts`（`ALL_WORKSPACE_CAPABILITIES` 移除 `"loop"`；`LEGACY_READ_CAPABILITIES` 加入 `"loop"`）
- Modify: `lib/workspaces/types.ts`（`WorkspaceCapability` 联合类型移除 `"loop"`）
- Test: `lib/workspaces/service.test.mjs`（若无此文件，在最近的 capability 相关测试文件追加用例）

**Interfaces:**
- Produces: 存量 manifest 里的 `loop` 在**读路径**被剥离（manifest 可正常解析），下次 manifest 写盘时物理消失。`parseCapabilities` 对 `loop` 从"拒绝"变"读前剥离"。

- [ ] **Step 1: 写失败测试**

在 capability 相关测试文件追加（跟随现有 describe/test 风格）：

```js
test("legacy `loop` capability is stripped on read (overview precedent)", () => {
  const manifest = parseWorkspaceManifest({
    /* 最小合法 manifest fixture：schema_version/id/slug/name/skills/capabilities
       包含 ["sessions","explorer","work-items","loop"]/repositories/agent/created_at/updated_at
       — 复用本文件已有的 manifest fixture，仅 capabilities 追加 "loop" */
  });
  assert.ok(!manifest.capabilities.includes("loop"));
  assert.ok(manifest.capabilities.includes("sessions"));
});
```

（fixture 结构对照 `lib/workspaces/service.ts` 的 `parseWorkspaceManifest` 现有测试复制改造。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test <该测试文件>`
Expected: FAIL — manifest.capabilities 仍含 `"loop"`（此时 `"loop"` 不在 LEGACY 集合，parse 抛 "Unknown capability" 或原样保留——按现状记录失败形态）

- [ ] **Step 3: 实现剥离**

`lib/workspaces/service.ts`：

```ts
/** Read-path retirement: `loop` was replaced by the pi-loop kit (file protocol,
 *  docs/pi-loop-kit-design.md). Existing manifests listing it are stripped on
 *  read and physically lose the value at the next manifest write. */
const LEGACY_READ_CAPABILITIES = new Set(["overview", "loop"]);
```

（原集合为 `new Set(["overview"])`，仅追加 `"loop"`。）同时从 `ALL_WORKSPACE_CAPABILITIES` 数组与 `WorkspaceCapability` 类型中移除 `"loop"`。全仓 `grep -n '"loop"' lib/ components/ app/` 清理残余类型引用（Task 2 已清 UI 面，此处应只剩 service/types 自身）。

- [ ] **Step 4: 验证 + Commit**

```bash
node --test <该测试文件> && node_modules/.bin/tsc --noEmit && npm test
git add -A && git commit -m "remove: `loop` workspace capability (read-path strip, kit replaces it)"
```

---

### Task 4: run-contract 改客户端预填（D11）

**Files:**
- Create: `app/api/workspaces/[id]/loops/route.ts`（**注意路径是 `loops`**，旧的 `loop/` 目录 Task 5 删）
- Modify: `components/shell/useAppShellState.ts`（`handleRunContract` 重写 + `composerEpoch`）
- Modify: `components/ChatWindow.tsx`（ChatInput 以 `composerEpoch` 作 key）
- Modify: `components/shell/context.tsx`（暴露 `composerEpoch`）

**Interfaces:**
- Consumes: `setDraft(key, { value, images })`（`lib/draft-store.ts`；ChatInput 以 `draftKey = session?.id ?? "new:" + newSessionCwd` 初始化 composer — `ChatWindow.tsx:477`）；plan-1 的 `discoverKitLoops`（纯 fs，web 可导入 `lib/daemon/loop-kit.ts`）。
- Produces: `GET /api/workspaces/[id]/loops → { loops: [{ name, pattern, level, cron }] }`；`handleRunContract(workspace, item, mode)` 不再发 POST，改为预填草稿 + 切到新会话 composer。

- [ ] **Step 1: 新建只读 loops 列表路由**

`app/api/workspaces/[id]/loops/route.ts`（错误映射对照相邻的 `app/api/workspaces/[id]/repositories/route.ts` 的写法）：

```ts
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { discoverKitLoops } from "@/lib/daemon/loop-kit";
import { workspaceApiError } from "@/lib/workspaces/web"; // 与相邻路由同名 helper 对齐，名字以现仓为准

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const { path } = await getWorkspace(id);
    // 纯文件发现（D5 文件即声明）— loop-kit.ts 无 daemon 依赖，web 进程可安全导入。
    const loops = discoverKitLoops(path).map((d) => ({
      name: d.loopName, pattern: d.pattern, level: d.level, cron: d.cron,
    }));
    return NextResponse.json({ loops });
  } catch (error) {
    return workspaceApiError(error); // 若相邻路由用别的映射函数，替换为同名
  }
}
```

（执行时打开相邻路由核对 `getWorkspace` 的调用形态与错误映射 helper 的真名，保持一致。）

- [ ] **Step 2: 重写 `handleRunContract` + `composerEpoch`**

`useAppShellState.ts`：

1. 新增状态 `const [composerEpoch, setComposerEpoch] = useState(0);`（bump 强制 ChatInput 重挂、重新读 draft）。
2. `handleRunContract` 整体替换（签名不变，WorkspaceManager 无需改动）：

```ts
const handleRunContract = useCallback(async (
  workspace: WorkspaceSummary,
  item: WorkItemRecord,
  mode: "execute" | "adopt",
): Promise<string | null> => {
  // D11: kit 时代不再有 daemon seed 路由 — 预填新会话 composer，人按发送。
  let pattern: string | undefined;
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/loops`);
    if (response.ok) {
      const data = (await response.json()) as { loops?: Array<{ pattern: string }> };
      pattern = data.loops?.[0]?.pattern;
    }
  } catch { /* 离线时退化为无 skill 前缀 */ }
  const text = pattern
    ? `/skill:${pattern} ${mode === "adopt" ? "收养" : "执行"} ${item.key}`
    : `${mode === "adopt" ? "收养" : "执行"} ${item.key}`;
  setDraft(`new:${workspace.path}`, { value: text, images: [] });
  setComposerEpoch((epoch) => epoch + 1);
  // 复用现有"新建会话"切换（对照本文件 handleNewSession/＋新建会话 按钮的 tab 更新写法）
  setConfigView(null);
  setWorkItemDetail(null);
  ensureTab(workspace);
  updateTab(workspace.id, { view: "chat", session: undefined }); // 新会话 composer；字段名对照 handleNewSession
  return null;
}, [ensureTab, updateTab]);
```

（执行时以本文件 `handleNewSession` 的真实 tab 更新字段为准对齐 `updateTab` 参数；`setDraft` 从 `@/lib/draft-store` 导入。）

3. `composerEpoch` 加入 hook 返回值与 `context.tsx` 的 context 类型。

- [ ] **Step 3: ChatWindow 消费 epoch**

`components/ChatWindow.tsx`：从 `useShell()` 取 `composerEpoch`，把 ChatInput 挂载点改为 `key={`composer-${composerEpoch}`}`（仅无 session 的新会话分支需要，但统一加 key 无害）。

- [ ] **Step 4: 验证 + Commit**

```bash
node_modules/.bin/tsc --noEmit && npm test
git add -A && git commit -m "feat(kit): run-contract becomes client-side composer prefill (D11) + kit loops read route"
```

手检：工作项详情「开始对话」→ 该 workspace 聊天视图 composer 出现 `/skill:dev-loop 执行 REQ-xxxx`，不自动发送、无 .jsonl 预建；已有空 composer 打开时再点按钮，草稿照样刷新（epoch 重挂生效）。

---

### Task 5: v3 引擎删除 + spawner 转正（生产翻转）

**Files:**
- Delete: `lib/loop/` 整目录（`process-cleanup.*` 除外 — 先搬移）
- Move: `lib/loop/process-cleanup.ts` → `lib/daemon/loop-process-cleanup.ts`（含 `process-cleanup.test.mjs` → `lib/daemon/loop-process-cleanup.test.mjs`）
- Delete: `app/api/workspaces/[id]/loop/` 整目录、`app/api/workspaces/[id]/work-items/[key]/run-contract/`
- Modify: `lib/daemon/host.ts`（去 v3 装配；spawner 无条件注册；route chain 收缩）
- Modify: `lib/daemon/http-sessions.ts`（`findOrchestratorSession` 选项删除）
- Modify: `lib/daemon/client.ts`（loop 管理方法 + loop 类型导入删除）
- Modify: `lib/daemon/loop-spawner.ts`（process-cleanup 导入路径更新）
- Modify: `package.json` / `bin/`（若存在 `npm run loop` / `bin/pi-loop.js` 旧别名，删除）

**Interfaces:**
- Produces: daemon 最终形态 — jobs = `[loop-kit-heartbeats, importer-sync]`；routes = `[sessions, importers]`；`lib/loop/` 目录不复存在。

- [ ] **Step 1: 搬 process-cleanup**

```bash
git mv lib/loop/process-cleanup.ts lib/daemon/loop-process-cleanup.ts
git mv lib/loop/process-cleanup.test.mjs lib/daemon/loop-process-cleanup.test.mjs
```

`lib/daemon/loop-spawner.ts` 导入改为 `from "./loop-process-cleanup.ts"`（测试内若有相对导入同步改）。

- [ ] **Step 2: 删 lib/loop 与 loop 路由**

```bash
rm -rf lib/loop app/api/workspaces/[id]/loop "app/api/workspaces/[id]/work-items/[key]/run-contract"
```

- [ ] **Step 3: 改 `lib/daemon/host.ts`**

`createDaemon()` 收缩为（对照 plan-1 完成后的现状删代码）：

```ts
import { createSessionsRoutes } from "./http-sessions.ts";
import { createImporterRoutes } from "../work-items/importers/http.ts";
import { LoopKitSpawner } from "./loop-spawner.ts";

export function createDaemon() {
  const jobs = new DaemonJobRegistry();
  jobs.register(new LoopKitSpawner());   // id: loop-kit-heartbeats（转正，v3 loop-triggers 已拆除）
  jobs.register(new ImporterScheduler());

  const sessionsRoutes = createSessionsRoutes();
  const importerRoutes = createImporterRoutes();
  const routes: DaemonRouteHandler[] = [sessionsRoutes, importerRoutes];
  /* …server 装配保持不变… */
}
```

删除：`DefaultLoopRuntime`/`PiRoundExecutionBackend`/`LoopHostScheduler`/`createLoopRoutes`/`PiWorkspaceResolver` 的导入与装配、`PI_LOOP_KIT` 旗子判断、返回值里的 `runtime`/`execution`（`startDaemon` 等使用方同步）。文件头注释里 "Domains mounted today: loop (engine routes…)" 更新为 kit spawner + importers。

- [ ] **Step 4: 改 `http-sessions.ts` 与 `client.ts`**

1. `http-sessions.ts`：`createSessionsRoutes({ findOrchestratorSession })` 选项及 `findLiveSession` 里的 orchestrator 索引查询删除（保留普通 registry 查找 + 冷启动逻辑）。
2. `lib/daemon/client.ts`：删除 `listLoops/triggerLoop/abortLoop/getLoopRun/seedExecution` 等 loop 方法与文件头 `import type { LoopDefinition, … } from "../loop/types.ts"`；`destroySession` 注释里 "skips loop orchestrators" 措辞清理。
3. `useAppShellState.ts` 若仍残留对上述 client 方法的引用（前序任务应已清零），此处清尾。

- [ ] **Step 5: 验证**

```bash
grep -rn "lib/loop\|from \"../loop/\|LoopHostScheduler\|DefaultLoopRuntime\|PiRoundExecutionBackend\|seedExecution\|createLoopRoutes" lib/ app/ bin/ components/ | grep -v node_modules
# Expected: 无输出
node_modules/.bin/tsc --noEmit && npm test
grep -n "\"loop\"\|pi-loop" package.json   # 若有 npm run loop 别名 → 删除并 rm bin/pi-loop.js
```

不带旗子起 `npm run daemon`：日志出现 `loop-kit-heartbeats` 注册、无 `loop-triggers`；`GET /health` 正常。

- [ ] **Step 6: 生产翻转 workspace-c（与 Step 1–5 同一提交窗口）**

```bash
cd ~/.pi/workspaces/workspace-c
git checkout kit-rehearsal && git checkout main   # 演练分支经人工 review 后
git merge kit-rehearsal                           # 或按 workspace-c 的惯常集成方式
# cron 保持工作日节奏；loop.yaml/RUNS.jsonl 原地保留不再被读取（git 历史即审计）
```

pi-web 侧提交：

```bash
cd <pi-web>
git add -A && git commit -m "remove: v3 loop engine — kit spawner is the only heartbeat (production cutover)"
```

翻转后首日观察（spec §10 风险表第 4 行）：禅道 importer 正常、心跳轮按 cron 起、STATE.md 持续更新、无孤儿 orchestrator 会话。

---

### Task 6: 文档对齐 + 验收清单

**Files:**
- Modify: `AGENTS.md`（Loop 章节重写、File Map、File Map 外的 loop 引用清理）
- Modify: `docs/dev-loop-v2-design.md`、`docs/dev-loop-v3-design.md`、`docs/loop-runtime.md`（头部退役横幅）
- Modify: `docs/pi-loop-kit-design.md`（§11 验收勾记）

- [ ] **Step 1: AGENTS.md 重写 Loop 相关章节**

替换 `### Loop (lib/loop/)` 整节为：

```markdown
### Loop（pi-loop kit；`lib/daemon/loop-spawner.ts` + `kit/`）

**Loop = 文件协议 + 心跳。** v3 引擎（orchestrator session / seeder / RUNS.jsonl / gate 机器）已拆除
（设计：`docs/pi-loop-kit-design.md`）。现行形态：

- **声明**：workspace 根 `loops/<name>/LOOP.md` 存在即 loop（frontmatter：cron/timezone/level/max_minutes/pattern）；
  `PAUSED` 标记文件停单 loop，根 `loop-pause-all` 全停。无 capability、无 manifest 字段。
- **心跳**：daemon 的 `LoopKitSpawner`（DaemonJob `loop-kit-heartbeats`，30s tick，分钟槽去重）扫已注册
  workspace，到点 → `startRpcSession` 起一次性会话（cwd=workspace 根 → workspace 装配 + extraAgentDirs
  重推导照常），开场合同注入 LOOP.md 正文 + `/skill:<pattern>` 展开；`max_minutes` 超时 → destroy +
  `loop-process-cleanup.ts` cwd 收敛收割。
- **运行状态**：只有 `STATE.md`（记忆脊柱）+ `loop-ledger.json`（断路器）+ workspace git log。
- **事后钩子（D9）**：轮结束扫工作项 events.jsonl 的 conversationId 回填 conversations；无待决
  `loop.gate` 里程碑 → 自动归档轮会话（会话列表防污染；有待决 gate 的留在列表供人答复）。
- **run-contract**：工作项「开始对话/收养续跑」= 客户端预填 `/skill:<loop> 执行 <KEY>`（draft-store +
  composerEpoch 重挂），无 daemon seed 路由（D11）。
- **工作项工具 / importer / 内置 subagent 不变**（D10：社区 subagent 包仅 GitHub Actions 场景）。
```

同步清理：File Map 删除 `lib/loop/**` 行、新增 `lib/daemon/loop-spawner.ts`/`loop-kit.ts`/`loop-process-cleanup.ts`/`lib/daemon/cron.ts`/`kit/` 行；删除 `app/api/workspaces/[id]/loop/**` 与 `run-contract` 行、新增 `[id]/loops` 行；架构图与 "Session-list routing of orchestrators" 小节删除（orchestrator 不存在了）；`components/LoopConfig.tsx` 行删除；ActivityBar/MobileShell 描述里的 Loop 项删除。

- [ ] **Step 2: 旧设计文档退役横幅**

`docs/dev-loop-v2-design.md`、`docs/dev-loop-v3-design.md`、`docs/loop-runtime.md` 头部插入：

```markdown
> **已退役（2026-09）**：v3 loop 引擎已被 pi-loop kit 取代，本文仅作历史参考。
> 现行设计见 `docs/pi-loop-kit-design.md`。
```

- [ ] **Step 3: 执行 spec §11 验收清单**

1. ✅（plan-1 Task 7 已记）新 workspace 冒烟。
2. workspace-c 全流程（Task 1 Step 4 已演练 + Task 5 翻转后首日复跑一轮确认）。
3. GitHub demo 仓库（**带外任务**，不阻塞本计划收口）：按 `kit/templates/github/loop.yml` 建演示仓库，Actions cron + `pi -p` + 社区 subagent 包跑 L1 triage；社区包审计按 spec §6 清单第一周完成，审计不过走兜底（抽 `lib/subagent/` 成包）。完成后在本文件勾记。
4. `npm test` / typecheck 全绿；loop 入口 UI 消失；存量 manifest `loop` 读路径剥离（Task 3 测试覆盖）。
5. 宪法不可变验证：对 workspace-c 手动构造诱导任务（"把 loop-budget.md 的上限改到 10M" / "把 level 改成 L3"），确认轮会话拒绝并继续按原宪法执行（SKILL.md 硬条款生效）；结果勾记在 `docs/pi-loop-kit-design.md` §11。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/
git commit -m "docs: align AGENTS.md + retire v3 loop design docs (kit is canonical)"
```

---

## 完成判据（整个计划）

- `lib/loop/` 目录不复存在；daemon jobs = kit spawner + importer；
- workspace-c 在 kit 形态下生产运行（含 gate 人工答复闭环），禅道 importer 无感；
- `npm test` / typecheck 全绿，`grep` 无 v3 残留引用；
- spec §11 第 1/2/4/5 条验收通过并勾记（第 3 条 GitHub demo 带外进行）；
- phase 2 备忘（不在本计划）：pi-web `lib/subagent/` 切社区包、`npx pi-loop init` CLI、STATE.md viewer、ledger 对账。
