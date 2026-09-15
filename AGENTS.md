# Pi Web - Development Notes

Pi Web is a web UI for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It runs a Next.js
server that owns **AgentSessions in-process**, plus a **Workspace** subsystem (manifest/capability/repositories,
work-items, loop, subagent, git/changes) layered on top.

> **Read this first when changing the project.** It documents the *current baseline* code. When you add or change a
> module, update the corresponding section here so the next person doesn't reinvent it (see
> `docs/workspace-redesign.md` §1 for why this file drifted before).

---

## Quick Start

```bash
npm run dev    # Next.js dev server on http://127.0.0.1:30141
npm run daemon # OPTIONAL — the pi-daemon, a separate process on :30142
               # (spawned automatically as a sidecar by `npm run dev` — see lib/session-daemon/sidecar.ts;
               #  run it manually/systemd when you want it managed explicitly.
               #  `npm run loop` is a deprecated alias pointing at the same bin/pi-daemon.js)
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
Tests: `npm test` (node:test over `lib/**/*.test.mjs`)

**Optional — pi data home inside the repo**: `node scripts/adopt-pi-home.mjs` moves `~/.pi/{agent,workspaces,workspace.yaml}`
into `<repo>/.pi/{agent,workspaces,workspace-index.yaml}` and writes `.env.local` pointing the three env vars
(`PI_CODING_AGENT_DIR` / `PI_WORKSPACES_DIR` / `PI_WORKSPACE_INDEX_FILE`) there — workspaces, skills and sessions become
visible in the project tree. `.pi/agent` + `.pi/workspaces` are gitignored (auth tokens live there) and excluded from
tsc/eslint/git-discovery; `bin/pi-daemon.js` self-loads `.env.local` (see "Local pi data home" under Key Design Decisions).

**Never run `next build` during dev** — it pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

```
Browser                Next.js Server                Session Daemon (bin/pi-daemon.js, :30142)
  │                        │                                │ — THE single session owner
  │  ┌──────── Workspace layer ────────┐                    │   (lib/daemon/rpc-manager.ts
  │  │ manifest .pi/workspace.yaml      │                    │    registry: interactive +
  │  │ capabilities → extensions        │                    │    subagent children + kit rounds)
  │  │ repositories / work-items /      │                    │
  │  │ loops (kit files)                │                    │
  │  └──────────────┬───────────────────┘                    │
  │                 │                                          │
  ├─ GET /api/sessions ──────▶ reads ~/.pi/agent/sessions/    │
  ├─ GET /api/sessions/[id] ─▶ reads .jsonl directly          │
  │                 │  (+ daemon /v1/sessions/live for fresh) │
  │                 │                                          │
  ├─ send message ──▶ POST /api/agent/[id] ── proxy ─────────▶ POST /v1/sessions/:id/commands
  │                   (lib/agent-proxy.ts)                    │   startRpcSession()/wrapper.send()
  │                 │                                          │
  ├─ SSE connect ───▶ GET /api/agent/[id]/events ── proxy ───▶ GET  /v1/sessions/:id/events
  │◀── data: {...} ──│◀───────────── piped ◀──────────────────│ session.subscribe()
  │                 │                                          │
  ├─ running ids ───▶ GET /api/agent/running/events ─ proxy ─▶ GET  /v1/sessions/running/events
```

- **Session browsing** (read-only): list views are served from the **persistent session index** (`lib/session-index.ts`, mtime+size incremental over `~/.pi/agent/sessions` incl. `.archived/`, cache file `~/.pi/agent/sessions/.index.json`, rebuildable, tmp+rename atomic write, failed saves retried in background via a dirty flag; schemaVersion 2 — v1 clipped `/skill:` expansions mid-wrapper, so firstMessage is now skill-reduced BEFORE the 400-char truncation, and the bump discards the stale cache for a one-time rebuild). **The in-process memo is TTL-bound (`PI_SESSION_INDEX_MEMO_TTL_MS`, default 3s)** — once it served a forever-snapshot, files written by OTHER processes (the daemon spawning subagent children / loop rounds) stayed invisible to locate/detail/list until a web restart, which resurfaced as "opening a subagent (child) does nothing / opens blank"; now every TTL expiry re-runs the cheap incremental walk (stat-heavy, not read-heavy) through the single in-flight promise. `listAllSessions()` in `lib/session-reader.ts` maps index entries to `SessionInfo` (firstMessage truncated to 160 chars for display — the raw text once inflated the payload to 1MB+); `GET /api/sessions?archived` and `listArchivedSessions()` derive from the same index; `GET /api/sessions/[id]/locate` resolves by id through `findSessionIndexEntry` (display title via the shared `firstMessageTitle`) and — on the daemon-probe hit — also seeds `cacheSessionPath` from the probe's `sessionFile`, so a just-spawned child whose .jsonl isn't flushed yet still opens (detail answers the empty-but-valid placeholder, live SSE renders on top). Opening a session detail still reads the whole .jsonl via SDK `SessionManager`, but the response is a **tail window** (`?tail=100`): `buildSessionContext(..., { tailMessages })` maps only the last N entries and sets `hasEarlier`; older pages arrive via `GET /api/sessions/[id]/earlier?before=<entryId>&limit=&leafId=` (`buildEarlierContext` — needs an explicit leaf, defaults to the session's current leaf). The client (`useAgentSession.loadEarlier` + ChatWindow prepend detection) grows the window as the user scrolls up; `VISIBLE_PAGE_SIZE` render-windowing in `lib/chat-lazy-load.ts` sits on top of the loaded window.
- **Sending a message**: the web routes are **pure proxies** (`lib/agent-proxy.ts` → `daemonClient`) over the session daemon, where `startRpcSession()` in `lib/daemon/rpc-manager.ts` creates the AgentSession. At creation it resolves the enclosing **Workspace** (if any) and attaches that workspace's extensions + skills + AGENTS.md.
- **Workspace management**: `app/api/workspaces/**` reads/writes `~/.pi/workspaces/**` and `~/.pi/workspace.yaml` (the global index). Capability edits, repository add/remove, work-item CRUD) all flow through this surface. Kit loops are plain files under the workspace root — the loop management surface is `app/api/workspaces/[id]/loops/**` (status/pause/resume/frontmatter edit/manual round/stop) + the WorkspaceOverview Loops block; heartbeats stay daemon-only.

---

## Workspace Subsystem

The largest subsystem and the one most often misunderstood. **Read this before touching anything workspace-related.**

### Model: manifest, capability, repository

A **Workspace** is a directory `~/.pi/workspaces/workspace-<slug>/` (root = `$PI_WORKSPACES_DIR` or `~/.pi/workspaces`)
with a manifest at `.pi/workspace.yaml` (`WorkspaceManifest`, schemaVersion 1, `lib/workspaces/types.ts`):

```yaml
schema_version: 1
id: <ULID>
slug: my-proj
name: My Project
template: { id: software-development, version: 1 }   # OPTIONAL/legacy — new workspaces omit this
template?: { id, version }                          # (see "Template selection removed" below)
skills: []                                          # new workspaces start with no skills
capabilities: [sessions, explorer, work-items, repositories, knowledge, ...]  # always written explicitly
repositories: [{ id, alias, name, kind: code|knowledge, path: <相对工作区根的 POSIX 路径>, status: active|removed, removed_at? }]
agent: { default_model?, thinking_level? }
disabled?: true                                   # 用户暂时停用（2026-09）：首页/选择器不可见，
                                                   # 不影响已开 tab/loop 心跳/会话装配；false 时键整个剥掉
git: { branch_rules: { requirement, bug }, create_after: plan_approved }      # only when work-items is on
work_items: { next_requirement_number, next_bug_number }
created_at / updated_at
```

- **Workspace index v2（一刀切迁移）**: `~/.pi/workspace.yaml` is schemaVersion 2. 条目可携带可选 `sort_order`（手动排序，2026-09：设置列表拖拽 → `PATCH /api/workspaces { order }` 重编 1..N，一次写；`registerWorkspacePath` 重建条目时透传保留）。`discoverWorkspaces` 终排序 = 可用优先 → 手动序升序在前 → 未设置条目按 lastOpenedAt 降序（MRU 兜底）——不排序的用户看到的顺序与引入前完全一致。 On first read a v1 index triggers `migrateIndexV2`: every registered manifest is rewritten with explicit `capabilities` (materialized `["sessions","explorer"]` when absent; retired channel values stripped), and `importWorkspace` runs the same `migrateManifestFile` normalization for unregistered directories. After the cut, `WorkspaceManifest.capabilities` is REQUIRED — `parseWorkspaceManifest` throws "capabilities is required" without it, `parseCapabilities` rejects retired channel values (`feishu-transport`/`feishu-channel`/`wecom-channel`) instead of silently stripping, and the `effectiveCapabilities` fallback helper is deleted (read `manifest.capabilities` directly).
- **WorkspaceRepository**: `{ id, alias, name, kind: "code"|"knowledge", path, status }`. **path** 是相对工作区根的
  POSIX 路径（校验：禁绝对路径/`..`/`.pi` 内）。**自动登记（2026-09「扫描为事实，manifest 只存记忆」）**：
  `listWorkspaceRepositories` 打开即跑 `syncRepositoriesFromScan`——`lib/workspaces/scan.ts` 从根扫 git 仓
  （`.git` 为目录；worktree 的 `.git` 文件不算）与 OKF 知识库（`index.md`+`log.md`，优先于 git 判定；点目录/
  node_modules/.worktrees 剪枝、发现即停、深度 4），新目录自动登记（alias=目录名规整、冲突加后缀）、消失自动
  停用、重现自动恢复；manifest 已有条目的 alias/kind 是钉住覆盖，扫描不改写。新仓顺带写入根 .gitignore。
  clone/init 仍是显式操作；`kind` 只驱动 UI 标签与（knowledge 时）**OKF seed**。Note: `knowledge` is *also* a
  top-level `WorkspaceCapability` (the UI "知识库" toggle); the repository `kind` and the capability are separate
  concerns — the capability gates the module/UI. (`docs/workspace-redesign.md` §5.1)
- **Template selection removed (redesign decision 5/7)**: creating a Workspace is **capability-driven** —
  `CreateWorkspaceInput = { name, slug, capabilities[] }`, no `templateId`. `createWorkspace()` validates the selection
  via `parseCapabilities`, force-includes the mandatory `sessions`+`explorer` (`normalizeInitCapabilities`), writes
  `manifest.capabilities` explicitly, and **omits `template`**. Per decision 6 (lazy directories) it does **not**
  pre-create `requirements/ bugs/ designs/ plans/ repositories/` — those are `mkdir -p`'d on first use (work-item
  creation, repo clone/init). It writes `.pi/workspace.yaml` + a capability-driven `AGENTS.md` always, and `git init`s
  the workspace repo only when a git-using capability (`repositories` **or** `work-items`) is selected (git branch
  rules are set only when `work-items` is on). Built-in templates are gone — manifests are capability-driven only.

### Capability system & extension mounting

`WorkspaceCapability` (`types.ts`) is the per-workspace module switch (includes `knowledge`, promoted from a mere
repository `kind` to a first-class capability — redesign decision 4, type layer). **`ALL_WORKSPACE_CAPABILITIES`** in
`lib/workspaces/service.ts` is the validation registry (the source of truth for which capabilities can be persisted):

```
sessions, explorer, work-items, repositories, knowledge, workflows
```

(PATCH capabilities are normalized by `normalizeUpdateCapabilities`: the mandatory `sessions`+`explorer` core can never be dropped. `parseCapabilities` REJECTS retired capability values (`feishu-transport`, `feishu-channel`, `wecom-channel`, the retired `overview` — the overview dashboard is now the unconditional landing view — the retired `loop`, replaced by the pi-loop kit: loops are declared by `.pi/loops/<name>/LOOP.md` files, no capability gate; `docs/pi-loop-kit-design.md` D5 — and the retired `requirement-sources`, 已随 importer 退役照 overview/loop 先例：外部源同步下放工作区脚本，见「外部源适配」节) — `WorkspaceValidationError` → HTTP 400. For the channel values the v2 index migration has already rewritten them out of existing manifests. `overview`, `loop` and `requirement-sources` share the one **read-path exception** (`LEGACY_READ_CAPABILITIES`): `parseWorkspaceManifest` strips it from `manifest.capabilities` BEFORE `parseCapabilities` validation, so legacy manifests that still list it keep parsing and normalize on every read — the value disappears from the file at the next manifest write.)

- `manifest.capabilities` is required and always present (see "Workspace index v2" above). Read it directly; there is no derivation helper.
- **`parseCapabilities()`** rejects anything not in `ALL_WORKSPACE_CAPABILITIES` (`WorkspaceValidationError` → **HTTP 400**). To add a toggleable module you must (1) add the value to `ALL_WORKSPACE_CAPABILITIES` *and* the `WorkspaceCapability` type, (2) add an extension factory, (3) add a config UI panel.
- **Extension factories** (`lib/workspaces/extensions.ts`, `WORKSPACE_EXTENSION_FACTORIES`) turn a capability into an LLM-callable tool extension: `work-items` → work-item tools, `knowledge` → `kb_search` (opt-in ranked retrieval; coexists with always-on L0). **`subagent` is deliberately NOT registered here** (see Subagent below).
- **Attachment point**: `buildWorkspaceExtensions(manifest, path)` filters factories by `manifest.capabilities`. `lib/daemon/rpc-manager.ts` always attaches the community `@henryqw/pi-subagent` extension globally (`piSubagentExtension()` from `lib/daemon/pi-subagent-host.ts`), then — when the session's cwd is inside a workspace — appends `buildWorkspaceExtensions(...)` and filters skills to `manifest.skills`.
### AGENTS.md auto-management (managed segments)

Each workspace may carry an `AGENTS.md` at its root. **`renderWorkspaceAgents(manifest, capabilities)`** is the
**capability-driven** generator (redesign decision 9): it emits a title, a collaboration-flow block when `work-items`
is on, a `<!-- workspace-managed:git:start/end -->` block when the manifest has `git` settings, and the repositories
block — **without depending on a template id**, so template-free workspaces still get a tailored policy. The legacy
`renderSoftwareDevelopmentAgents(manifest)` is retained for reference but no longer called by `createWorkspace`.

The **repositories** block is *auto-maintained* between managed markers:

```
<!-- workspace-managed:repositories:start -->
## Workspace repositories
- `alias` (code, id: `...`): `repositories/code/alias`
<!-- workspace-managed:repositories:end -->
```

`updateManagedRepositoryInstructions()` (called on repo add/remove/restore) replaces the block by the regex
`<!-- workspace-managed:repositories:start -->[\s\S]*?<!-- workspace-managed:repositories:end -->` with a fresh
`renderWorkspaceRepositories(manifest)`. It is a **no-op if the markers are absent** (it never creates them) and only
runs when the `repositories` capability is effective. `pi` injects `AGENTS.md` into the system prompt **verbatim** —
there is no `@`-include expansion; large content must be *referenced* and the model follows the reference to `read` it.

### Navigation: three-column layout (icon rail | middle panel | main area)

Desktop is four vertical strips: **`[ActivityBar 44px icon rail] [middle column 200–560px drag-resizable] [main area: SessionTabBar + Overview/chat] [file panel 42%, default-OPEN]`** — the old sidebar's icon strip + focused view split into the rail + middle column, so the width budget is unchanged. **The top tab bar is SESSION-keyed（2026-09 会话 tab 化，docs/session-tabs-design.md）：每个 tab = 一个会话/新会话占位/工作区家 tab（总览），跨工作区混排，工作区色点标识；`SessionTabState` 与纯逻辑（C1 点击分派/X1 邻居回落/U1 去重/URL 投影/R2 持久化恢复）在 `lib/session-tabs.ts`（+测试）。工作区从一级容器降级为跟随当前 tab 的环境上下文（`activeWorkspace = activeTab.workspace` 链不变）——中栏/图标栏/文件面板照旧跟随。交互：列表普通点击=当前 tab 原地变身（家 tab 上点击=开新 tab）、Cmd/中键/hover「新 tab」=新开、fork=新 tab、关 tab=先左后右邻居回落（最后一个→首页）、会话删除/归档自动关 tab；＋=当前工作区开新占位 tab、⊞=开/激活工作区家 tab；tab 条全量存 `pi-session-tabs`，重载恢复（失效 id 静默跳过，URL 深链优先决定 active）；只挂载当前 tab 的 ChatWindow（切 tab 与切会话同构重建），tab 徽章靠 running/events 全局流。移动端同一 SessionTabBar（chips 行，首页落地页隐藏）。** The middle column is **always mounted** (default 工作台); clicking the ACTIVE rail icon toggles the column (VS Code collapse). One `sidebarView` (`SidebarView` = module views + `archive` + `settings`, lifted in AppShell) drives everything — the five former modal/shell open-states (models/skills/plugins/archive/settings) collapsed into it. **The file panel hosts the workbench file tree as a pinned, non-closable leading「文件」tab** (`FILES_TAB_ID` in `lib/tab-types.ts`, re-exported by `TabBar.tsx`; content = `FilesExplorerPanel`) ahead of the opened-file tabs — per-tab file-tab state rides the SESSION tab (F1)，the fixed top-right toggle still collapses the panel, closing the last file tab falls back to the「文件」tab instead of collapsing the panel, and the tree stays MOUNTED (hidden via display:none) across tab switches of the SAME workspace so expansion state survives. Clicking a file in the tree opens/activates its file tab (FileViewer's edit mode = the click-to-edit path). **2026-09 右坞 S1（docs/right-dock-design.md）：右面板升级为 tab 化扩展坞**——TabBar 的 `leadingTabs` 钉死模块组（文件 + Loops；工作项/知识库随 S3/S2 加入，门控见 design §5），模块 id 也存在 `activeFileTabId` 值域里（同一条 F1 机制）；模块体常驻挂载（display:none 隐藏，同工作区切会话 tab 状态存活，换工作区 key 重置）；面板 <420px 时模块 tab 图标化（`right-panel-container` 的 container query，模块 tab 永不滚走，文件 tab 照旧横滚）；Loops tab = `LoopsDockPanel`（loop 列表+状态/暂停恢复/停止/运行 + 点开内联 `LoopsConfig` 推导航）。

Icon groups are fixed and strict (`ACTIVITY_VIEW_ORDER` + `RAIL_GLOBAL_VIEWS` in `ActivityBar.tsx`, the single source of truth for order/visibility)——**2026-09 W-中收敛（Phase 2）后模块组只剩 工作台(workbench)**（中栏的固定身份 + 从全局面板返回会话列表的入口）；then a **separator + global group (app-scoped): 模型(models) → Skills(skills) → 插件(plugins) → 归档（needs an active workspace）→ 设置（pinned to the rail bottom）**。知识库/工作项/Loops 的面板退役，全部住**右坞**（2026-09 右坞 S1/S2/S3；家 tab hub 与 `hubView` 状态已整体退役，家 tab 中心只剩总览）——工作项管理面 = WorkspaceManager（右坞工作项 tab，panel 模式推进航）、知识库浏览 = `KnowledgeBrowser`（右坞知识库 tab）、Loops = `LoopsDockPanel`（右坞 Loops tab）。
**The three config icons (模型/Skills/插件) are strict three-column views**: clicking one renders the config's **LIST in the MIDDLE column** (under a `PanelHeader` like every other panel — it temporarily replaces the `sidebarView` panel) and its **DETAIL in the RIGHT column**: the middle-column panel component (`ModelsConfig`/`SkillsConfig`/`PluginsConfig` in `split` mode) stays ONE component instance owning all state (selection, drafts, save flow) and portals its detail + footer into the right column's config area via `createPortal` — AppShell renders the portal-target div under the right `PanelHeader` (with ×) and feeds it back as `configPortalNode` (a null target renders nothing, so SSR stays safe). Opening a config view also opens the middle column (`handleOpenConfig` → `setSidebarOpen(true)`); any panel switch (`handleSidebarSwitchView` clears `configView`), session select, or × hands the column back to `sidebarView`; switching workspace resets it too. The rail highlights the config icon (`activeView={configView ?? sidebarView}`). They never persist (`isConfigView` routes them out of every panel switch; `GLOBAL_ACTIVITY_VIEWS` — the `pi-active-panel` persistence/validation surface — deliberately stays `["archive","settings"]`, and `visibleActivityViews()` does NOT include them). Mobile never gets here (the settings subpages render the same components in `embedded` mode, unchanged).
**The standalone 仓库 view is REMOVED** — repo browsing lives in the 工作台 file tree, add/manage in 设置 › 工作区 + the overview dashboard. Stale `pi-active-view` values pointing at removed views fall back via the `visibleActivityViews` validation.

The panel bodies（W-中收敛后）: 中栏只剩 `WorkspaceSidebar` 的**工作台**会话列表（`PanelHeader`: WorkspaceSwitcher + 总览 + ＋新建会话；「总览」= 开/激活工作区家 tab——`handleShowOverview`，移动端推工作台 overview 栈）。知识库/工作项/Loops 面板退役，住**右坞**（S1/S2/S3）：工作项 = **右坞工作项 tab（2026-09 右坞 S3，`WorkspaceManager` panel 模式：列表→详情面板内推进航，`workItemSplit`/`workItemDetail` 中心顶替与 shell 侧镜像整套退役；门控 = work-items capability；总览工作项按钮/新建 → 开右坞 tab；legacy work-items URL 深链 → 家 tab + 右坞 tab；移动端照旧 = overview 栈 work-items 页）**；知识库 = **右坞知识库 tab（2026-09 右坞 S2，`KnowledgeBrowser` 直挂：chips 选 bundle + FileExplorer + open index.md 提示；门控 = knowledge capability，无 tab 不显示；总览知识库行 → 开右坞 tab；移动端照旧 = overview 栈 knowledge 页；hub knowledge 子视图已退役）**；Loops = **右坞 Loops tab（2026-09 右坞 S1，`LoopsDockPanel`：列表+状态/暂停恢复/停止本轮/「运行」手动起轮 + 配置/新建内联 LoopsConfig 推导航）**；总览 Loops 区块瘦身为摘要行（`onOpenLoopsTab` → 开右坞 tab，点击即达；移动端不传该 prop，保持全量区块）；`loopConfig` 中心顶替已退役（`useAppShellState` 删该状态，移动端本就用自己的 overviewStack）；frontmatter 编辑在 LoopsConfig 配置面，见 Loop 章「Loop 配置面」；STATE.md + workspace git log remain the run observability）。 归档 is `ArchiveModal embedded`. 设置 is `SettingsPanel` (`components/SettingsPanel.tsx`): iOS-settings index → 工作区 / 模型 / Skills / 插件 / 偏好 (theme + language; the former `SettingsBar` is retired). **On desktop the settings index keeps ALL its rows visible permanently (subpages render in the RIGHT column, the index row just highlights — `desktopSplit` in SettingsPanel); the 模型/Skills/插件 rows are HIDDEN there entirely (rail icons are the entry). On mobile (no prop) the rows keep the in-panel subpage navigation, which renders the former modals in `embedded` mode (fill container, own header suppressed); 归档 stays an index row on mobile only (desktop's rail already has the archive icon).** **The 设置 › 工作区 subpage is a desktop CENTER-AREA page (2026-09 搬家：列表+详情都进中央主区，不再拆中栏窄列 + 右栏 portal)**: the center renders PanelHeader 工作区设置 (meta = `workspaceSettingsName` via `onSelectedWorkspaceChange`) over a `WorkspaceManager` in its `split={{ inline: true }}` mode — 左 300px 列表 + 右详情并排，无 manager chrome、无 portal；中栏回到纯设置索引（首页无活动工作区时该行也可见——工作区管理是全局的，hint 显示当前工作区名或「管理全部工作区」）。 偏好 (preferences) renders in the right column too (PanelHeader 偏好; no portal — PreferencesPage is mounted directly). The right-column branch condition is `!isMobile && (configView || (sidebarView === "settings" && settingsPage !== "index"))` — configView wins when both apply. On mobile the subpage stays the single-column `panel`-mode WorkspaceManager in the settings drawer (`panel={isMobile}` — desktop drops `panel` so the rail shows). The remaining `WorkspaceManager` modal is the home create-workspace wizard only.

**Persistence**: module views per workspace (`pi-active-view:<wsId>`), global panels under one `pi-active-panel` key (settings survives workspace switches; archive is transient). Legacy URL views (settings/work-items/loops) map onto panel switches in `applyUrlToTabs` by writing the storage key BEFORE activating the tab (the activeWorkspace effect re-derives `sidebarView` from storage and would clobber an immediate setState); `buildTabQuery` only emits overview/chat.

- **工作台（桌面）** — **2026-09 全局左栏（docs/global-session-sidebar-design.md）：会话区 = 全局分组列表**
  （`HomeSessionGroups`，与首页中栏同体——组头点击=进工作区、会话行 C1 分派跨工作区直达；行 = 共享
  `SessionRow`：Cmd/中键/hover 新 tab、行内归档、完成未读徽章 + 相对时间；不再随 activeWorkspace 换血）。
  头部照旧（WorkspaceSwitcher + 总览 + ＋新建会话）；body 还带不可用工作区行与「导入目录」入口。文件
  section 在右栏「文件」tab（DesktopShell passes `showFilesSection={false}`，即桌面信号）。
- **「文件」tab（右栏，桌面）** — `components/FilesExplorerPanel.tsx`: toolbar = `[ 文件 | 改动(N) ]` segmented switch
  (`pi-explorer-tab:<wsId>`, git repos only — same key the mobile workbench section uses, both surfaces agree) + ⟳ manual refresh
  (bumps a local key stacked onto the shell-driven `explorerRefreshKey`, feeding BOTH `FileExplorer.refreshKey` and `useGitStatus` —
  external deletions/edits have no event, only agent turns auto-refresh at `agent_end`; `FileExplorer`'s refresh effect invalidates the
  WHOLE cached directory subtree under cwd via `invalidateUnderPrefix`). Below: `FileExplorer` (cwd = workspace root) or `ChangesPanel`.
  The Loops panel's reveal signal (`loopFilesReveal`) routes here — DesktopShell activates the「文件」tab and the panel switches its
  segmented back to 文件 on reveal (tree invisible otherwise).
- **工作台（移动端）** — the merged 会话 + Explorer view kept as two stacked collapsible sections (MobileShell renders `WorkspaceSidebar`
  with the default `showFilesSection = true`). Upper **会话** (chevron + label + count header; drag-resizable share with internal scroll
  while 文件 is open — default 40%, adjustable via the `workbench-split-handle` pointer-drag separator between the sections (percent
  persisted per workspace in `pi-workbench-split:<wsId>`, clamped 15–85%, double-click resets to 40%; pointer events +
  `touch-action:none` so touch drags resize instead of scroll) — NOT content-driven, the split stays stable; flexes to fill when 文件 is
  collapsed); lower **文件** is collapsible too and **collapsed by default** — when collapsed only its header bar shows, pinned to the
  panel bottom (`marginTop:auto`), and the `[ 文件 | 改动(N) ]` segmented tabs render only while open. Both sections' collapse state
  persists per workspace in `localStorage` key `pi-workbench-sections:<wsId>` (per-key defaults: 会话 open, 文件 collapsed).
- **知识库** — **only `kind === "knowledge"`** repositories; each is an **OKF (Open Knowledge Format v0.2)** bundle
  (Markdown + YAML frontmatter) browsed via a `FileExplorer` pointed at the repo's registered `path`（路径登记制，通常根级 `<alias>/`，per `workspaceRepositoryPath`）. A newly
  `init`'d bundle is seeded with `index.md` (progressive-disclosure entry), `log.md`, and a `concepts/welcome.md`
  example concept (`lib/workspaces/okf.ts`, `renderOkfSeed`); a `clone`d bundle keeps the remote structure untouched.
  **L0 access is always built-in** — `read`/`ls`/`grep` need no tool. The view has an "open index.md" hint as the L0
  entry point. Ranked retrieval augmentation (`kb_search`) is **opt-in**: the tool is mounted automatically when the
  `knowledge` capability is on, and searches across all active bundles (see "kb_search" below).
- **工作项** — the FULL WorkspaceManager work-item surface (筛选/详情/对话链接/归档)；宿主（右坞 S3 后）：桌面 = 右坞工作项 tab（`embedded + panel` 模式，列表→详情面板内推进航，`key=workspace.id` 挂载）；移动端 = overview 栈 work-items 页（同一 panel 模式）。`panel` mode: manager chrome header hidden — the tab bar/PanelHeader already titles it — rail hidden, single column; rows/toolbars/detail compact below a 480px container query（右坞可拖窄 + 中栏可拖窄两处都受益）. NOTE: same-specificity panel overrides in WorkspaceManager's styled-jsx sheet must stay AFTER the base rules — placed before them the cascade silently reverts them (the original bug: body kept the 280px rail track and the whole pane overflowed the column).

Mobile is a **separate shell with real bottom-tab navigation** (see "Shell split" below): `MobileShell` renders 36px tool strip (`ChatToolbar`, ☰ hidden — the drawer is gone) → SessionTabBar（会话 chips 行，**hidden on the home landing** — the 2026-09 direction-A home redesign keeps workspace entry in HomeLanding itself: the ⊞ workspace bottom sheet + the recent-groups' group headers; homeSession/HomeNewSession views keep the tab row）→ a tab-switched main area → **bottom tab bar (`会话 → 工作台 → 设置`; W-中收敛后知识库/工作项/Loops 底部 tab 退役——入口 = 工作台 tab 的 overview 栈页 overview/loop-config/work-items/knowledge，与桌面家 tab hub 同构；landing on 会话，persisted per workspace under `pi-mobile-tab:<wsId>`，旧存量值 knowledge/work-items/loops 归到 workbench)**. **Wide viewports (≥768px: tablet portrait, phone landscape, unfolded foldables — `useMediaQuery("(min-width: 768px)")`) swap the bottom bar for a left vertical rail (`MobileSideRail`) inside a workspace** — same `tab` state, same `TAB_ORDER`, icon-over-label buttons; the rail is deliberately NOT classed `mobile-bottom-tabbar` so the keyboard layer (which hides the bottom bar while the keyboard is open) leaves it visible. Crossing 768px live-swaps the chrome without losing the active view. Tapping a tab switches the main area; tapping the active tab is a no-op. 会话 = the current chat itself; with no session open it renders the fresh-session composer directly (no placeholder page — and never a pre-created session, pi creates the .jsonl only on first send); picking a session in 工作台 switches to the 会话 tab via the shared `chatFocusKey` signal. The chat stays mounted (hidden via `display:none`) across tab switches so SSE never breaks. Secondary pages use per-tab stacks with ‹返回 PanelHeaders: archive (设置 tab — settings/work-items manage their own in-panel subpages), overview (工作台 tab — 「总览」pushes `WorkspaceOverview`, dropped on tab-leave/workspace-switch; desktop needs no stack, its main area switches views); knowledge-file viewing uses the full-screen file overlay (the old right panel). Home renders full-screen without the tab bar. **Don't reintroduce a drawer or stacked focus views** — a new module gets a tab (register it in `ACTIVITY_VIEW_ORDER` + `TAB_ORDER`/`TAB_CAPABILITY` in MobileShell), not a new overlay. (Collapsible sections *inside* the 工作台 view
are fine — they are view content, not navigation.)

**Shell split (mobile tab refactor):** `AppShell` is a thin dispatcher — `useAppShellState()` (`components/shell/useAppShellState.ts`) owns ALL shared state (workspace tabs, sessions, SSE wiring, panel selection, persistence) and provides it via `components/shell/context.tsx` (`useShell()`); the state layer has **no `isMobile` branches** — cross-shell navigation intents travel as focus signals (`chatFocusKey` bumped by every chat-opening handler, `panelFocus` for the work-items create flow) that only MobileShell reacts to. **The shell choice must be correct in the FIRST HTML response**: `app/page.tsx` (async server component) sniffs the User-Agent into `initialIsMobile` and passes it to `AppShell`, which seeds `useViewportIsMobile(initial)` — the value drives BOTH the SSR render and the hydration render (no mismatch), then a mount effect corrects a wrong UA guess via `decideIsMobile` (`lib/shell-is-mobile.ts`, pure + tested): ① viewport ≤640px → mobile; ② **UA-mobile seed never downgrades** — a phone stays mobile even at a wide CSS viewport (landscape, foldables, remembered zoom-out); ③ touch-only device (`pointer: coarse` and NO `any-pointer: fine`) → mobile, which catches「电脑版网站」mode (it rewrites the UA *and* widens the layout viewport to ~980px — both width and UA go blind, only the pointer media feature survives; this was the 2026-09 "PC 端首页、底部没有 tab" bug). `AppShell` provides the resolved flag via `IsMobileContext`; every `useIsMobile()` caller reads that context (zero per-caller subscriptions, one source of truth) and falls back to a standalone viewport hook only outside the shell tree. Without the server seed phones SSR the desktop shell and flip only after full hydration — seconds on a slow device. **The DATA must be in the first HTML response too (2026-09 方案二 SSR 预取)**: without it the server renders a data-less shell —「尚无工作区」+「加载中」— and the client then jumps TWICE (workspaces arrive → empty groups in letter order; /api/sessions arrives ~400ms cold → activity-ordered filled groups; the session index walk is ~8× slower than the workspaces fetch, holding the real content hostage). `app/page.tsx` now prefetches BOTH in-process — `discoverWorkspaces()` + `buildSessionsPayload()` (shared with `GET /api/sessions` in `lib/session-payload.ts`) — and seeds `useAppShellState({ initialWorkspaces, initialSessions, initialRunningIds })` → `workspacesLoaded`/`useSessionActivity(seed)` start true; the post-hydration refreshes are silent same-data updates. Two guards: the SSR daemon merge uses the DIRECT `daemonClient` (fail-fast — a render must never block on sidecar spawn ≤15s; the API route keeps `daemonProxy()`); and EITHER seed failing (null) falls back to client fetch with **skeleton gating** — `WorkspaceSidebar` (`workspacesLoaded`/`sessionsLoaded` props → `renderGlobalSessionsBody`) renders skeleton rows instead of「尚无工作区」or empty groups, killing the lying empty states on the fallback path too. `DesktopShell.tsx` renders the three-column layout (rail + resizable middle column + center/right columns) migrated verbatim; `MobileShell.tsx` renders the bottom-tab navigation. `ChatToolbar.tsx` is the shared 36px tool strip (theme/language/history/auto-name/branch/system/token stats + dropdown panels) rendered by both shells. Shell-agnostic overlays (home create-workspace wizard, DirectoryPicker, ProjectTrustDialog) render in AppShell for both.

**Mobile keyboard（键盘↔输入框空白修复，双策略分治）：** `useVisualViewportKeyboard`（`hooks/useVisualViewportKeyboard.ts`，AppShell 挂载一次，`pointer: coarse` 门控）是唯一的键盘适配层：可编辑元素聚焦且 visualViewport 比 **`documentElement.clientHeight` 基准**（绝不用 `window.innerHeight` —— iOS 键盘弹出时它也跟着缩；基准只在“前后都不在键盘态”时采样）小 ≥150px 时判为键盘开启，加 `.pi-keyboard-open`，然后按 **`resolveKeyboardStrategy`（`lib/keyboard-layout.ts`，纯函数+测试）分两条路**：

- **native（不接管变形）**：resizes-visual 类内核（Android Chrome/Edge、iOS —— vv 缩而布局视口不缩）。这类内核的键盘 reveal 是【窗口级平移】：浏览器把整页渲染层上提以露出聚焦输入框，该平移发生在 JS 所有可读信号之外（scrollY/vvTop/html rect.top 全读 0 或不可信，2026-09-06 Edge 151 真机截图实测），页面既测不到也撤不掉；若 JS 再压短应用高度，平移不随重排撤回，应用被悬在可视区上方、下方留大段空画布 —— “键盘与输入框之间大片空白”的根因。所以 native 只做两件事：把应用钉在布局视口全高（`--app-height=<live>`，此内核的 100dvh 会随键盘缩，Edge 实测键盘开启时 dvh=535<live 682，放任 dvh 会在可视带下方留画布空带）+ 隐藏底部 tab 栏；不压高、不平移、不锁滚动。注意：这类浏览器（如 Edge 底部地址栏形态）键盘弹出时底部地址栏仍叠在页面与键盘之间（约 126px），网页无法在那里渲染 —— 输入框贴地址栏顶就是网页能做到的极限，想贴键盘只能靠浏览器层（地址栏放顶部 / PWA standalone）。
- **squeeze（压高+平移补偿）**：布局视口自己缩的内核（微信 XWeb 等 resizes-content 但 dvh 不跟随）、无 vv 老内核（innerHeight 随键盘缩）、vk overlaysContent（`navigator.virtualKeyboard` 存在且启用时浏览器完全不管布局，必须自压，键盘真实顶边用 `computeVkKeyboardState` 从 boundingRect 取）。CSS（globals.css）只在 `.pi-keyboard-open.pi-kb-squeeze` 下把 html+body 压到 `--app-height`（正常流，不用 fixed），**reveal 平移补偿**：每帧实测 `-html.getBoundingClientRect().top` 与 `vv.offsetTop` 取 max（同屏平移会在两个信号里重复，求和=双重补偿）设 `--app-lift`，body `translateY(var(--app-lift))` 反向抵消，键盘开启时 `window.scrollTo(0,0)` 锁滚。

配套：应用根（layout.tsx body / MobileShell / DesktopShell）统一 `height: var(--app-vh)` —— `--app-vh` 在 globals.css 上定义（`:root { --app-vh: var(--app-height, 100%) }` + `@supports (height: 100dvh)` 升级为 `var(--app-height, 100dvh)`）。**绝不直接写 `height: var(--app-height, 100dvh)`**：不支持 dvh 的老内核（Windows 微信/企微内置浏览器，Chromium<108）里 var() 的 fallback 在【计算值阶段】整体失效（invalid at computed-value time → height:auto），整条高度链塌成内容高度 —— 输入框悬在半空、下方大片空白（PC 端“键盘位置和底部有非常大间距”的老内核成因）；直写 `100dvh` 是解析期丢弃、能回落到 `html,body{height:100%}`，反而无害，所以用 @supports 分层 + % 回落保证任何内核拿到的都是合法值，hook 写的 --app-height 是纯 px、老触屏内核（X5）同样能压短；`@media (pointer: coarse)` 输入控件 ≥16px（iOS/Android 对 <16px 输入框聚焦会自动放大页面，缩放会持续污染几何信号）；**不设** `interactive-widget` meta —— 键盘适配统一走 JS 路径；双判据（vv 缩了 **或 clientHeight 自己缩了** ≥150px）、无 visualViewport 的老内核回退 innerHeight、聚焦期间及关闭后 1.2s 内 250ms 轮询实测（不少内核键盘/平移不发事件）、**scale 守卫 [0.95, 3]**（zoom-out<0.95 必拦：手机上“电脑版网站”缩放显示时 vv 天然只是布局视口的窗口，gap 恒>0 却没有键盘，不设下界会把应用错误压短；zoom-in 放宽到 3 —— gap 判据本身能区分键盘与放大，且 native pin 的误触发与关闭态高度相同无副作用；收紧到 1.05 会在站点缩放被记住的内核上致盲全部检测，2026-09-06 Edge 真机事故：scale 停在 1.0999 后适配全盲）、URL `?kbdebug=1`（存 localStorage，`?kbdebug=0` 关）在左上角显示实时指标用于真机定位。聊天流式期间的上滑停跟随修复是 PC+手机端的姊妹修复，决策逻辑在 `lib/chat-scroll-follow.ts`（纯逻辑，与 `useAgentSession` 及测试共用同一实现）：**用户上滑判定先于 120px 近底恢复分支**（旧顺序里小幅上滑先撞上“恢复跟随”，下一个流式增量又拽回底部 —— “AI 回复时上滑一点就抖动”）、单事件上滑阈值 0.5px（慢触控板/高刷触屏每帧 delta 常仅 1~4px）、**touchmove 也刷新滚动意图窗口**（否则长按拖动 >1.2s 窗口过期，跟随中途恢复，拖到一半被拽回）、**近底恢复跟随需要佐证**（二轮修复：本就跟随 / 意图新鲜 / scrollTop 在增大，三选一 —— 输入事件覆盖不到的滚动路径【滚动条/最小地图长拖超过 1.2s 意图窗、抬指后 >1.2s 的惯性滚动】会持续产生带内 scroll 事件却无意图佐证，旧逻辑无条件在带内恢复跟随，流式增量贴底与未停稳的上滑逐帧拉锯；“ scrollTop 增大”是安全佐证：allowed=false 期间程序化贴底已被 gate 拦住，增大只能是用户向下滚回）。

**Desktop middle column is drag-resizable.** The width is a CSS var (`--pi-sidebar-width`, default `260px`) set inline on
`.sidebar-container` from the shared `sidebarWidth` state; a thin `.sidebar-resize-handle` strip (sibling of the
container, desktop + open only) drives it via `onMouseDown` window listeners. Width persists in `localStorage`
(`pi-sidebar-width`), clamped `[200, 560]`; double-click the handle resets to 260. Mobile keeps a fixed 280px drawer
(its CSS overrides the var, and the handle isn't rendered). During drag a `sidebar-resizing` class disables the
open/close `width` transition so it tracks the cursor instantly.

**The right file panel is drag-resizable the same way** (`startRightPanelResize` in `useAppShellState`, mirror of the
sidebar resize): a `.right-panel-resize-handle` strip sits BETWEEN the center chat area and the right panel (sibling
BEFORE `.right-panel-container`, rendered only while open). The width is a CSS var (`--pi-right-panel-width`, px) set
inline on the container — **unset → the CSS `42%` default** (`rightPanelWidth: number | null`; null means default).
Drag persists the px in `localStorage` (`pi-right-panel-width`), clamped `[300, window.innerWidth - 620]` (the chat
area keeps ≥620px; a CSS `max-width: calc(100vw - 620px)` guards windows shrunk AFTER a wide drag); double-click the
handle resets to the 42% default (removes the key). During drag a `right-panel-resizing` class on the container
disables the transition; the handle itself gets `right-panel-resize-active` from JS for the accent highlight (the
handle precedes the container, so no sibling selector can reach it).

### Work Items (`lib/work-items/`)

File-backed **Requirements (`REQ-####`)** and **Bugs (`BUG-####`)**. Storage under
`<workspace>/.pi/work-items/<requirements|bugs>/<KEY>-<slug>/`（2026-09 布局，`lib/work-items/service.ts` 的
`workItemRoot`；旧根级 requirements//bugs/ 目录已由 migrate-workspace-layout.mjs 收进 .pi/）:

- `item.yaml` — structured metadata (status/phase/priority/repositories/conversations/… + optional top-level `loop?: string` kit-loop binding by loop NAME, S1 soft validation — existence NOT checked; protocol semantics in `kit/README.md` 工作项绑定一节), `schemaVersion 1`.
- `README.md` — human body. **Original Description is preserved verbatim**; later analysis is appended, never overwriting it.
- `events.jsonl` — **append-only** timeline (id/at/type/actor/optional conversationId/data). Never rewrite it.

Key behavior:
- `listWorkItems()` reads ONLY `item.yaml` per directory (README/events are detail payloads — reading them here was the list hotspot) and returns `{ items, archivedItems, invalid }` in ONE pass — the sidebar's active+archived fetches and external-source sync scripts' dedup scans (active ∪ archived) both consume this single result.
- The `KEY` counter lives in `manifest.work_items.next{Requirement,Bug}Number` and is incremented under the workspace
  write lock (`reserveWorkItemKey`).
- Updates take `expectedRevision` (optimistic concurrency); appending a milestone via `recordWorkItemMilestone` does
  **not** bump the revision.
- The pi extension (`work-items/extension.ts`) registers `workspace_list_work_items`, `workspace_get_work_item`,
  `workspace_create_work_item`, `workspace_update_work_item`, `workspace_record_milestone`. create/update **透传可选 `loop` 绑定字段**（string；update 接受 null 清除——S1，软校验：存 loop 名、不验存在性，未命中按未绑定处理）。UI 入口 = 详情「Loop」下拉（WorkspaceManager，空=未绑定）。
- **来源展示**: items carrying `external` (外部源脚本经 HTTP API 盖章) render their provenance — 详情「来源」行（禅道 #id ↗ + 最近同步时间）+ 列表 KEY 旁「禅道」小徽章（`source-labels.ts` 的标签映射；手动创建的项无此字段，不加徽章）。
- **附件（attachments）**: `addWorkItemAttachments`（service.ts）把上传文件落 `<item>/attachments/`（basename 剥离路径、去控制字符、磁盘/批内重名自动 `-1` 后缀，中文名保留）并在 README 维护单个 `## 附件` 小节（图片 `![]()`、其余 `[]()`，目标 URL 编码，重复引用不追加；README 变更时与 content 更新同构地 bump revision）。事件类型 `work_item.attachment_added`（data.files）。路由 `POST …/work-items/[key]/attachments`（multipart `files`，限额同 /api/files：单文件 25MB / 总 100MB）；创建表单（WorkspaceManager）在创建成功后上传，失败不静默丢——报错并保留已建工作项。详情页 `MarkdownBody cwd` 直接渲染这些相对引用（与外部源脚本同机制）。
- **Archive cascade** (`lib/archive-cascade.ts`): archiving a work item tucks its conversations into the session
  archive **only if no other active work item references them**; restoring brings them back. Sessions are physically
  moved to a `.archived/` subdirectory (`lib/session-archive.ts`) so `SessionManager.listAll()` no longer sees them.

### Loop（pi-loop kit；`lib/daemon/loop-spawner.ts` + `packages/pi-loop/` + `kit/`）

**Loop = 文件协议 + 心跳。** v3 引擎（orchestrator session / seeder / RUNS.jsonl / gate 机器）已拆除
（设计：`docs/pi-loop-kit-design.md`；宿主层修订——beat/补跑/锁/D13——见 `docs/pi-loop-host-design.md`）。现行形态：

- **声明**：workspace 根 `.pi/loops/<name>/LOOP.md` 存在即 loop（frontmatter：cron/timezone/level/max_minutes/pattern）；
  `PAUSED` 标记文件停单 loop，根 `.pi/loop/pause-all` 全停。无 capability、无 manifest 字段。`GET /api/workspaces/[id]/loops`
  返回全量状态（`collectStatus`，含 paused——管理面全量；纯 fs，导入 `packages/pi-loop/status.ts.ts`，无 daemon 依赖），消费方自行
  过滤 paused（D11 门控语义：暂停即不存在）——工作项「开始对话/收养续跑」按钮的门控与 Overview Loops 区块都读它。
- **pi-loop 包**（`packages/pi-loop/`，npm workspaces 成员，独立 package.json 备发布；pi-web 以相对路径导入，不经 node_modules 链接——H5 的 Next server bundle 符号链接摩擦）：loop 宿主的**纯逻辑层 + CLI**——
  protocol/cron/due/round-lock/contract/reap/fire 全是纯函数，daemon spawner 与 beat CLI 共用同一实现（无双实现）。
- **心跳宿主有二，可并存**：① 本地 pi-web daemon 的 `LoopKitSpawner`（DaemonJob `loop-kit-heartbeats`，30s tick，
  **无条件注册，无旗子**）扫已注册 workspace；② **`pi-loop beat`** —— 一次性幂等进程（发现 → 补跑判定 → 锁 → 起轮 →
  退出），无 pi-web 的 standalone 仓库挂进任意外部 cron 即获心跳（crontab `* * * * * pi-loop beat --root <path>`）。
  fire 序列统一（`packages/pi-loop/fire.ts.ts`）：acquire `.round.lock` → 锁内复查 `.lastrun` 判定 → 写 `.lastrun` → 起轮 →
  finally release —— **双宿主并存安全**（daemon 轮的锁写 `kind: "daemon"` + sessionId，beat 看到即跳过，反之亦然）。
  到点 → `startRpcSession` 起一次性会话（cwd=workspace 根 → workspace 装配照常），命名 `<loop> · <slot>`，
  开场合同 = LOOP.md 正文 + spawner 注入的硬规则 + `/skill:<pattern>` 展开；
  `max_minutes` 超时 → destroy + `packages/pi-loop/reap.ts.ts` cwd 收敛收割。
- **补跑语义（anacron-lite）**：fire 判定 = `now >= nextDue(cron, tz, .lastrun)`——宿主睡眠/停机错过的槽位恢复后
  至多**补一轮**（旧分钟槽语义是静默丢失；A 轮在跑也不再丢 B 的槽，`.lastrun` per-loop）。`.lastrun` / `.round.lock`
  是宿主文件，agent 禁改禁删（与 `PAUSED` 同级，写进协议条款与开场合同）。
- **运行状态**：只有 `STATE.md`（记忆脊柱：Last run / 优先级分区 / [BUDGET] / 复盘节）+ `.pi/loops/<name>/loop-ledger.json`（断路器，
  **per-loop**：`.pi/loops/<name>/loop-ledger.json`，D13 修订——断路计数跨 loop 混算无意义）+ workspace git log。
  宪法文件（LOOP.md 的 level/cron、`.pi/loop/constraints.md`、`.pi/loop/budget.md`）agent 一律禁改；constraints/budget 维持
  根共享（budget 是全 workspace 总帽）。
- **事后钩子（D9）**：轮结束（成功与失败路径都跑）扫工作项 events.jsonl 的 conversationId 回填 conversations；
  无待决 `loop.gate` 里程碑 → 自动归档轮会话（会话列表防污染；有待决 gate 的留在列表供人在 composer 答复）。
  （beat 轮无此钩子——standalone 根没有 work-items 域工具；轮会话自然沉淀为普通 pi 会话。）
- **run-contract**：工作项「开始对话/收养续跑」= 客户端预填（D11，无 daemon seed 路由）——`handleRunContract` in
  `useAppShellState` reads the workspace's kit loops (`GET /api/workspaces/[id]/loops`) and resolves the pattern via
  `resolveContractPattern`（`lib/loops/contract-prefill.ts`：绑定名命中 → 该 loop 的 pattern；paused = 不存在；未命中/未绑定
  且恰有 1 个 active loop → 该 loop；≥2 个 active loop → undefined 不猜——可能存在不消费工作项的 loop，盲取首个会误路由，
  调用方降级为裸 prompt，精确路由靠工作项的显式绑定）, writes `/skill:<pattern> 执行|收养 <KEY>` into the new-session draft (`setDraft("new:<wsPath>")`), bumps
  `composerEpoch` (ChatWindow keys its ChatInput mount on it so an already-mounted composer re-reads the draft) and switches to the
  fresh chat view — nothing is sent or created until the human presses send. The buttons' visibility gate in
  WorkspaceManager is kit-loops-driven (`hasKitLoops`, fetched once per selected workspace), not capability-driven.
  「继续对话」 = open the latest conversation as a chat tab (the skill is already in its context).
- **工作项绑定 + 管理面**（协议语义落文：`kit/README.md` 工作项绑定一节）：工作项可声明 `loop: <loop名>` 绑定（S1 软校验，
  两个 LLM 工具透传）；**绑定 = 路由收窄**——loop 轮拾取候选 = 「绑给我的项 + 未绑定项」，未命中/已删 loop 的绑定按未绑定
  处理；SKILL.md 的选择段声明该过滤语义（候选 = 绑定项 ∪ 未绑定项）。管理面：
  ① 工作项「立即跑一轮」（B 按钮，`lib/loops/rounds.ts` `launchManualRound`）走 `POST …/loops/[name]/run`——web 进程
  import pi-loop 纯逻辑组装开场合同，经**现有 daemon 会话面**起轮（`POST /v1/sessions` 两步建会话：sessionId 要进
  开场合同第 3 条；无 daemon 新路由）；可选 `itemKey` → 合同追加「本轮优先处理 <KEY>」。手动轮**无 D9 自动归档**
  （人在场），锁**保持持有**靠 stale 窗（maxMinutes+15min）兜底回收，至多丢一个后续心跳槽（anacron-lite 不放大）；
  轮收尾后锁在 stale 窗内仍是「假运行中」（按钮禁用 + 409 误报 + 心跳槽被吃）——run/stop 路由注入
  `runningSessionIds` 做**幽灵锁活性接管**（`isPhantomRoundLock`：daemon 锁带 sessionId、锁龄过
  `PHANTOM_LOCK_GRACE_MS` 2min 宽限、且不在 daemon running set → 证明轮已死，清锁重取/直接停；beat 锁与
  启动窗口锁不判，探测失败保守不接管），假窗口从最长 maxMinutes+15min 收窄到分钟级；LoopRow 按钮
  disabled 有视觉（opacity+cursor），不再「能点但没反应」。
  ② 停止 = `POST …/loops/[name]/stop`（`stopRound`）：daemon 持有 → `DELETE /v1/sessions/:id` + 包内 reap + 释放锁
  （下轮可立即补跑）；beat 持有 → 409 提示走 `pi-loop stop`（web 不代杀本机 beat 进程）。③ frontmatter 编辑 =
  `PATCH …/loops/[name]`（「人的手」：仅 cron/timezone/level/max_minutes 四字段，frontmatter 重序列化、正文 byte 保留；
  cron 改后下一心跳自然生效，`.lastrun` 保留、next-due 按新 cron 重算）。④ Overview Loops 区块（常驻，无 loop 空态 +
  新建入口）：状态总览（cron 人话摘要 `summarizeCron`）/ 暂停恢复（写删 PAUSED）/ 停止本轮；配置/新建走下条。
- **Loop 配置面（2026-09；右坞 S1 修订）**：`components/LoopsConfig.tsx` —— 每个工作区的 loop 管理/创作 UI。
  桌面：Loops 管理/创作全部住**右坞 Loops tab**（`LoopsDockPanel`，常驻渲染无 loop 空态+新建入口；「配置」/「新建」
  在 tab 内推入 LoopsConfig，‹ 返回列表；`loopConfig` 中心顶替与 `useAppShellState` 里的同名状态已退役）；
  总览区块瘦身为摘要行（计数+运行态+→）。移动端：照旧——总览全量区块「配置/新建」推工作台 tab 的 overview 栈。能力：创建向导（`pi-loop init`
  脚手架）、frontmatter 编辑（区块内联表单已迁入）、LOOP.md 指针正文编辑（frontmatter 字节保留）、
  知识文档编辑（任意命名，白名单）、根级宪法编辑（缺失预填模板）、STATE.md 只读、删除（锁活 409 /
  绑定项二次确认 / SKILL 与宪法不删）。**不编辑 SKILL.md**。服务端逻辑全在 `lib/loops/manage.ts`
  （唯一 PUT 写入口 + 文件名白名单 + mtime 乐观并发 + 原子写），路由薄壳
  （`POST /loops`、`GET|PUT /loops/[name]/docs`、`DELETE /loops/[name]`）。
- **工作项工具**新增 `loop` 绑定透传（见上）；外部源同步已下放工作区脚本（见「外部源适配」节）；subagent 一律走社区 `@henryqw/pi-subagent` 包（全局挂载，见下节——kit 轮会话 cwd=workspace 根，包自动发现 `<cwd>/.pi/agents/pi-subagent/` 角色，无需 per-session 注入）。
- **模板**：`kit/templates/basic/{loop,root,skill}/`（D13 布局：LOOP/STATE/ledger 在 `loop/`，constraints/budget 在
  `root/`，SKILL.md 骨架在 `skill/`（spec §4）；`pi-loop init` 由此脚手架；LOOP.md 指针含「本目录说明文件」步骤——人写
  知识文档约定，如 chandao.md/selection.md，agent 只读、改知识不改 SKILL）、`kit/templates/github/loop.yml`
  （Actions 场景）；`kit/README.md` 是协议契约（含 L1/L2/L3 分级、宿主/beat 用法与调参指引）。

**轮会话是一次性普通会话**：跑完一轮自然 settle，无状态恢复问题（崩溃 → 下轮冷启动读 STATE.md 接续）；v3 的
双开 guard / `loop.active_session` 戳 / 僵尸收割在「每轮短进程」模型下天然消失。
### Subagent (community `@henryqw/pi-subagent`)

**Real isolated pi child processes.** The `delegate_task` tool comes from the community package
`@henryqw/pi-subagent` (npm `file:` pin at `../pi-subagent-upstream/henryqw-pi-subagent-7.1.0.tgz` — a packed tarball of the local A2-enhanced
branch `feat/project-roles-and-child-sessions` @ b2007f4, adding project-level roles + persisted child sessions; a tgz snapshot is immutable and
reproducible where a `file:` directory pin would live-track the upstream tree — swap to the npm version once the upstream PR merges). The built-in `lib/subagent/` is DELETED
(A3 switch; the former in-process child sessions, worker/agents/registry modules are gone with it).

- **Host adapter** (`lib/daemon/pi-subagent-host.ts`, daemon-only): jiti-imports the package's extension entry
  (`extensions/subagent.ts`, not exposed via its `exports` map) and wraps its default factory as an `InlineExtension`.
  Because the package's ephemeral executor only runs inside "the pi CLI" (`PI_CODING_AGENT=true` + process title
  `pi`/`pi-rpc` + `argv[1]` as the re-invoked entry), the adapter presents that identity and points `argv[1]` at
  `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` — each delegation spawns
  `node <pi-cli> --mode json -p …`, a real pi process of the SAME version sharing `~/.pi/agent` settings/auth.
- **Always global**: `lib/daemon/rpc-manager.ts` awaits `piSubagentExtension()` for **every** session regardless of
  workspace. Still intentionally NOT in `WORKSPACE_EXTENSION_FACTORIES` or `ALL_WORKSPACE_CAPABILITIES`.
- **Roles** (package discovery, precedence built-in < project < user): built-in `implementer`/`reviewer`;
  **project roles from `<cwd>/.pi/agents/pi-subagent/*.md`** (trust-gated by `ctx.isProjectTrusted()` — `.pi/agents`
  is NOT a trust-requiring resource for pi's SDK, so plain workspaces are trusted by default, matching the old
  no-gate posture for user-owned `~/.pi/workspaces/**`); user roles from `~/.pi/agent/config/pi-subagent/*.md`.
  ⚠️ The old `<ws>/.pi/agents/*.md` layout is NOT read — workspace roles must move into the `pi-subagent/`
  subdirectory AND add the now-mandatory `tools:`/`extensions:`/`skills:` frontmatter arrays (legacy files fail
  parse loudly — see `lib/daemon/pi-subagent-roles.test.mjs`). No `model:` key; models come from task profiles.
- **Task models**: delegation requires `~/.pi/agent/config/pi-task-models.json` mapping `fast`/`balanced` (etc.)
  profiles to concrete models — without it the tool errors with "Run /task-models". This machine maps them to
  `zai-coding-cn/glm-5.3`.
- **Timeouts (kill semantics — philosophy differs from the old built-in)**: idle deadline (30 min) SIGTERMs a child
  with no recognized pi events; max runtime (120 min) SIGKILLs. Output-producing builds renew the idle deadline
  (`bash_execution_update` counts), but a TOTALLY silent build is killed — the old built-in never aborted one.
  Configured via the explicit policy in `pi-subagent-host.ts` (wins over
  `~/.pi/agent/config/pi-subagent/pi-subagent.json`); cap/max concurrency via `PI_SUBAGENT_MAX_SUBAGENTS` env or
  `maxSubagents` in that config.
- **Child sessions** persist BY DEFAULT with parent-generated ids `pi-subagent-<uuid>` + names `pi-subagent <role>`
  (file `<ts>_pi-subagent-<uuid>.jsonl` under the cwd's session dir; opt-out per role `persist: false` / globally
  `childSessions: false`). `lib/subagent-child.ts` tags them `subagentChild: true` in `GET /api/sessions` by that
  id/name prefix — the old append-only `~/.pi/agent/subagent-children.txt` registry is retired. They are separate
  OS processes, NOT daemon-registry sessions: no live SSE from the daemon, no `parentSession` link, and their file
  operations never appear in the parent stream (only capped summaries do — `SessionChangedFiles` no longer counts
  subagent-touched files).
- **Result shape** (MessageView `delegate_task` panel): `details.entries[]` with `{role, status, summary, model,
  thinkingLevel, session: {id, cwd}}` — the `open →` jump uses `session.id` (the old `childSessionId` field is gone).
- **Orphan reaping**: `reapOrphanedRoundProcesses` matches `node` children of the daemon scoped by workspace cwd —
  package children ARE covered on loop abort/timeout (intended cleanup).
### Git & Changes (`lib/git-changes.ts`, `lib/git-status.ts`, `lib/git-discover.ts`)

- `getGitStatus(cwd)`: walks the tree once (`git-discover.ts`) to find **every** nested repo root, queries each, and
  builds per-repo `RepoGroup[]` (the cwd-enclosing repo, scoped to cwd, first; then nested repos by relative path).
  Nested-repo boundary entries reported by a parent are deduped against the nested repo's own group. Returns groups +
  grand `additions`/`deletions` totals.
- `getGitFileDiff(cwd, filePath)`: resolves the repo from the **file's** location, builds a unified patch (synthesized
  "new file" patch for untracked; `git diff HEAD` otherwise; respects rename pairs).
- APIs: `GET /api/git/status?cwd=`, `GET /api/git/diff?cwd=&path=` — guarded by the file-access allow-list. Polled by
  `hooks/useGitStatus.ts`; rendered by `components/ChangesPanel.tsx` — **always grouped by repository** (even a
  single dirty repo gets a named group header with file count + +/- subtotal; the cwd-enclosing repo group defaults to
  expanded, nested repo groups to collapsed; only clean repos produce no group). The Changes list surfaces via the
  `[ 文件 | 改动(N) ]` segmented switch in ONE of two homes (both persist the choice in `localStorage` key `pi-explorer-tab:<wsId>`,
  so desktop and mobile agree): the desktop right panel's pinned「文件」tab toolbar (`FilesExplorerPanel`), or the mobile workbench
  文件 section header — both follow the Explorer's current cwd scope; `ChangesPanel` itself is unchanged.
  Non-git directories hide the "改动" segment. `SessionSidebar` keeps its own standalone Changes section.

### 外部源适配 = 工作区脚本（importer 已退役）

**pi-web 不再内置 importer**：`lib/work-items/importers/`、`app/api/workspaces/[id]/importers/**`、`components/ImporterConfig.tsx`、daemon 的 `ImporterScheduler`/`/v1/importers/sync` 路由及 `requirement-sources` capability 已全部删除（strangler 计划；capability 照 `overview`/`loop` 先例退役——读路径剥离，新写入 400）。外部需求/bug 源（禅道等）的同步 = **工作区自己的脚本**，参考实例 cxin（cxin-workspace 仓内）`scripts/chandao-sync.py`（凭据 `.pi/chandao.json`）：纯 stdlib、凭据存工作区本地（0600 且 gitignored）、日志不打印密码/token，由工作区自己的 cron/loop 触发；脚本直接调 pi-web HTTP API 创建/更新工作项，`external: {source, sourceId, ...}` 章即去重键（重新同步同一条不重复建项），LLM 工作项工具不透传该字段。同步摘要语义（脚本层继承自原 runner 约定）：单条 item 失败不中断同步（failed[] 记录）；结构性失败（登录失败/API 不可达/凭据缺失）退出码 2；已存在未归档项不盖 `imported` 里程碑（防 events 洪水，REQ-0012 教训），仅在摘要计数 synced。工作项的「来源」展示（`lib/work-items/source-labels.ts` 标签映射）保持不变。

### Dev Loop (pi-loop kit 实例；reference: cxin-workspace)

**Loops are per-workspace file protocols — pi-web ships no loop engine.** The generic surface is the kit spawner
(`lib/daemon/loop-spawner.ts`) + the `kit/` template library; every loop's behavior lives in its workspace
(`.pi/loops/<name>/LOOP.md` declaration + `STATE.md` spine + root constitution files + `.pi/skills/<pattern>/SKILL.md`
contract + `.pi/agents/*.md` roles). There is no loop authoring UI and no dev-loop code path in pi-web; cxin-workspace's
v3 leftovers (`loop.yaml`/`RUNS.jsonl`/`LEARN.jsonl`, v1/v2 baks) stay in place unread — git history is the audit
(design §8.7: no migration, no deletion).

The **dev Loop** is the R&D loop pattern deployed in cxin (cxin-workspace), migrated to kit form (v3 history:
`docs/dev-loop-v3-design.md`, retired 2026-09). One heartbeat = ONE round session doing selection AND execution:

- **SKILL.md contract** (`.pi/skills/dev-loop/SKILL.md`): opening triple judgment (predictedConf immutable /
  verifiable / riskTier) + evidence pack + thin-SPEC write-through for pure-display items; hard invariants — L0
  branch/merge discipline plus orchestration bounds **N1 maker≠checker, N2 full gate exactly once before merge, N3
  never split across coupling points**; the **dispatch plan** as an explicit artifact (`loop.dispatch{steps[]}`
  milestone; illegal plans are re-composed, bounded); recovery = resume from dispatch plan + milestone gaps
  ("most mature artifact"). Gates: stamp `loop.gate{kind,question}` (via `workspace_record_milestone`) *before*
  asking, then end the turn — the human answers in the composer (also the UI's 待-decision audit signal).
- **Roles** (`.pi/agents/*.md`, injected per-session via `extraAgentDirs`, no approval gate): **brainstorm**
  (全链路 trace + 反证, produces `SPEC.md` = what-contract + task DAG), **writing-plans** (optional plan step for
  multi-task/sensitive items), **implementer** (TDD maker, one per task, worktree-isolated, draft branches only —
  human merges), **checker** (single check seat, review-then-run, rework list routed by source
  code/plan/spec), **learner** (knowledge consolidator, see Learn below).
- **Run state**: `STATE.md` (High Priority / Watch List / Recent Noise / [BUDGET] / Post-run critique) +
  `.pi/loops/<name>/loop-ledger.json` breaker (same error digest ×3 or >3 attempts on one item → escalated). Constitution
  (`.pi/loop/constraints.md` path blacklist + discipline, `.pi/loop/budget.md` caps) is root-level shared by all loops of the
  workspace (D13) and agent-immutable.
- **API**: the pi-web loop surface is `GET /api/workspaces/[id]/loops`（全量状态）+ per-loop `run|pause|resume|stop` / frontmatter `PATCH`（`lib/loops/`，见 Loop 章——全部经现有 daemon 会话面，daemon 无 loop 路由）。
  standalone 宿主用 `pi-loop` CLI（beat/run/stop/status/init）。

### Learn (archive inline; consolidation via the `learner` agent)

**Qualitative knowledge transfer via consolidation, not per-run archiving.** Knowledge lives ONLY in KB `learnings/` notes, kept sharp by merging; run records are archives nothing reads for decisions.

- **Learn step** (terminal; idle runs excluded): the round session ① writes `.pi/loops/<name>/LEARN/<run-id>.md` — a human-browsable archive (lesson candidate, learner's disposition, index fields incl. **both** `predictedConf` and `tracedConf` so the calibration chain closes; idempotent replace) and ② dispatches the **`learner`** only if a candidate exists. **`LEARN.jsonl` is retired/frozen** in place (its old `humanDecision` narrative was the "summarizing the run" failure mode).
- **learner = consolidator**: two-question generalization test — (1) is it still a rule with specifics deleted? (2) is it an instance of an existing rule (`kb_search`)? Then: merge-and-sharpen into an existing loop-owned note (abstraction lift **allowed but must stay instance-anchored**; trigger scenario inlined into the note's instance section) OR open a new file referencing near-kin. **`contentHash`** frontmatter guards against overwriting human edits — mismatch ⇒ the note is human-authoritative, degrade to new-file+reference.
- **Single home**: everything loop-written goes to `learnings/` (module traps too, with strong module tags); `standards/*` is **purely human-maintained** (the old "loop append" clause is gone — it had no executor). One note touched/created per run max.
- **Three artifacts, three purposes**: KB `learnings/*.md` = consolidated generalizable rules (loop-maintained via hash guard); `standards/*` = human-maintained; `.pi/loops/<name>/LEARN/<KEY>-<date>.md` = per-execution archive (nothing parses it; the SKILL opening may `ls -t` it for calibration).
### cxin reference (研发 Loop target workspace)

- **dev Loop instance**: `/Users/qiancheng/Documents/Workspace/cxin/`（2026-09 由 pi 托管的 workspace-c
  拆解搬入并退役，外部路径导入，workspace id 沿用 01KYRBBY917PW4X0VHMY5GC8TE）in **kit form**: `.pi/loops/dev-loop/LOOP.md`
  (kit frontmatter; cron `*/30 9-22 * * 1-5` Asia/Shanghai; **L2** — migration exception, dev-loop 已在 v3 真实运行多月视为已过
  L1 验证；全新 loop 一律 L1 起步), `STATE.md` spine, root-level `.pi/loop/constraints.md` / `.pi/loop/budget.md` / `.pi/loops/<name>/loop-ledger.json`
  (shared per D13), contract in `.pi/skills/dev-loop/SKILL.md`（六点改造：选择/执行合并为一轮、gate 里程碑由**轮自己**盖、
  双开 guard / `loop.active_session` 戳删除）, five roles in `.pi/agents/pi-subagent/` (community-package discovery: `.pi/agents` is not trust-gating, but files must live in the `pi-subagent/` subdir with the mandatory `tools:`/`extensions:`/`skills:` frontmatter arrays — see Subagent below). v3 leftovers (`loop.yaml`, `RUNS.jsonl`,
  `LEARN.jsonl`, v1/v2 baks) stay in place unread. Sensitive module list + module→repo map:
  `cargo-knowledge/standards/dev-loop-modules.md`; consolidated process lessons in `cargo-knowledge/learnings/`
  (contentHash'd).
- **Host wiring**: the daemon's job registry (`lib/daemon/jobs.ts`) registers `LoopKitSpawner` (`loop-kit-heartbeats`,
  unconditional). None runs in the web server (`instrumentation.ts` untouched).

### Workspace directory layout (reference)

**2026-09 一套约定：pi 机制与数据统一收在工作区根的 `.pi/` 下（`packages/pi-loop/paths.ts` 是路径唯一源）；
工作区根留人的内容** —— 代码仓/知识库是根下的普通目录，由 manifest 按相对路径登记
（`repositories[].path`，`repositories/<kind>/<alias>` 固定布局已废除；`AddWorkspaceRepositoryInput.mode`
含 `register` 用于登记已有目录）。工作区可以是任意外部路径（index 条目直接指过去，如
`/Users/qiancheng/Documents/Workspace/cxin-workspace`），不必住在 workspaces 目录下。

Default locations are under `~/.pi` — but local dev can relocate the whole data home INTO the repo via
`scripts/adopt-pi-home.mjs` + `.env.local` (see "Local pi data home" under Key Design Decisions): `agent/` and
`workspaces/` then live at `<repo>/.pi/`, the global index becomes `<repo>/.pi/workspace-index.yaml` (renamed —
`.pi/workspace.yaml` in this repo is the pi-web workspace MANIFEST), and `.pi/agent` + `.pi/workspaces` are
strictly gitignored / tsc+eslint excluded / pruned by git-discovery.

```
~/.pi/
  workspace.yaml                         global workspace index
  workspaces/                            ($PI_WORKSPACES_DIR; 2026-09 起工作区也可以是任意外部路径)
    workspace-<slug>/                    （或任意外部路径的工作区根）
      AGENTS.md                          （永远在根：pi 从 cwd 根注入）
      .pi/workspace.yaml                 manifest（repositories[].path = 仓库相对路径）
      .pi/work-items/{requirements,bugs,designs,plans}/
                                         work items: <KEY>-<slug>/{item.yaml, README.md, events.jsonl, attachments/}
      .pi/skills/<pattern>/SKILL.md      项目技能合同（pi 原生发现 <cwd>/.pi/skills/；旧 .agents/skills/ 已迁移）
      .pi/loops/<name>/{LOOP.md, STATE.md, loop-ledger.json, .lastrun, .round.lock, [PAUSED], LEARN/}
                                         kit loop declaration + memory spine (D5 文件即声明)
      .pi/loop/{constraints.md, budget.md, pause-all}
                                         根级共享宪法 + 全局停机旗（原根级 loop-constraints/loop-budget/loop-pause-all）
      .pi/agents/pi-subagent/*.md        subagent 项目角色；.pi/cache/ 可重建缓存
      <alias>/                           代码仓 / 知识库（根级目录，路径登记；各自独立 git）
      docs/ scripts/ …                   人的内容
    .pi/workspace-templates/<id>/        custom templates (template.yaml + seed/)
  agent/                                 (~/.pi/agent)
    sessions/<encoded-cwd>/*.jsonl
    agents/*.md                          legacy built-in subagent agents (retired; see lib/subagent-child.ts)
    config/pi-subagent/pi-subagent.json  community subagent config (effective keys: maxSubagents / childSessions — timeouts are pinned in pi-subagent-host.ts)
    config/pi-subagent/*.md               community subagent user-level roles (frontmatter: name/description/tools/extensions/skills)
    config/pi-task-models.json           task-model profiles required by delegate_task
```

---

## File Map

```
scripts/
  adopt-pi-home.mjs               one-time migration of ~/.pi into <repo>/.pi (moves data, rewrites absolute-path
                                   references — index entries / encoded session dir names / .jsonl cwd+parentSession —
                                   writes .env.local, patches shell rc; idempotent repair mode)

bin/
  load-env-local.js                dotenv-lite .env.local loader used by pi-daemon at boot (never overrides
                                   existing process env; missing file = no-op)

app/api/
  sessions/route.ts                      GET  list all sessions (grouped by project/worktree root)
  sessions/[id]/route.ts                 GET/PATCH/DELETE session
  sessions/[id]/context/route.ts         GET ?leafId= — context for a specific leaf (tail-windowed via ?tail=)
  sessions/[id]/earlier/route.ts         GET ?before=&limit=&leafId= — older-messages page for tail-first loading
  sessions/[id]/export/route.ts          GET exported HTML for a session
  sessions/[id]/state|archive|restore|locate|auto-name/route.ts   session lifecycle helpers
  sessions/[id]/entries/[entryId]/thinking/route.ts               GET a thinking block
  agent/new/route.ts                     POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts                    GET state | POST any command
  agent/[id]/events/route.ts             GET SSE stream
  agent/[id]/bash-output/route.ts        GET bash output for a tool call
  agent/running/events/route.ts          GET SSE stream of currently-running session ids
  workspaces/route.ts                    GET list+templates | POST create/import a workspace | PATCH { order: [ids] } 手动排序（索引 sortOrder 重编，一次写；不碰 manifest/git）
  workspaces/[id]/route.ts               GET | PATCH (capabilities/name/skills/disabled) | DELETE
  workspaces/[id]/repositories/route.ts  GET | POST add(clone/init) | DELETE soft-remove | PATCH restore
  workspaces/[id]/work-items/route.ts            GET list | POST create
  workspaces/[id]/work-items/[key]/route.ts      GET | PATCH (revision-safe) | DELETE trash
  workspaces/[id]/work-items/[key]/events/route.ts   POST record milestone
  workspaces/[id]/work-items/[key]/attachments/route.ts  POST multipart attachments upload（service.addWorkItemAttachments：attachments/ 落盘 + README「## 附件」小节 + attachment_added 事件）
  workspaces/[id]/work-items/[key]/content/route.ts  PUT update README body
  workspaces/[id]/loops/route.ts                  GET kit loops 全量状态（collectStatus：frontmatter 摘要 + .lastrun/next-due/锁活性/paused，含 paused，管理面全量；web spec §5.1；D5 文件即声明 — no capability）| POST 创建（initLoop 脚手架）
  workspaces/[id]/loops/[name]/route.ts           PATCH frontmatter 四字段（cron/timezone/level/max_minutes）round-trip — 正文 byte 保留（「人的手」，S5；纯逻辑 pi-loop/frontmatter.ts，tmp+rename 原子写）| DELETE 删除（锁活/绑定守卫）
  workspaces/[id]/loops/[name]/run/route.ts       POST 立即跑一轮（launchManualRound，可选 itemKey → 合同追加优先项；返回 sessionId 供 UI 打开轮会话 tab）
  workspaces/[id]/loops/[name]/pause/route.ts     POST 写 PAUSED 标记（幂等；在跑轮靠开场合同规则 6 合作收尾）
  workspaces/[id]/loops/[name]/resume/route.ts    POST 删 PAUSED 标记（幂等）
  workspaces/[id]/loops/[name]/stop/route.ts      POST 终止本轮（daemon 持有 → destroy+reap+释放锁；beat 持有 → 409 提示走 pi-loop stop）
  workspaces/[id]/loops/[name]/docs/route.ts      GET 配置面板数据包 | PUT 唯一写入口（doc|body|constitution，mtime 乐观并发）
  git/status/route.ts                    GET ?cwd= — per-repo changed files + totals
  git/diff/route.ts                      GET ?cwd=&path= — unified patch for one file
  auth/all-providers|providers/route.ts  GET provider lists (OAuth)
  auth/api-key/[provider]/route.ts       GET/POST/DELETE API-key status/storage
  auth/login/[provider]/route.ts         GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts        POST OAuth logout
  cwd/validate|browse/route.ts           POST validate/select | browse a cwd
  default-cwd/route.ts                   POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts               GET file contents for viewer
  file-index/route.ts                    GET per-repo ls-files + scattered files for fuzzy open
  health/route.ts                        GET server health
  home/route.ts                          GET user home directory
  models/route.ts                        GET { models, modelList, defaultModel }
  models-config/route.ts                 GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog|discover|test/route.ts  pricing presets / upstream discovery / test
  plugins/route.ts                       GET/POST package plugin management
  project-trust/route.ts                 GET/POST untrusted-project extension gating
  skills/route.ts                        GET/PATCH loaded skills and disable-model-invocation
  skills/install|update|search|check/route.ts  install / update / search.sh / lockfile check
  worktrees/route.ts                     GET/POST/DELETE git worktrees

lib/
  abort-race.ts             raceAbort (promise vs AbortSignal, with onLateSettle cleanup) + creationTimeoutSignal — bounds session CREATION everywhere a startRpcSession hang would pin a turn/run (interactive create, kit round)  workspaces/
    types.ts                WorkspaceManifest / WorkspaceCapability / WorkspaceRepository / templates
    service.ts              manifest CRUD, capability validation (ALL_WORKSPACE_CAPABILITIES), repos, index, managed AGENTS.md (repositories + knowledge segments)
    templates.ts            capability init constants (MANDATORY/INIT checklist, normalizeInitCapabilities) + renderWorkspaceAgents (capability-driven) + renderWorkspaceRepositories + renderKnowledgeSection + legacy built-in templates
    okf.ts                  OKF v0.2 structure constants + renderOkfSeed (index.md/log.md/example concept for newly init'd knowledge repos)
    kb-search/              opt-in L1 `kb_search` tool + pure-JS BM25 index (self-healing, cross-bundle)
      index.ts              ensureIndex() (mtime-incremental, .pi/cache rebuildable) + searchIndex() (Okapi BM25, CJK-aware tokenize)
      extension.ts          createKbSearchExtension() — `kb_search` InlineExtension (query/limit/filters), re-resolves active bundles per call
    extensions.ts           WORKSPACE_EXTENSION_FACTORIES + buildWorkspaceExtensions (tool modules)
    id.ts                   ULID generator
  work-items/
    types.ts                WorkItemRecord / phases / events (incl. optional `external` source ref)
    service.ts              item.yaml + README.md + events.jsonl CRUD, revision locking, key reservation
    extension.ts            pi extension: list/get/create/update/record-milestone tools
    web.ts                  error → HTTP mapping
    source-labels.ts        UI-safe source→中文标签 map (禅道) — 外部源脚本盖章的来源展示
  loops/                             web-side loop control + prefill resolution (loop-surface spec §3–§5; imports pi-loop pure logic, no daemon deps of its own)
    lookup.ts              findKitLoopByName — loop 名→declaration（name 字段优先，回落目录名；绑定存名，文件操作以 dir 为准）
    rounds.ts              stopRound / launchManualRound（依赖全注入：daemon 会话面 + reap + 可选 runningSessionIds）+ RoundBusyError —— 无 daemon 新路由，经现有 POST /v1/sessions 两步建会话；手动轮锁保持持有靠 stale 窗（maxMinutes+15min）回收，无 D9 钩子；幽灵锁活性接管（isPhantomRoundLock + PHANTOM_LOCK_GRACE_MS 2min 宽限，见 Loop 章）：带 sessionId 的 daemon 锁不在 running set 即清锁重取（launch）/直接清锁返回 stopped（stop）
    contract-prefill.ts    resolveContractPattern（纯函数）：工作项绑定 loop 名 → pattern（paused = 不存在；未命中/未绑定且恰 1 个 active → 该 loop；≥2 个 active → undefined 不猜，防误路由到不消费工作项的 loop）
    cron-summary.ts        summarizeCron（纯函数）：cron 人话摘要（常见形态；其它 → null，UI 回落原始 cron）
    manage.ts               loop 配置面服务端逻辑：getLoopDocs/writeLoopFile/createLoop/deleteLoop + 守卫（白名单/原子写/mtime 并发/锁活/绑定扫描）
  daemon/                           THE pi-daemon: session-owning process + job registry (C2)
    host.ts                 createDaemon() composition root — /health, route chain (sessions), jobs (loop-kit-heartbeats), startDaemon (PI_DAEMON_HOST/PORT, legacy PI_LOOP_* fallbacks)
    http-sessions.ts        /v1/sessions/** surface (create/commands/probe/SSE/running/live/busy/reload-cwd/auto-name/teardown)
    jobs.ts                 DaemonJob {id,start,stop} + registry — domains register background jobs here
    http.ts                 shared route plumbing (DaemonRouteHandler, body/json, error→status)
    client.ts               daemonClient — HTTP client to the daemon (PI_DAEMON_URL, legacy PI_LOOP_URL fallback): session-daemon surface
    rpc-manager.ts          DAEMON-ONLY session registry + AgentSessionWrapper + startRpcSession (moved here from lib/ root — the daemon domain's core; attaches the global piSubagentExtension)
    session-heartbeat.ts    stall classify/warn/kill snapshot (moved with rpc-manager)
    pi-subagent-host.ts     community @henryqw/pi-subagent host adapter — jiti-imports the package's extension entry, presents the pi CLI process identity its ephemeral executor requires, pins the kill-based timeout policy (idle 30min / max 120min, wins over the package's config)
    pi-subagent-roles.test.mjs  role discovery + precedence tests against the package's loadRoles
    loop-spawner.ts          pi-loop kit heartbeat spawner — LoopKitSpawner (DaemonJob loop-kit-heartbeats, 30s tick, unconditional): imports the pi-loop package's pure logic (protocol/fire/round-lock/contract/reap) and runs the unified due+lock fire sequence per workspace — runKitRound (one-shot AgentSession, cwd=workspace root, opening contract + /skill:<pattern>) + waitForRoundSettle (max_minutes timeout → destroy + orphan reap) + D9 settleRoundBookkeeping (conversations backfill + auto-archive rounds without pending loop.gate); no in-memory slot/busy maps — .lastrun + .round.lock are the truth
  session-daemon/                   sidecar lifecycle for the session daemon (C2)
    sidecar.ts               ensureSessionDaemonStarted (probe→attach / spawn detached) + pure guards (decideSidecarAction, spawnableDaemonUrl, sidecarSpawnEnv)
  subagent-child.ts          subagentChild tagging for community @henryqw/pi-subagent children
                             (id/name prefix `pi-subagent` — replaces the old subagent-children.txt registry)
  (dev-loop/ retired — loops are per-workspace custom definitions; the R&D loop pattern lives in cxin-workspace, see Dev Loop section above)  git-changes.ts            getGitStatus (multi-repo groups) + getGitFileDiff (patch)
  git-status.ts             porcelain-v1 parse, status classify, buildRepoGroups (pure)
  git-discover.ts           walk tree to find nested repo roots (+ scattered files for file-index); IGNORED_NAMES prunes
                            node_modules/dist/… and `.pi` — the latter can hold the relocated pi data home (dozens of
                            nested git repos, GBs) inside a project tree; a workspace's own `.pi/` never contains `.git`, so
                            pruning costs nothing on the normal path
  git-types.ts              GitFileStatus / RepoGroup / response shapes
  chat-scroll-follow.ts     聊天流式跟随的滚动决策状态机（纯逻辑 + 测试，`useAgentSession` 挂监听共用）：上滑判定先于近底恢复 / 0.5px 阈值 / touchmove 刷新意图窗 / 近底恢复需佐证（跟随中 ∣ 意图新鲜 ∣ scrollTop 增大）
  shell-is-mobile.ts        mobile-shell 路由决策（纯函数 + 测试，`useViewportIsMobile` 消费）：①视口≤640 ②UA 手机种子不降级（宽视口手机：横屏/折叠/记住的缩小） ③纯触屏设备（pointer:coarse 且无 any-pointer:fine，兑住「电脑版网站」改写 UA+撑宽视口）→ mobile，否则 desktop
  session-tabs.ts           会话 tab 模型纯逻辑层（+测试）：SessionTabState（session/new-session/workspace-home 三种 kind，id 前缀 s:/new:/ws:）、createX 工厂、resolveOpenSessionTarget（C1 分派）、nextActiveTabId（X1 邻居回落）、tabQuery（URL 投影）、serializeTabs/parseStoredTabs/restoreTabs（R2 持久化，失效 id 静默跳过）
  tab-types.ts              Tab 类型（file/session 文件 tab）+ 右坞钦死模块 tab id（FILES_TAB_ID/LOOPS_TAB_ID + MODULE_TAB_IDS/isModuleTabId，+测试）——从 TabBar.tsx 下沉到此供 lib 层引用
  dropdown-layout.ts        body-portal 弹层定位（纯函数 computeMenuLayout + 测试，SessionTabBar ⊞ picker 与 WorkspaceSwitcher 共用）：top/right/maxHeight 一律钳进可视窗口（visualViewport 换算，scale=1 时即普通视口）——锚点被横向滚动裁剪出屏（rect.right > innerWidth 曾使 right 为负、菜单整体滑出屏幕右缘，2026-09 手机端报告）或贴左锚点向左生长被中栏 overflow:hidden 裁剪（2026-09 PC 端工作台切换器报告）都不再把菜单推出可视区
  session-reader.ts         index-backed SessionInfo mapping + buildSessionContext (tail window) + buildEarlierContext + path caches
  session-payload.ts        buildSessionsPayload — the /api/sessions payload builder shared by the route and the SSR prefetch in app/page.tsx（方案二首帧真数据；daemon 合并 best-effort，getClient 注入获取语义：路由 daemonProxy 可等 sidecar，SSR 直连 daemonClient fail-fast）
  session-index.ts          persistent mtime-incremental session index (~/.pi/agent/sessions/.index.json, active + .archived; rebuildable cache)
  session-changed-files.ts  PURE deriveSessionChangedFiles — files written/edited in a session from the message stream (write/edit toolCalls; relative `file_path` args resolved against session cwd so openFile passes the /api/files allow-list; NOT git state; survives commits); isEditToolName consolidated here
  session-archive.ts        move .jsonl to/from .archived/ to hide/restore sessions
  archive-cascade.ts        work-item archive ↔ session archive bridge
  worktree.ts               project/worktree resolution (worktree→main repo) + git worktree ops
  file-access.ts            allowed file roots for /api/files, /api/git, worktrees
  agent-client.ts           typed fetch helper for /api/agent commands
  agent-proxy.ts            web-side entry to the session daemon: daemonProxy() (ensure sidecar + client) + daemonErrorStatus
  agent/                    agent event reducer + helpers + types
  stores/                   models-store, session-messages-cache, session-runtime-store, file-resource-cache, map-store
  sse/global-agent-events.ts  global running-session event fan-out
  types.ts, normalize.ts, tool-presets.ts, api-types.ts  shared types + toolCall normalization + presets
  model-catalog.ts, model-discovery.ts, models-cache.ts   model list/discovery/caching
  markdown.ts, ansi.ts, compaction-summary.ts, message-display.ts   rendering helpers
  file-paths.ts, file-types.ts, file-fuzzy.ts, file-index.ts, file-links.ts   file viewer/open helpers
  home-quick-switch.ts       首页快速切换纯逻辑：workspaceForSession（最长前缀归属）/ groupSessionsByWorkspace（按工作区分组+活跃度排序，排除 subagentChild 与无归属）/ defaultHomeNewSessionWorkspaceId（最近会话所属 → MRU tab → 第一个可用），有 node:test 覆盖；选择谓词统一 isWorkspaceSelectable（lib/workspaces/types.ts，available && !disabled——停用工作区首页不可见）
  format-time.ts             formatRelativeTime — 会话列表相对时间（首页分组列表共用）
  patch.ts, project-trust.ts, request-security.ts, path-security.ts, http-dispatcher.ts   security + routing
  npx.ts, skill-lock.ts, skill-message.ts, skills-service.ts, skill-updates.ts   skills/plugins plumbing (skill-message.ts also powers session titles: `skillMessageTitle` reduces pi's `/skill:` expansion wrapper — `header + SKILL.md body + </skill> + args` — back to the args or `/skill:name`, incl. a truncated-wrapper fallback for pre-v2 index clips; used by the session index, session-reader, locate route, auto-name, MessageView)

packages/pi-loop/                      THE loop-host package: pure protocol logic + beat CLI (design: docs/pi-loop-host-design.md; npm workspace, independent package.json for future publish, imported by relative path — see Loop section)
  protocol.ts             LoopDeclaration / parseLoopDeclaration / discoverKitLoops (.pi/loops/*/LOOP.md frontmatter; PAUSED skipped) / isWorkspaceHalted (loop-pause-all) — pure fs+yaml, no daemon deps; the web loops route imports it too
  cron.ts                 cronMatches (Vixie-cron matcher with timezone, never throws on bad input) + nextDue (first cron hit after a moment, minute granularity) — the fire judgment's clock
  round-lock.ts           .round.lock cross-host round mutex — acquire/read/update/releaseRoundLock + isRoundLockStale（唯一权威公式）; O_EXCL atomic create, stale = 无 sessionId 且 pid 死（启动窗口/beat 轮）或超 maxMinutes+15min 窗（带 sessionId 的锁一律窗口治理——web 手动轮锁 pid=web 进程，web 重启不得触发心跳双发）
  due.ts                  .lastrun machine truth (host-written ISO timestamp; STATE.md Last run stays narrative) + shouldFire = now >= nextDue(cron, tz, .lastrun) — anacron-lite catch-up (at most one round after downtime)
  contract.ts             buildRoundPrompt — opening-contract assembly shared by daemon spawner (with sessionId, D9) and beat (without); D13 ledger path is per-loop
  fire.ts                 runDueRound/runNow — the unified fire sequence (acquire lock → re-check shouldFire in-lock → write .lastrun → run → finally release); daemon tick and beat share it, cross-host TOCTOU-safe
  beat.ts                 beat round runner — spawns `pi --name "<loop> · <slot>" -p --approve "<contract>"` (cwd=root, detached own process group); max_minutes timeout → group SIGTERM→3s→SIGKILL
  cli.ts                  pi-loop CLI entry (bin) — beat/run/stop/pause/resume/status/init/watch commands (host spec §4)
  status.ts               collectStatus — per-loop frontmatter summary + .lastrun + next-due + running (lock alive) / paused for `pi-loop status`
  init.ts                 initLoop — scaffold the kit/templates/basic five-piece set (D13 layout: loop/ + root/ + skill/) + SKILL.md skeleton; writes .lastrun = now (first round waits for a natural slot)

kit/                                  pi-loop kit template library + protocol README (consumed by copy, not imported — see Loop section)
  README.md                       the protocol contract: file layout (incl. host files .lastrun/.round.lock, agent-forbidden), host section (daemon auto / pi-loop beat + crontab, dual-host lock safety, catch-up semantics), L1/L2/L3 levels, breaker + budget rules, GitHub Actions scenario
  templates/basic/               D13 two-level layout — loop/ {LOOP.md, STATE.md, loop-ledger.json} + root/ {loop-constraints.md, loop-budget.md} + skill/ {SKILL.md skeleton, spec §4}; pi-loop init scaffolds from here
  templates/github/loop.yml      GitHub Actions cron heartbeat template (pi -p + community subagent package)

components/
  AppShell.tsx              thin dispatcher: useAppShellState → AppShellProvider → DesktopShell|MobileShell by viewport + shell-agnostic overlays (create-workspace wizard, DirectoryPicker, ProjectTrustDialog)
  shell/
    useAppShellState.ts     the shared shell-state hook — SESSION-keyed tabs（lib/session-tabs 模型：openSessionTab/openNewSessionTab/ensureHomeTab/closeTab + C1/X1/U1/R2 语义）, URL restore, sessions, SSE wiring, panel selection/persistence, run-contract composer prefill (D11); NO isMobile branches (mobile intents = chatFocusKey/panelFocus signals)
    context.tsx             AppShellProvider/useShell — the shells consume the shared state
    DesktopShell.tsx        the desktop three-column render (rail + middle column + center + right panel), migrated verbatim from the former AppShell JSX
    MobileShell.tsx         the mobile shell: ChatToolbar + SessionTabBar (chips row, hidden on the home landing) + tab-switched main area (会话/工作台/设置, `TAB_ORDER`; 工作台 tab 的 overview 栈页 overview/loop-config/work-items/knowledge = 家 tab hub 移动镜像) + bottom tab bar (narrow) / left `MobileSideRail` (≥768px wide viewports, same tab state) + per-tab secondary stacks (archive) + full-screen file overlay + persistent chat mount
    ChatToolbar.tsx         the shared 36px tool strip (theme/language/chat-scoped buttons/token stats + dropdowns); ☰ desktop-only
  HomeLanding.tsx           移动端首页（2026-09 方向 A 重做 + 工作区维度收敛：首页 = 全局启动器，不设「当前工作区」chip；桌面首页是 HomeNewSession composer 页，本组件返回 null）。移动端：问候语（按时段）+ 大输入卡（→ HomeNewSession，tap-to-compose，工作区在选择器里挑）+ 右上角 ⊞ 工作区底部面板（完整列表点选=进入 + 新建/导入，管理入口）+ 最近会话按工作区分组（HomeSessionGroups，组头点击=进入工作区——继续干活时的顺路入口；空工作区不成组，只在面板出现）；无工作区时渲染引导态（新建/导入）。工作区入口有二、职责不重叠：组头=顺路进，⊞面板=完整列表/管理。WorkspaceTabBar 行在首页落地页隐藏
  HomeSessionGroups.tsx    全局会话分组列表（按工作区分组：组头点击=打开工作区，chevron 折叠默认全展开不持久化；会话行=共享 SessionRow：运行/完成徽章+相对时间+Cmd/中键/hover 新 tab+行内归档，点击=C1 分派直达——2026-09 全局左栏后「切换器无管理操作」契约作废）。宿主：桌面中栏唯一会话面板（工作台与首页同体，WorkspaceSidebar 的 renderGlobalSessionsBody）+ 移动端 HomeLanding 最近区（过滤空组，不传管理 props）；排序由 lib/home-quick-switch.ts 的 groupSessionsByWorkspace 负责（活跃度降序、空组沉底）
  SessionRow.tsx            会话行共享组件（运行/完成徽章 + Cmd/中键/hover「新 tab」C1 手势 + 行内归档 + 可选相对时间）——HomeSessionGroups 与移动端工作台会话段共用
  HomeNewSession.tsx       首页无主新会话页（B1 原地切换，反馈修订后无定制外壳）：直接渲染普通工作区同构的 ChatWindow 新会话视图（只有 composer，可直接发起对话；返回 = tab 栏首页按钮，activateTab 重置无主页模式）；工作区选择器经 ChatWindow inputLeadingControl → ChatInput leadingControl 槽渲染在 composer 控制行、上传图片按钮左侧（下拉向上展开；旧版挂在 PanelHeader meta 槽会被头部容器裁剪——即「点击无选项」bug 的成因），默认最近活跃（共识 Q11=a），草稿 draftKeyOverride="new:__home__"；首次发送走现有 /api/agent/new（cwd=所选工作区根，daemon 解析装配），onSessionCreated → useAppShellState.handleHomeSessionCreated **原地**落为首页会话聊天（反馈修订：不跳工作区 tab）。首页打开的会话由 useAppShellState.homeSession 承载：两 shell 首页分支渲染 ChatWindow(session=homeSession)，左侧中栏保持首页菜单并在列表里高亮；activateTab（含点首页按钮）重置。无可用工作区时显示创建引导
  ActivityBar.tsx           the icon rail (desktop left strip / mobile fixed bottom bar): module group 工作台→知识库→工作项→Loops + separator + global group 模型→Skills→插件→归档→设置(bottom-pinned; the config trio renders in the RIGHT column, not the middle column); defines `SidebarView` + `ConfigView`/`isConfigView` + `ACTIVITY_VIEW_ORDER` + `RAIL_GLOBAL_VIEWS` (rail icon order) + `GLOBAL_ACTIVITY_VIEWS` (middle-column persistence surface: archive/settings only) + `visibleActivityViews()`
  PanelHeader.tsx           unified ~36px middle-column panel header (title + back + context actions + mobile ×) + PanelHeaderButton
  SettingsPanel.tsx         the 设置 panel — iOS-settings index → 工作区/模型/Skills/插件/偏好 subpages (mounts the config bodies in `embedded` mode)
  WorkspaceSidebar.tsx      middle-column content for module views (workbench/knowledge under a PanelHeader); 2026-09 全局左栏：工作台与首页共用 renderGlobalSessionsBody（全局分组列表+不可用工作区+导入目录），桌面（showFilesSection=false）会话区即它，移动端（true）保持工作区作用域的会话+文件分段 (drag-resizable share, default 40%, `pi-workbench-split:<wsId>`; [ 文件 | 改动(N) ] tabs + ⟳ manual refresh, `pi-workbench-sections:<wsId>` persistence)
  FilesExplorerPanel.tsx   the desktop right panel's pinned「文件」tab body — [ 文件 | 改动(N) ] toolbar + ⟳ + FileExplorer/ChangesPanel (cwd = workspace root); exports ExplorerSegmentedTabs (shared with the mobile workbench section); reveal switches its segmented back to 文件
  WorkspaceManager.tsx      workspace create/import + settings (`embedded` in-panel, `panel` narrow single-column variant — 宿主：桌面右坞工作项 tab + 移动 overview 栈 work-items 页（右坞 S3；workItemSplit portal 机制已退役）; `split={{ inline: true }}` = 列表+详情并排单容器（设置›工作区的中央区页面，2026-09 搬家）; the settings detail carries the 基本信息 card — rename (PATCH name) + 暂时停用 toggle (PATCH disabled; disabled workspaces keep a settings-only「已停用」badge, the sole re-enable surface); the rail is drag-sortable (HTML5 DnD，同 SessionTabBar 模式：drop 到目标上=插到它前面，列表尾空区=移到末尾；一次拖放 = PATCH /api/workspaces 全量期望序); remaining modal = home create-workspace wizard
  WorkspaceOverview.tsx     workspace dashboard — the unconditional landing view (quick actions, 活跃工作项 with 「立即跑一轮」B-button + Loop 绑定下拉, 仓库/知识库 rows that navigate the right dock's 文件/知识库 tabs, recent sessions with delete, and a Loops 区块: 桌面 = 摘要行（onOpenLoopsTab → 右坞 Loops tab，决策 #10），移动端 = 全量管理区块（LoopRow 列表+配置/新建 → overview 栈）)
  SessionTabBar.tsx          the SESSION tab strip（2026-09 会话 tab 化，替换已删的 WorkspaceTabBar）：首页固定首 tab + 会话/占位/家 tab chips（工作区色点 + 运行呼吸点/未看完成点 + 拖拽排序）+ ＋新会话（无活动 tab 时隐藏）+ ⊞工作区选择器（body-portal dropdown → 开/激活家 tab）；两 shell 共用，无 isMobile 分支
  SessionSidebar.tsx        in-workspace session tree + FileExplorer + Changes section
  ChangesPanel.tsx          git changes list (flat or per-repo grouped)
  FileExplorer.tsx          file tree inside sidebar
  FileViewer.tsx            file content in a tab
  CapabilityToggle.tsx      the capability on/off switch used in settings panels
  LoopsConfig.tsx           loop 配置视图（创建向导 + frontmatter/指针正文/知识文档/宪法编辑 + STATE 只读 + 删除）——桌面右栏 / 移动 overview 栈页共用
  LoopRow.tsx               loop 单行（name/cron 摘要/级别/状态 + 配置/暂停/停止/可选运行）——右坞 Loops tab 与总览（移动端）共用
  LoopsDockPanel.tsx        右坞 Loops tab 本体（右坞 S1）：loop 列表+状态/操作 + 内联 LoopsConfig 推导航；key=workspace.id 挂载（同工作区切 tab 状态存活）
  KnowledgeBrowser.tsx      知识库浏览（chips 选 bundle + FileExplorer + open index.md 提示；宿主：桌面右坞知识库 tab（S2，knowledge capability 门控） / 移动 overview 栈 knowledge 页）
  ChatWindow.tsx            chat composition + completion sound wrapper
  SessionChangedFiles.tsx   "本会话改动 N 个文件" toolbar button (right of the sound toggle in ChatInput) + slide-in drawer (desktop) / full-screen list (mobile); entries open the file via the openFile/file-tab pipeline
  ChatInput.tsx             input bar + model/thinking/tools/compact controls; optional leadingControl ReactNode slot at the very LEFT of the controls row (before the attach-image button — hosts the home new-session workspace selector)
  MessageView.tsx           renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx       in-session branch switcher
  ChatMinimap.tsx           scroll minimap alongside the message list
  MarkdownBody.tsx / MermaidBlock.tsx   markdown + mermaid renderers
  ModelsConfig.tsx          models.json editor (`split` mode = list in middle column + detail/footer portaled into the right column; `embedded` mode = settings-subpage body; `onSaved` refresh hook)
  PluginsConfig.tsx         installed package plugins panel body (`split`/`embedded` modes as above)
  SkillsConfig.tsx          loaded/search/installable skills panel body (`split`/`embedded` modes as above)
  ArchiveModal.tsx          archived sessions/items (embedded = the 归档 panel body)
  TabBar.tsx                chat + open-file tabs; exports FILES_TAB_ID; `leadingTabs` renders the right dock's pinned module tabs（文件/Loops/…，窄面板容器查询图标化）非可关
  FileIcons.tsx / git-ui.tsx   file icon + git-status UI helpers

hooks/
  useAgentSession.ts        messages + streaming + SSE + fork/navigate/reconciliation logic
  useGitStatus.ts           polls /api/git/status for the Changes panel
  useKitLoops.ts            loops 状态 hook（GET /api/workspaces/:id/loops + pause/resume/stop，refreshKey 驱动）——右坞 Loops tab 与 WorkspaceOverview 共用
  useSessionActivity.ts     running-session activity signals
  useGlobalAgentEvents.ts   global running-session SSE subscription
  useAudio.ts               completion sound + AudioContext unlock
  useDragDrop.ts            shared drag/drop state
  useKeyboardShortcuts.ts   global keyboard shortcuts
  useI18n.tsx / useTheme.ts / useIsMobile.ts   i18n / theme / responsive hooks (useIsMobile reads IsMobileContext — server-seeded UA guess, see Shell split)
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/daemon/rpc-manager.ts` — daemon process)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`.
- **Session CREATION is abortable + bounded** (`StartSessionOptions.signal`): `startRpcSession` races creation against the signal (`raceAbort`, `lib/abort-race.ts`) — an already-aborted signal throws immediately, a hung creation (e.g. stuck network call in model resolution) rejects on abort/timeout, and a session that materializes late (after the caller gave up) is destroyed on arrival so no live zombie wrapper stays in the registry. Callers bound it: subagent `runWorker` (parent tool signal + 5-min timeout; failure degrades to a failed WorkerResult, not a throw), kit rounds (`lib/daemon/loop-spawner.ts`, `creationTimeoutSignal` 5-min). Without this, a creation hang pinned the parent's turn, the daemon's `abort` path (which awaits idle), and the running set forever. The start-lock key for NEW sessions is a one-time `__new__<uuid>` — never `""`, which made concurrent creations (parallel subagents) coalesce onto the first session.
- **Heartbeat monitor — the zombie safety net** (`lib/session-heartbeat.ts` + `startSessionHeartbeatMonitor` in rpc-manager, started from `getRegistry()` init): every 60s (unref'd, daemon-process only) each RUNNING wrapper is checked for time-since-last-activity (any agent event — streaming deltas, tool partials — or inbound command, tracked in `lastActivityAt`). Silent past `STALL_WARN_MS` (5min) → listed in `GET /v1/sessions/running`'s additive `stalled` snapshot and `get_state`'s `stalledMs`; silent past `STALL_KILL_MS` (20min, env `PI_SESSION_STALL_*_MS`) → synthetic `prompt_error` (visible as a chat notice, NOT persisted) then `destroy()` (aborts in-flight prompt, drops registry, closes SSE → badges clear; human resends to resume). Rationale: a false kill costs one resend, a zombie costs a daemon restart (REQ-0026: 4 silent hours). NOT covered: creation-phase hangs (bounded by `StartSessionOptions.signal`/raceAbort above), gate-paused sessions (not `running`, never monitored — human waits can be arbitrarily long), and sessions with a **pending extension UI request** (`hasPendingUiRequests()` — running but human-paused on a confirm/select dialog; exempt like gate-paused, since the dialog is replayed to any reconnecting viewer and stays answerable). The KILL margin exists for QUIET BUILDS: pi's bash tool only emits partials when there IS output, so a legit `npm install`/`mvn` (and a subagent parent waiting on such a child) is genuinely eventless — kill must outlive the longest normal build.
- The registry lives in the **session daemon** (bin/pi-daemon.js). Its lifecycle no longer follows web hot-reloads — the `globalThis` guard survives daemon-internal restarts of the module graph, and a daemon restart cold-starts sessions from their .jsonl on demand (same revive semantics as commands).
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`).
- **`destroy()` aborts an in-flight prompt** (`promptRunning || isStreaming → inner.abort()`). Without this, destroying a wrapper mid-run (Loop round timeout/abort) only unsubscribes events and drops the registry entry — the inner prompt keeps executing as an invisible zombie: still writing the .jsonl and spawning subagents for many minutes after every surface (run status, running badge, host probe) says it is gone. The idle-timer path is unaffected (it guards on `isRunning()` and never destroys a busy session), and fork is idle-only, so the abort branch fires only where a kill is intended.
- Session creation resolves the enclosing **Workspace** (`findWorkspaceForPath`) and attaches its extensions + filtered skills. If none, only the global `subagent` extension is attached.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets already-forked state and subsequent forks produce a corrupt `parentSession` chain. **Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning; the next request for the original id reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on a user message): creates a new independent `.jsonl` file. Shown as a sidebar-tree child via the `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Switching between siblings calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — it has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

### Workspace capability registry is the source of truth
`ALL_WORKSPACE_CAPABILITIES` (`lib/workspaces/service.ts`) is **the** validation list. `parseCapabilities()` throws on any value not in it, so a capability missing from this array — e.g. `subagent`, or historically `knowledge` before it was registered — **cannot be persisted** (a `PATCH …/capabilities` with it returns **400 "Unknown capability"**). The `WorkspaceCapability` *type* union contains `subagent` anyway because the tool is global; treat the type as a superset, not the validatable set. (`workflows` is registered but currently inert — no factory, no template. The former `overview` capability is RETIRED — the overview dashboard renders unconditionally; manifests still listing `overview` get it stripped on read, see the capability system section.)

### Capabilities are required — no fallback path
`WorkspaceManifest.capabilities` is non-optional. `parseWorkspaceManifest` throws on a manifest without it, and the deleted `effectiveCapabilities` helper is NOT to be reintroduced — read `manifest.capabilities` directly. Legacy manifests were rewritten once by the v2 index migration (see Work Items → Key behavior above / "Workspace index v2" in the manifest section).

### AGENTS.md managed-segment replacement is a no-op without markers
`updateManagedRepositoryInstructions()` only rewrites content **between** the managed markers, and now maintains **two**
segments — `<!-- workspace-managed:repositories:start/end -->` and `<!-- workspace-managed:knowledge:start/end -->`.
Each is touched only when its capability (`repositories` / `knowledge`) is effective. If a user deletes a segment's
markers it will silently stop syncing — it never recreates them. The git block (`<!-- workspace-managed:git:start/end -->`)
is emitted once by `renderWorkspaceAgents` (when `git` settings exist) and not re-managed afterwards.

### Knowledge repos use OKF; L0 is always built-in, clone never overwrites
A `knowledge` repo initialized with `mode: "init"` is seeded with an **OKF v0.2** structure via `renderOkfSeed`
(`lib/workspaces/okf.ts`): `index.md` (progressive-disclosure entry, frontmatter `type: index`), `log.md` (`type: log`),
and `concepts/welcome.md` (`type: concept` + tags). `mode: "clone"` is **never** overwritten — the remote brings its own
structure. **L0 access (read/ls/grep) is always built-in** and needs no tool (redesign decisions 11/12); existing
frontmatter-less bundles (e.g. legacy ones) are **not force-migrated** (decision 13, progressive) — they still work via
L0. The AGENTS.md knowledge segment **references** each bundle's `index.md` rather than inlining it (decision 10).

### kb_search is opt-in, self-healing, cross-bundle (L1)
The `knowledge` capability carries **two coexisting layers** (redesign decisions 11/14, §6.1): **L0** (always built-in
`read`/`ls`/`grep` — needs no tool) and **L1 `kb_search`** (an enhancement mounted by `buildWorkspaceExtensions` when
the capability is on). `kb_search` is implemented by `lib/workspaces/kb-search/` and is **pure-JS** (no native deps):
frontmatter (`type`/`tags`) + body are tokenized and ranked with **BM25**. It searches across **all active knowledge
bundles** of the workspace and merges results.

- **Self-healing index (decision 14)**: each `kb_search` call runs `ensureIndex()` first, which walks each bundle's
  `.md` files and compares **mtime** to the cached entry, re-parsing only new/changed files (deleted files are dropped).
  The index is a **rebuildable cache** at `<workspacePath>/.pi/cache/kb-index/<repoAlias>.json` (git-ignored). A
  missing or corrupt cache simply triggers a full rebuild — never a failure. Index writes are serialized with
  `withWorkspaceWriteLock`; a torn write (interrupted) is made harmless by tmp+rename atomic write.
- **Degrades gracefully**: if indexing fails for a bundle it is skipped; if all bundles fail, the tool returns an L0
  hint (`grep`/`ls`). L0 never depends on `kb_search`.
- The tool re-resolves the live active-knowledge-repo set on **each call**, so bundles added/removed during a session
  are picked up without a restart.
- The factory passes an initial repo snapshot at mount time; the source of truth at execution is the fresh manifest
  read (so `kb_search` and L0 always agree on which bundles exist).

### Subagent is global, not a workspace capability
The `delegate_task` tool (community `@henryqw/pi-subagent`) is attached to **every** session in `rpc-manager.ts` via `piSubagentExtension()` (`lib/daemon/pi-subagent-host.ts`), regardless of workspace or capability. It is intentionally absent from `WORKSPACE_EXTENSION_FACTORIES` and `ALL_WORKSPACE_CAPABILITIES`. There is no per-session role-dir injection anymore (the old `StartSessionOptions.extraAgentDirs` / REQ-0027 re-derivation is retired with the built-in): the package discovers workspace roles itself from `<cwd>/.pi/agents/pi-subagent/` and loop sessions run with cwd = workspace root, so cold-rebuilt wrappers see the same roles with zero wiring. Timeouts are kill-based (idle 30min / max 120min — see the Subagent section) — deliberately NOT the old built-in's never-abort inactivity budget; quiet builds renew the deadline while producing output.
### The session daemon (C2 redesign): one process owns every AgentSession

The pi-daemon process (`npm run daemon` → `bin/pi-daemon.js` → `lib/daemon/host.ts`) — formerly the "loop host" — is **THE single session-owning daemon**, and a generic host for registered background jobs (`lib/daemon/jobs.ts`). Motivation for the original strangler: the old split — web process and loop host each holding AgentSessions, with the UI needing to answer "who owns session X" in six places (state probe, pin/reprobe, client-side badge merge, host probe, locate bypass, reducer promotion) — accreted a patch cluster that this redesign eliminates at the source. Strangler phases:

- **Phase 0 (done)**: all outbound/inbound channels removed (feishu/wecom/notify/exporters). The daemon surface is now purely sessions (loop heartbeats are a DaemonJob, not a route).
- **Phase 1 (done)**: daemon command surface + sidecar lifecycle (below). Web routes still own interactive sessions locally — nothing flipped yet.
- **Phase 2**: flip `/api/agent/new`, `/api/agent/[id]` (GET/POST), `/api/agent/[id]/events`, and the session lifecycle routes to pure proxies over the daemon client. The pin/reprobe/loop-badge-merge hacks retire here. The web proxy for create-session must call `allowFileRoot(cwd)` with the daemon's returned cwd (the files/git routes' allow-list lives in the web process).
- **Phase 3 (done)**: the web-side session registry is gone — no `app/`/`components/` code imports `lib/daemon/rpc-manager` (its header now declares it daemon-process-only; `notifyRunningChange` is module-private). The probe-404-fallback double-writer race is structurally impossible: the web process never constructs an AgentSession, so it cannot race the daemon for a .jsonl.

**Daemon command surface (`lib/daemon/http-sessions.ts`, mounted by `lib/daemon/host.ts`)**: `POST /v1/sessions` (create + optional pre-selected model/thinking/tools + optional first command — mirrors `/api/agent/new` including the one-time `__new__<uuid>` key), `POST /v1/sessions/:id/commands` (generic passthrough to `wrapper.send` — ANY command incl. extension UI responses; live-or-cold-started exactly like `/api/agent/[id]` POST), `GET /v1/sessions/running` (`{ids}` — the registry is keyed by real session id and contains interactive sessions + kit loop rounds, so this one set is the complete running answer; community subagent children are separate OS processes, not registry sessions, so they appear only on disk), plus the pre-existing `GET /v1/sessions/:id` probe and `/v1/sessions/:id/events` SSE. Client methods: `daemonClient.createSession/sendSessionCommand/runningSessionIds` (`lib/daemon/client.ts`).
**Sidecar lifecycle (`lib/session-daemon/sidecar.ts`)**: `ensureSessionDaemonStarted()` — probe `/health` (attach if healthy), else spawn `node bin/pi-daemon.js` detached+unref'd and wait (≤15s) for health. Wired fire-and-forget from `instrumentation.ts` (`PI_SESSION_DAEMON_DISABLED=1` opts out). In-flight guard on `globalThis` dedupes concurrent callers and retries after failure. Guards: `spawnableDaemonUrl` refuses to spawn for non-local `PI_DAEMON_URL` (legacy `PI_LOOP_URL` still honored; a remote URL means the daemon is managed elsewhere); `sidecarSpawnEnv` translates the URL → the child's `PI_DAEMON_HOST`/`PI_DAEMON_PORT` (explicit env wins, legacy `PI_LOOP_HOST/PORT` spellings honored) — without this a URL-only config spawns a daemon on the default port while the web polls the URL's port forever. Spawn races resolve quietly: the EADDRINUSE loser exits 0 (`bin/pi-daemon.js`). The "web owns no unattended timers" rule is preserved — daemon timers live in the daemon process and survive web restarts; the web only ever re-attaches by port probe.

### Loop heartbeats run in the daemon; the web layer adds a management surface over the existing session surface
`npm run daemon` starts the pi-daemon (`lib/daemon/host.ts`; `npm run loop` is a deprecated alias pointing at the same `bin/pi-daemon.js`). The web server never starts loop timers (`instrumentation.ts`) — heartbeats are daemon-only. The web layer's loop surface (`app/api/workspaces/[id]/loops/**` + `lib/loops/`) is file-reads (`packages/pi-loop/status.ts.ts`) plus operations that reuse the **existing daemon session surface**: 「立即跑一轮」= `POST /v1/sessions` two-step create + prompt (manual round, no D9 auto-archive); 「终止本轮」= `DELETE /v1/sessions/:id` + package reap + lock release — **the daemon gains no loop routes**. The daemon hosts background jobs via the `DaemonJob` registry (`lib/daemon/jobs.ts`): the kit spawner (`LoopKitSpawner` → `loop-kit-heartbeats`, **unconditional** — the `PI_LOOP_KIT` gate was removed together with the v3 engine) is registered alone. Kit round sessions are normal one-shot daemon sessions — indistinguishable from user chats in the interactive registry; their run record is `STATE.md` + the workspace git log. The daemon is not the only host: standalone roots (no pi-web) get heartbeats from the `pi-loop` CLI's `beat` (any external cron; see the Loop section) — dual-host coexistence is safe because both run the same `packages/pi-loop/fire.ts.ts` sequence and mutual-exclude via `loops/<name>/.round.lock`. `pi-loop run` / `pi-loop stop` CLI commands remain for standalone hosts (host spec §4/§10); the web run/stop routes are their pi-web-side counterparts over daemon-held rounds.

**Watching a live session (any session — interactive or kit loop round) is one mechanism now (C2).** The daemon owns every session; `/api/agent/[id]/events` is a pure pipe onto `/v1/sessions/:id/events`, which resolves via `findLiveSession` (the ordinary registry, where kit rounds live alongside interactive sessions) and cold-starts idle sessions for viewing. (Community subagent children run as separate pi processes — they're watched from their on-disk `.jsonl`, cold, not via live SSE.) Two subtleties remain:

1. `globalAgentEvents.pinSession(sid)` (`lib/sse/global-agent-events.ts`) — a daemon session that is **alive but idle** (between turns, e.g. a gate-paused kit round session or any warm idle session) appears in NO running set, and `syncRunningIds` **disconnects** any source not in that set. A pinned sid is exempt from the sweep and stays connected while viewed (so a resumed turn's `agent_start` arrives live). `useAgentSession` pins on mount when the state response says `liveInDaemon` and unpins the previous session on switch/unmount. On a fatal SSE error a pinned session re-probes the state route before retrying (bounded retries; unpin when the daemon no longer holds it).
2. The event reducer promotes `agentPhase` to `running_tools` on a `tool_execution_update` partial even without a prior `tool_execution_start` — a viewer joining mid-tool-run never saw the start event, and the streamed partials are the only proof the tool is running. Without this the phase sits on `waiting_model` (「思考中」) for the whole multi-minute run.

**Opening a subagent child by click goes through `/api/sessions/[id]/locate`, never the cached `/api/sessions` list.** `handleOpenSessionViewer` resolves the child id via locate (daemon probe first — then a forced disk scan that bypasses the 30s list cache). The old list lookup silently no-op'd for a freshly spawned running child (it isn't in the cached list yet), which felt like "you must wait for the subagent to finish before you can open it". Locate also enriches a probe-hit from disk (real firstMessage/stats for the tab label, keeping the probe's authoritative path/cwd). (Community children are cold-opened from disk — the parent's result card jump works the same way.)

**Running badges come from one server-side set.** `/api/agent/running/events` pipes the daemon's `/v1/sessions/running/events`; because the daemon registry holds interactive sessions + kit loop rounds alike (keyed by real session id), the sidebar/tab badges need no client-side merge anymore (the old `loopRunningSnapshot` merge existed only because the web set could never contain Loop sessions). Subagent children never show a running badge — they're not daemon sessions.
**The daemon's session SSE ends on destroy.** `serveSessionSse` registers `session.onDestroy(cleanup)` — when a wrapper is destroyed (kit round `max_minutes` timeout, session delete/teardown) the stream closes, the browser's pinned EventSource fails fatally, `reprobePinned` sees the daemon no longer holds the session, unpins and clears the badge. Without this a destroyed round leaves the pinned runtime `agentRunning=true` forever (no `agent_end` is ever emitted after destroy), spinning the tab badge indefinitely.

**Orphan-process reaping on kit-round timeout.** `session.destroy()` — reached from the spawner's `max_minutes` timeout path — does **not** kill the bash subprocesses a round spawned via subagents: pi-coding-agent's bash tool spawns each shell `detached` (own process group) and only sweeps its tracked detached children on a **process-level** SIGHUP/SIGTERM, which a never-exiting daemon never sends. Those `bash → npm → node` trees would otherwise orphan into launchd (PID 1) still holding `node_modules` handles (which is why `rm -rf` then fails and they sit at ~100% CPU). So `runKitRound` (`lib/daemon/loop-spawner.ts`) calls `reapOrphanedRoundProcesses` (`packages/pi-loop/reap.ts.ts`, scoped to the round's workspace cwd) after destroying the session: it SIGTERM→SIGKILL every pid in the round's trees — discovered as (a) direct children of the daemon whose cwd is in the workspace, plus (b) launchd-reparented (ppid 1) build/shell processes whose cwd is in the workspace. Pure parsers (`parsePgrepChildren`/`parseLsofCwd`/`parsePsRows`/`isCwdInWorkspace`/`isBuildOrShellCommand`) are tested. Scoped by workspace cwd so concurrent rounds in other workspaces are untouched; never throws (cleanup must not break the round flow — a reap failure is logged, never masks the round error).

### Session changed-files quick access (SessionChangedFiles)
"本会话改动 N 个文件" — a compact icon+count button at the end of the ChatInput controls row (right of the sound toggle; on mobile it lives inside the "更多控件" pill; not rendered in `embedded` view mode), opening a slide-in drawer (full-screen list on mobile). **Data source is the message stream, not git**: `deriveSessionChangedFiles` (`lib/session-changed-files.ts`, pure + tested) walks write/edit toolCalls (incl. `isEditToolName` variants) plus the streaming message for **real-time** counting. Subagent children no longer contribute — community-package children are separate pi processes whose file operations never appear in the parent stream. Scope is the **whole session file** (not just the current branch path), deduped **most-recent-first** with a ×N badge; bash-written files (`cat >`, `git commit`) are deliberately not counted. Clicking an entry → `openFile` (existing file-tab pipeline; `/api/files` allow-list already covers session cwds). The list intentionally **survives commits** — it answers "what did this session touch", not "what is uncommitted" (that's the Explorer 改动 tab). Drawer state is not persisted; switching sessions closes it.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events` — a pure pipe onto the daemon's running-id SSE (the complete set: interactive + children + kit rounds), so running badges update without polling.
- `useAgentSession` treats per-session SSE as primary, but while a run is active it periodically calls `GET /api/agent/[id]` and reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo group together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` and `/api/git/*` are intentionally not general filesystem browsers. Allowed roots come from session cwds, their resolved project roots, workspace paths, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, `/api/worktrees`, and `/api/workspaces` (GET/POST) call `allowFileRoot()` when they make a new location browsable.

### Local pi data home (`.env.local` + `bin/load-env-local.js`)
The pi data home is env-driven everywhere: `PI_CODING_AGENT_DIR` (SDK `getAgentDir()` — sessions, settings, models,
skills, agents, auth, importer credentials, subagent registry), `PI_WORKSPACES_DIR` (`workspacesRoot()`),
`PI_WORKSPACE_INDEX_FILE`. Docker deployments already set these (docker-compose.yml); `scripts/adopt-pi-home.mjs`
pointed them at `<repo>/.pi/` for local dev. Wiring rules that must NOT regress:
- **`bin/pi-daemon.js` self-loads `.env.local` at boot** (before anything resolves paths) — the daemon is spawned as a
  web sidecar, via `npm run daemon`, or by hand, and only the sidecar inherits a web process whose Next runtime
  already loaded `.env.local`; the loader (`bin/load-env-local.js`, dotenv-lite) NEVER overrides values already in
  `process.env`, so explicit environments (docker-compose, shell) always win.
- **`.pi/agent` + `.pi/workspaces` are gitignored and carry secrets** (auth tokens, importer credentials, 19G of
  cloned repos). `.pi/workspace.yaml` (the pi-web workspace manifest) and `.pi/workspace-templates/` stay tracked.
- **`git-discover.ts` prunes `.pi`** — walking a workspace root that contains the data home must never crawl GBs of
  nested repos into the Changes panel / file index. tsc (`exclude`) and eslint (`ignores`) exclude the data dirs the
  same way; `.vscode/settings.json` watcher-excludes them.
- **The migration script owns path rewriting**: session dirs are NAMED after the encoded session cwd (`/` → `-`), and
  `.jsonl` entries embed absolute `cwd`/`parentSession` paths — after a move, two plain substring replacements
  (old workspaces root, old agent root) fix names, JSON content and the global index consistently.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them. Per-workspace, skills are filtered to `manifest.skills` at session creation (`skillsOverride`).
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd. **Timeout is 5 min** (`runNpx`), because installs `git clone` whole source repos (e.g. `anthropics/skills` ≈ 15MB, >60s even on a fast link). If installs hang forever at `Cloning repository…`, the machine can't reach github.com directly — `runNpx` passes `process.env` through, so start the dev server with `https_proxy` set, or scope it in git: `git config --global http.https://github.com.proxy http://127.0.0.1:<clash-port>`. `npm warn exec ... will be installed: skills@x` in the output is harmless (npx cache priming).

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

---

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — it maps each displayed message back to its `.jsonl` entry id, used for fork and `navigate_tree` calls. Community subagent children (`pi-subagent-<uuid>` ids, created by the @henryqw/pi-subagent package's child pi processes) use the same format; the sidebar hides them via the id/name prefix check in `lib/subagent-child.ts` (they carry no `parentSession` link).
---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
