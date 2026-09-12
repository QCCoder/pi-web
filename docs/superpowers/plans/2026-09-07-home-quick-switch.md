# 首页快速切换（Home Quick Switch）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把首页升级为跨工作区快速切换中心：左侧中栏按工作区分组展示全部会话（点击直达），主区新增「＋ 新建会话」进入可先选工作区的无主会话页。

**Architecture:** 纯逻辑下沉 `lib/home-quick-switch.ts`（分组/默认工作区/归属匹配，TDD）；两个新组件 `HomeSessionGroups`（分组列表，桌面中栏 + 移动首页共用）与 `HomeNewSession`（无主会话页，复用 ChatWindow + 现有 `POST /api/agent/new` 管道，服务端零改动）；shell 状态层（`useAppShellState`）持有无主页开关与发送后落 tab 的管道。

**Tech Stack:** Next.js client components（inline styles，沿用现有模式）、node:test（`lib/**/*.test.mjs` 动态 `import("./x.ts")`）、无服务端改动、无 i18n key（沿用 HomeLanding 现状硬编码中文）。

**Spec:** 本文件 §0（与用户 grill 达成的共识原文）。

---

## §0 Spec（共识原文）

1. **左侧中栏（首页时的工作区面板）**：按工作区分组；每组列出该工作区**全部**会话（不截断），组内按修改时间降序；分组按组内最新会话活跃度降序，无会话的工作区沉底只显示组头（+「暂无会话」）；组头 = 工作区名 + 会话总数，**点击组头 = 打开该工作区**（现有 `handleOpenWorkspace`）；组可折叠（chevron），默认全展开，**状态不持久化**。
2. **会话行**：名称/首条消息 + 相对时间 + 运行中呼吸点（running SSE 数据）；点击 = 直达该会话（复用 `handleOpenSessionFromHome`）；**无行内管理操作**。
3. **主区 HomeLanding（桌面）**：删除「最近会话」平铺区；保留 hero + 工作区卡片 + 新建/导入；主操作区新增「＋ 新建会话」主按钮（accent，最左），「新建工作区」退为次要。
4. **无主新会话页（B1 原地切换）**：点击「＋ 新建会话」→ 主区原地切换为「‹ 返回 + 工作区选择器 + 输入框」；选择器**默认选中最近活跃工作区**（最近会话所属 → 最近打开 tab(mru) → 第一个可用）；随时可打字（草稿，home 专属键 `new:__home__`，切换选择不清空）；首次发送以所选工作区根为 cwd → 现有 `POST /api/agent/new`（daemon `findWorkspaceForPath` 解析工作区装配扩展）；发送后打开该工作区 tab 落到新会话，首页还原；无任何工作区时显示创建引导。
5. **移动端同步**：首页下半区「最近会话」→ 同一套分组列表；hero 行最左加「＋ 会话」主按钮（新建/导入退为次要）；无主会话页全屏化（‹ 返回 + 选择器 + 输入框），逻辑同桌面；横向工作区 chips 保留。
6. **非目标**：行内管理操作｜折叠持久化｜⌘K 快速切换器｜loop 轮会话特殊过滤（与工作台一致展示）｜服务端改动。
7. **过滤口径**（沿用现有）：排除归档（/api/sessions 默认）、`subagentChild`、不属于任何工作区的会话；不可用（`available: false`）工作区不参与分组（WorkspaceSidebar 沿用旧的禁用行展示）。

## Global Constraints

- 工作树有**无关的未提交改动**（ChatInput.tsx / ChatInput.test.mjs / lib/i18n/messages/*）——提交时只 `git add` 本计划涉及的文件，绝不 `git add -A`。
- **不改 ChatInput.tsx**（避开未提交改动）；ChatWindow 只加一个可选 prop。
- 不跑 `next build`；验证 = `node_modules/.bin/tsc --noEmit` + `npm run lint` + `npm test` + 单文件 `node --test <file>`。
- 会话数据一律来自现有管道：中栏用 `WorkspaceSidebar` 已有的 `allSessions`/`runningSessionIds` props；HomeLanding 保留自己的 `/api/sessions` fetch（现状），不新增请求。
- `context.tsx` 无需改动（自动暴露 `useAppShellState` 全部返回值）。
- commit message 前缀 `feat:`/`docs:`，一次一个任务。

---

### Task 1: 纯逻辑层 `lib/home-quick-switch.ts` + `lib/format-time.ts`（TDD）

**Files:**
- Create: `lib/home-quick-switch.ts`
- Create: `lib/home-quick-switch.test.mjs`
- Create: `lib/format-time.ts`

**Interfaces (Produces):**
- `workspaceForSession(session: { cwd: string }, workspaces: WorkspaceSummary[]): WorkspaceSummary | undefined`
- `groupSessionsByWorkspace(workspaces: WorkspaceSummary[], sessions: SessionInfo[]): WorkspaceSessionGroup[]`，`WorkspaceSessionGroup = { workspace, sessions: SessionInfo[] (newest first), latestModified: string }`（组序：有会话按 latestModified 降序，空组沉底按 name 升序；只含 available 工作区；排除 subagentChild 与无归属会话）
- `defaultHomeNewSessionWorkspaceId(workspaces, sessions, mruWorkspaceIds: string[]): string | null`
- `formatRelativeTime(dateStr: string): string`（从 HomeLanding 原样搬移）

- [ ] **Step 1: 写失败测试** `lib/home-quick-switch.test.mjs`

```js
import test from "node:test";
import assert from "node:assert/strict";

function ws(id, name, path, available = true) {
  return { id, name, path, available, capabilities: [], repositoryCount: 0, skills: [] };
}
function sess(id, cwd, modified, extra = {}) {
  return { path: `/${id}.jsonl`, id, cwd, created: modified, modified, messageCount: 1, firstMessage: "", ...extra };
}

test("workspaceForSession: longest prefix wins, unavailable ignored, non-workspace undefined", async () => {
  const { workspaceForSession } = await import("./home-quick-switch.ts");
  const a = ws("a", "A", "/w/a");
  const nested = ws("n", "N", "/w/a/sub");
  const off = ws("o", "O", "/w/off", false);
  const list = [a, nested, off];
  assert.equal(workspaceForSession(sess("1", "/w/a/sub/x"), list)?.id, "n");
  assert.equal(workspaceForSession(sess("2", "/w/a"), list)?.id, "a");
  assert.equal(workspaceForSession(sess("3", "/elsewhere"), list), undefined);
});

test("groupSessionsByWorkspace: sorts groups by activity, sessions newest-first, empty sinks, filters", async () => {
  const { groupSessionsByWorkspace } = await import("./home-quick-switch.ts");
  const a = ws("a", "A", "/w/a");
  const b = ws("b", "B", "/w/b");
  const off = ws("o", "O", "/w/off", false);
  const sessions = [
    sess("a1", "/w/a", "2026-01-02T00:00:00Z"),
    sess("a2", "/w/a", "2026-01-03T00:00:00Z"),
    sess("b1", "/w/b", "2026-01-04T00:00:00Z"),
    sess("s1", "/w/a", "2026-01-05T00:00:00Z", { subagentChild: true }),
    sess("x1", "/elsewhere", "2026-01-06T00:00:00Z"),
  ];
  const groups = groupSessionsByWorkspace([a, b, off], sessions);
  assert.deepEqual(groups.map((g) => g.workspace.id), ["b", "a"]); // b 最新活跃在前；off 不可用不出现
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ["a2", "a1"]); // 组内降序、subagentChild 剔除
  assert.equal(groups[1].latestModified, "2026-01-03T00:00:00Z");
  const empty = groupSessionsByWorkspace([b, a], []);
  assert.deepEqual(empty.map((g) => g.workspace.id), ["a", "b"]); // 空组沉底按 name
  assert.equal(empty[0].latestModified, "");
});

test("defaultHomeNewSessionWorkspaceId: latest session owner → mru → first", async () => {
  const { defaultHomeNewSessionWorkspaceId } = await import("./home-quick-switch.ts");
  const a = ws("a", "A", "/w/a");
  const b = ws("b", "B", "/w/b");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [sess("b1", "/w/b", "2026-01-02T00:00:00Z")], ["a"]), "b");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [], ["b", "a"]), "b");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [], ["gone", "a"]), "a");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [], []), "a");
  assert.equal(defaultHomeNewSessionWorkspaceId([], [], []), null);
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test lib/home-quick-switch.test.mjs` → FAIL（module not found）
- [ ] **Step 3: 实现** `lib/home-quick-switch.ts`（完整代码见下）+ `lib/format-time.ts`（从 HomeLanding 原样搬移 `formatRelativeTime`）

```ts
import type { SessionInfo } from "./types";
import type { WorkspaceSummary } from "./workspaces/types";

/** Longest-prefix workspace owner match for a session cwd (nested workspaces:
 *  deeper path wins; unavailable workspaces never own sessions). */
export function workspaceForSession(
  session: { cwd: string },
  workspaces: WorkspaceSummary[],
): WorkspaceSummary | undefined {
  return workspaces
    .filter((workspace) => {
      const prefix = `${workspace.path.replace(/\/+$/, "")}/`;
      return workspace.available && (session.cwd === workspace.path || session.cwd.startsWith(prefix));
    })
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export interface WorkspaceSessionGroup {
  workspace: WorkspaceSummary;
  /** Sessions owned by this workspace, newest first. */
  sessions: SessionInfo[];
  /** `modified` of the group's newest session ("" when the group is empty). */
  latestModified: string;
}

/** Group sessions by owning workspace for the home quick-switch list.
 *  Available workspaces only (each keeps a group, header-only when empty);
 *  subagent children and sessions outside every workspace are dropped.
 *  Groups with sessions sort by latestModified desc; empty groups sink to the
 *  bottom (name asc). */
export function groupSessionsByWorkspace(
  workspaces: WorkspaceSummary[],
  sessions: SessionInfo[],
): WorkspaceSessionGroup[] {
  const byId = new Map<string, WorkspaceSessionGroup>(
    workspaces
      .filter((workspace) => workspace.available)
      .map((workspace) => [workspace.id, { workspace, sessions: [], latestModified: "" }]),
  );
  for (const session of sessions) {
    if (session.subagentChild) continue;
    const owner = workspaceForSession(session, [...byId.values()].map((g) => g.workspace));
    if (!owner) continue;
    byId.get(owner.id)!.sessions.push(session);
  }
  const groups = [...byId.values()];
  for (const group of groups) {
    group.sessions.sort((a, b) => b.modified.localeCompare(a.modified));
    group.latestModified = group.sessions[0]?.modified ?? "";
  }
  groups.sort((a, b) => {
    if (a.latestModified && b.latestModified) return b.latestModified.localeCompare(a.latestModified);
    if (a.latestModified) return -1;
    if (b.latestModified) return 1;
    return a.workspace.name.localeCompare(b.workspace.name);
  });
  return groups;
}

/** Default workspace for the home new-session page: the owner of the most
 *  recently active session → most recently used open tab → first group. */
export function defaultHomeNewSessionWorkspaceId(
  workspaces: WorkspaceSummary[],
  sessions: SessionInfo[],
  mruWorkspaceIds: string[],
): string | null {
  const groups = groupSessionsByWorkspace(workspaces, sessions);
  const latest = groups.find((group) => group.latestModified);
  if (latest) return latest.workspace.id;
  for (const id of mruWorkspaceIds) {
    if (groups.some((group) => group.workspace.id === id)) return id;
  }
  return groups[0]?.workspace.id ?? null;
}
```

```ts
// lib/format-time.ts
/** Compact Chinese relative time for session lists (搬自 HomeLanding). */
export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 0) return "刚刚";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString();
}
```

- [ ] **Step 4: 跑测试通过** — `node --test lib/home-quick-switch.test.mjs` → PASS ×3
- [ ] **Step 5: Commit**

```bash
git add lib/home-quick-switch.ts lib/home-quick-switch.test.mjs lib/format-time.ts
git commit -m "feat: home quick-switch pure logic (grouping / default workspace / relative time)"
```

---

### Task 2: `HomeSessionGroups` 组件 + WorkspaceSidebar 首页面板改造

**Files:**
- Create: `components/HomeSessionGroups.tsx`
- Modify: `components/WorkspaceSidebar.tsx`（home panel，~L494-540）

**Interfaces:**
- Consumes: Task 1 的 `groupSessionsByWorkspace`/`WorkspaceSessionGroup`/`formatRelativeTime`
- Produces: `<HomeSessionGroups groups runningSessionIds selectedSessionId? onSelectWorkspace onSelectSession />`

- [ ] **Step 1: 实现** `components/HomeSessionGroups.tsx`（完整代码：组头按钮=工作区名+总数→`onSelectWorkspace`；右侧 chevron 按钮 stopPropagation 折叠；`useState<Set<string>>` 本地折叠态默认空；会话行=呼吸点(运行中，复用 globals.css `pulse` keyframes)+名称+相对时间→`onSelectSession`；空组显示「暂无会话」）
- [ ] **Step 2: 改 WorkspaceSidebar home panel**：`const homeGroups = groupSessionsByWorkspace(workspaces, allSessions)`（`useMemo`），主体替换为 `<HomeSessionGroups …/>`；其后保留不可用工作区禁用行（`workspaces.filter(w => !w.available)`）与「＋ 导入目录…」按钮、空列表提示；PanelHeader「＋ 新建」不变。`allSessions`/`runningSessionIds`/`onSelectSession` 均已是现成 props。
- [ ] **Step 3: 验证** — `node_modules/.bin/tsc --noEmit` + `npm run lint` 通过；`npm run dev` 手测：首页中栏分组/折叠/点击组头/点击会话直达。
- [ ] **Step 4: Commit**

```bash
git add components/HomeSessionGroups.tsx components/WorkspaceSidebar.tsx
git commit -m "feat: home middle column — workspace-grouped quick-switch session list"
```

---

### Task 3: HomeLanding 改造（桌面删平铺+主按钮；移动分组+主按钮）

**Files:**
- Modify: `components/HomeLanding.tsx`

**Interfaces:**
- Consumes: Task 1 + Task 2 的 `HomeSessionGroups`/`groupSessionsByWorkspace`
- Produces: 新 props `onNewSession: () => void`、`runningSessionIds: Set<string>`（移动分支使用）

- [ ] **Step 1: 桌面**：删「Recent sessions」section 与 `recentSessions` 中桌面消费；主操作区改为「＋ 新建会话」（accent 主样式，`onClick={onNewSession}`）+「新建工作区」「导入目录」（次要样式）；删本地 `formatRelativeTime`/`workspaceForSession`（改 import lib）。
- [ ] **Step 2: 移动**：hero 行最左加「＋ 会话」compact 主按钮（`onClick={onNewSession}`）；下半区「最近会话」平铺列表替换为 `<HomeSessionGroups groups={groupSessionsByWorkspace(availableWorkspaces, sessions)} runningSessionIds … onSelectSession />`；chips 区不动。
- [ ] **Step 3: 验证** — tsc + lint；dev 手测两端首页。
- [ ] **Step 4: Commit**

```bash
git add components/HomeLanding.tsx
git commit -m "feat: home landing — new-session primary action, mobile grouped recents"
```

---

### Task 4: ChatWindow draftKey 覆盖 + shell 状态层无主页状态/管道

**Files:**
- Modify: `components/ChatWindow.tsx`（Props + L501）
- Modify: `components/shell/useAppShellState.ts`

**Interfaces:**
- Consumes: Task 1 `defaultHomeNewSessionWorkspaceId`
- Produces: `ChatWindow` 新可选 prop `draftKeyOverride?: string`；useAppShellState 新增并导出：`homeNewSession: { open: boolean; workspaceId: string | null }`、`handleHomeNewSession(): void`、`handleHomeNewSessionSelect(id: string): void`、`handleExitHomeNewSession(): void`、`handleHomeSessionCreated(session: SessionInfo): void`

- [ ] **Step 1: ChatWindow**：`Props` 加 `draftKeyOverride?: string`；L501 改 `draftKey={draftKeyOverride ?? session?.id ?? (newSessionCwd ? \`new:${newSessionCwd}\` : undefined)}`。
- [ ] **Step 2: useAppShellState**：
  - `const [homeNewSession, setHomeNewSession] = useState<{ open: boolean; workspaceId: string | null }>({ open: false, workspaceId: null });`
  - `activateTab` 内加 `setHomeNewSession({ open: false, workspaceId: null })`（任何 tab 切换/回首页都退出无主页，发送管道里 activateTab 即完成还原）。
  - `handleHomeNewSession`：`setHomeNewSession({ open: true, workspaceId: defaultHomeNewSessionWorkspaceId(workspaces, sessionActivity.sessions, mruIds) })` + `focusChat()`。
  - `handleHomeNewSessionSelect`：只改 workspaceId。
  - `handleExitHomeNewSession`：`setHomeNewSession({ open: false, workspaceId: null })`。
  - `handleHomeSessionCreated`（镜像 `handleOpenSessionFromHome`）：按 `homeNewSession.workspaceId` 找 available 工作区 → `ensureTab` → `updateTab(id, { view: "chat", session, newSessionCwd: null })` → `activateTab(id)`（顺带关无主页）→ `setSessionKey(k=>k+1)` → `navigateUrl(\`workspace=<id>&view=chat&session=<sid>\`)`。
  - return 对象导出上述五项。
- [ ] **Step 3: 验证** — tsc + lint（此任务无独立运行时入口，联动验证在 Task 5）。
- [ ] **Step 4: Commit**

```bash
git add components/ChatWindow.tsx components/shell/useAppShellState.ts
git commit -m "feat: home new-session state pipeline + ChatWindow draftKey override"
```

---

### Task 5: `HomeNewSession` 无主会话页 + 双 shell 接线

**Files:**
- Create: `components/HomeNewSession.tsx`
- Modify: `components/shell/DesktopShell.tsx`（home 分支 ~L531）
- Modify: `components/shell/MobileShell.tsx`（home 分支 ~L505）

**Interfaces:**
- Consumes: Task 4 全部 + `ChatWindow`（`draftKeyOverride="new:__home__"`、`session={null}`、`newSessionCwd={selected.path}`）、`ChatInputHandle`
- Produces: `<HomeNewSession workspaces selectedWorkspaceId onSelectWorkspace onBack onSessionCreated onCreateWorkspace modelsRefreshKey chatInputRef />`

- [ ] **Step 1: 实现** `components/HomeNewSession.tsx`：顶部一行「‹ 返回」+「工作区： {name} ▾」（自绘下拉：available 工作区列表、选中 ✓，点击 `onSelectWorkspace`）；`workspaces` 为空 → 居中引导「还没有工作区」+「新建工作区」按钮（`onCreateWorkspace`）；否则 `<ChatWindow session={null} newSessionCwd={selected.path} draftKeyOverride="new:__home__" onSessionCreated={onSessionCreated} modelsRefreshKey chatInputRef />`（未选中时 `newSessionCwd=null`，ChatInput 可打字存草稿、发送前必须选工作区——默认已选，空态由引导分支兜底）。
- [ ] **Step 2: DesktopShell**：home 分支改 `homeNewSession.open ? <HomeNewSession … /> : <HomeLanding … onNewSession={handleHomeNewSession} />`；HomeLanding 增传 `runningSessionIds={sessionActivity.runningIds}`。
- [ ] **Step 3: MobileShell**：home 分支同样换装；HomeLanding 增传 `runningSessionIds`。
- [ ] **Step 4: 验证** — tsc + lint + `npm test`；dev 手测：点「＋ 新建会话」→ 默认选中最近活跃 → 打字 → 切换选择草稿保留 → 发送 → 落到工作区 tab 新会话且流式正常 → 首页已还原 hero；移动端同路径 + ‹ 返回。
- [ ] **Step 5: Commit**

```bash
git add components/HomeNewSession.tsx components/shell/DesktopShell.tsx components/shell/MobileShell.tsx
git commit -m "feat: home unbound new-session page (workspace picker + composer), wired in both shells"
```

---

### Task 6: 文档同步 + 全量验证

**Files:**
- Modify: `AGENTS.md`（File Map：HomeLanding/HomeSessionGroups/HomeNewSession/WorkspaceSidebar home 面板/lib 新文件；Navigation 节首页一句）

- [ ] **Step 1: 更新 AGENTS.md** 对应条目（新组件一句话职责 + 首页快速切换定位）。
- [ ] **Step 2: 全量验证** — `node_modules/.bin/tsc --noEmit` && `npm run lint` && `npm test` 全绿。
- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md — home quick-switch surfaces"
```

---

## Self-Review

- **Spec 覆盖**：§0.1/2→Task 1+2；§0.3→Task 3(桌面)；§0.4→Task 4+5；§0.5→Task 3(移动)+5；§0.6 非目标均未引入；§0.7→Task 1 实现。✓
- **占位符**：Task 2/3/5 的组件代码以要点+接口精确描述（样式细节遵循仓库 inline-style 惯例，无 TBD）。✓
- **类型一致**：`WorkspaceSessionGroup`/`draftKeyOverride`/`homeNewSession` 各任务签名一致；`chatInputRef` 用 ChatWindow 同型 `React.RefObject<ChatInputHandle | null>`。✓
