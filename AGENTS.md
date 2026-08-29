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
               #  `npm run loop` / `bin/pi-loop.js` are deprecated aliases that still work)
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
Tests: `npm test` (node:test over `lib/**/*.test.mjs`)

**Never run `next build` during dev** — it pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

```
Browser                Next.js Server                Session Daemon (bin/pi-daemon.js, :30142)
  │                        │                                │ — THE single session owner
  │  ┌──────── Workspace layer ────────┐                    │   (lib/rpc-manager.ts registry:
  │  │ manifest .pi/workspace.yaml      │                    │    interactive + subagent children
  │  │ capabilities → extensions        │                    │    + loop orchestrators)
  │  │ repositories / work-items /      │                    │
  │  │ loops / work-items            │                    │
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
- **Workspace management**: `app/api/workspaces/**` reads/writes `~/.pi/workspaces/**` and `~/.pi/workspace.yaml` (the global index). Capability edits, repository add/remove, work-item CRUD, loop authoring) all flow through this surface.

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
repositories: [{ id, alias, name, kind: code|knowledge, status: active|removed, removed_at? }]
agent: { default_model?, thinking_level? }
git: { branch_rules: { requirement, bug }, create_after: plan_approved }      # only when work-items is on
work_items: { next_requirement_number, next_bug_number }
created_at / updated_at
```

- **Workspace index v2（一刀切迁移）**: `~/.pi/workspace.yaml` is schemaVersion 2. On first read a v1 index triggers `migrateIndexV2`: every registered manifest is rewritten with explicit `capabilities` (materialized `["sessions","explorer"]` when absent; retired channel values stripped), and `importWorkspace` runs the same `migrateManifestFile` normalization for unregistered directories. After the cut, `WorkspaceManifest.capabilities` is REQUIRED — `parseWorkspaceManifest` throws "capabilities is required" without it, `parseCapabilities` rejects retired channel values (`feishu-transport`/`feishu-channel`/`wecom-channel`) instead of silently stripping, and the `effectiveCapabilities` fallback helper is deleted (read `manifest.capabilities` directly).
- **WorkspaceRepository**: `{ id, alias, name, kind: "code"|"knowledge", status }`. `kind` drives the storage path
  (`repositories/<kind>/<alias>`) and, for `knowledge`, the **OKF seed** written on `init` (see Knowledge below). Note:
  `knowledge` is *also* a top-level `WorkspaceCapability` (the UI "知识库" toggle); the repository `kind` and the
  capability are separate concerns — the capability gates the module/UI, the kind gates the path. (`docs/workspace-redesign.md` §5.1)
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
sessions, explorer, work-items, repositories, knowledge, workflows,
requirement-sources, loop
```

(PATCH capabilities are normalized by `normalizeUpdateCapabilities`: `requirement-sources` force-includes `work-items` (the runner reserves REQ/BUG keys from `manifest.work_items`), and the mandatory `sessions`+`explorer` core can never be dropped. `parseCapabilities` REJECTS retired capability values (`feishu-transport`, `feishu-channel`, `wecom-channel`, and the retired `overview` — the overview dashboard is now the unconditional landing view) — `WorkspaceValidationError` → HTTP 400. For the channel values the v2 index migration has already rewritten them out of existing manifests. `overview` is the one **read-path exception**: `parseWorkspaceManifest` strips it from `manifest.capabilities` BEFORE `parseCapabilities` validation, so legacy manifests that still list it keep parsing and normalize on every read — the value disappears from the file at the next manifest write.)

- `manifest.capabilities` is required and always present (see "Workspace index v2" above). Read it directly; there is no derivation helper.
- **`parseCapabilities()`** rejects anything not in `ALL_WORKSPACE_CAPABILITIES` (`WorkspaceValidationError` → **HTTP 400**). To add a toggleable module you must (1) add the value to `ALL_WORKSPACE_CAPABILITIES` *and* the `WorkspaceCapability` type, (2) add an extension factory, (3) add a config UI panel.
- **Extension factories** (`lib/workspaces/extensions.ts`, `WORKSPACE_EXTENSION_FACTORIES`) turn a capability into an LLM-callable tool extension: `work-items` → work-item tools, `knowledge` → `kb_search` (opt-in ranked retrieval; coexists with always-on L0). **`subagent` is deliberately NOT registered here** (see Subagent below).
- **Attachment point**: `buildWorkspaceExtensions(manifest, path)` filters factories by effective capabilities. `lib/rpc-manager.ts` always attaches `createSubagentExtension(...)` globally, then — when the session's cwd is inside a workspace — appends `buildWorkspaceExtensions(...)` and filters skills to `manifest.skills`.

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

Desktop is four vertical strips: **`[ActivityBar 44px icon rail] [middle column 200–560px drag-resizable] [main area: WorkspaceTabBar + Overview/chat] [file panel 42% toggleable]`** — the old sidebar's icon strip + focused view split into the rail + middle column, so the width budget is unchanged. The middle column is **always mounted** (default 工作台); clicking the ACTIVE rail icon toggles the column (VS Code collapse). One `sidebarView` (`SidebarView` = module views + `archive` + `settings`, lifted in AppShell) drives everything — the five former modal/shell open-states (models/skills/plugins/archive/settings) collapsed into it.

Icon groups are fixed and strict (`ACTIVITY_VIEW_ORDER` + `RAIL_GLOBAL_VIEWS` in `ActivityBar.tsx`, the single source of truth for order/visibility):
**Module group (workspace-scoped, capability-gated): 工作台(workbench) → 知识库(knowledge) → Loop(loop) → 工作项(work-items)** — `workbench` is always shown (`capability: null`); then a **separator + global group (app-scoped): 模型(models) → Skills(skills) → 插件(plugins) → 归档（needs an active workspace）→ 设置（pinned to the rail bottom）**.
**The three config icons (模型/Skills/插件) are strict three-column views**: clicking one renders the config's **LIST in the MIDDLE column** (under a `PanelHeader` like every other panel — it temporarily replaces the `sidebarView` panel) and its **DETAIL in the RIGHT column**: the middle-column panel component (`ModelsConfig`/`SkillsConfig`/`PluginsConfig` in `split` mode) stays ONE component instance owning all state (selection, drafts, save flow) and portals its detail + footer into the right column's config area via `createPortal` — AppShell renders the portal-target div under the right `PanelHeader` (with ×) and feeds it back as `configPortalNode` (a null target renders nothing, so SSR stays safe). Opening a config view also opens the middle column (`handleOpenConfig` → `setSidebarOpen(true)`); any panel switch (`handleSidebarSwitchView` clears `configView`), session select, or × hands the column back to `sidebarView`; switching workspace resets it too. The rail highlights the config icon (`activeView={configView ?? sidebarView}`). They never persist (`isConfigView` routes them out of every panel switch; `GLOBAL_ACTIVITY_VIEWS` — the `pi-active-panel` persistence/validation surface — deliberately stays `["archive","settings"]`, and `visibleActivityViews()` does NOT include them). Mobile never gets here (the settings subpages render the same components in `embedded` mode, unchanged).
**The standalone 仓库 view is REMOVED** — repo browsing lives in the 工作台 file tree, add/manage in 设置 › 工作区 + the overview dashboard. Stale `pi-active-view` values pointing at removed views fall back via the `visibleActivityViews` validation.

The panel bodies: 工作台/知识库/Loop-list render in `WorkspaceSidebar` (module views only) under a unified `PanelHeader` (`components/PanelHeader.tsx`, ~36px: panel name + context actions — 工作台 shows the workspace name + ＋新建会话). Loop 管理/⚙ opens the **LoopConfig editor IN the middle column** (temporarily widens to `max(persisted, 520)` — derived, never persisted). 工作项 is the **full `WorkspaceManager` in `panel` mode** (rail hidden, single column; the old simplified sidebar grouping view is retired) — and on DESKTOP it is a three-column split like the config trio: `workItemSplit={{ portalTarget: configPortalNode }}` keeps the LIST mounted in the middle column (selected row highlighted via `data-active`) while the selected work item's DETAIL portals into the right column (`workItemDetail` mirror + PanelHeader `REQ-xxxx`; × or any chat/panel intent — session select, 新建会话, 继续对话, run-contract, panel switch, workspace switch — clears it; `closeWorkItemDetailRequest` request-counter clears the manager's selection). Mobile omits `workItemSplit` — the detail replaces the list in place there. 归档 is `ArchiveModal embedded`. 设置 is `SettingsPanel` (`components/SettingsPanel.tsx`): iOS-settings index → 工作区 (WorkspaceManager; hidden at home) / 模型 / Skills / 插件 / 偏好 (theme + language; the former `SettingsBar` is retired). **On desktop the settings index keeps ALL its rows visible permanently (subpages render in the RIGHT column, the index row just highlights — `desktopSplit` in SettingsPanel); the 模型/Skills/插件 rows are HIDDEN there entirely (rail icons are the entry). On mobile (no prop) the rows keep the in-panel subpage navigation, which renders the former modals in `embedded` mode (fill container, own header suppressed); 归档 stays an index row on mobile only (desktop's rail already has the archive icon).** **The 设置 › 工作区 subpage is ALSO a desktop three-column split view**: the middle column keeps the WorkspaceManager's workspace LIST (its `split` mode renders the rail inline — no manager chrome — and `onSelectedWorkspaceChange` reports the rail selection up for the right-column header) while the selected workspace's settings DETAIL portals into the same right-column config area (`configPortalNode`, PanelHeader 工作区设置; × returns to the settings index). 偏好 (preferences) renders in the right column too (PanelHeader 偏好; no portal — PreferencesPage is mounted directly). The right-column branch condition is `!isMobile && (configView || workItemDetail || (sidebarView === "settings" && settingsPage !== "index"))` — configView wins when both apply; on the 工作区 subpage the workspace list rail renders in the middle column BELOW the index rows (the WorkspaceManager in `split` mode is mounted under them only while `settingsPage === "workspace"`). On mobile the subpage stays the single-column `panel`-mode WorkspaceManager (`panel={isMobile}` — desktop drops `panel` so the rail shows). The remaining `WorkspaceManager` modal is the home create-workspace wizard only.

**Persistence**: module views per workspace (`pi-active-view:<wsId>`), global panels under one `pi-active-panel` key (settings survives workspace switches; archive is transient). Legacy URL views (settings/work-items/loops) map onto panel switches in `applyUrlToTabs` by writing the storage key BEFORE activating the tab (the activeWorkspace effect re-derives `sidebarView` from storage and would clobber an immediate setState); `buildTabQuery` only emits overview/chat.

- **工作台** — the merged 会话 + Explorer view: two stacked collapsible sections. Upper **会话** (chevron + label + count header;
  fixed 40% share with internal scroll while 文件 is open — NOT content-driven, the split stays stable; flexes to fill when 文件 is
  collapsed); lower **文件** is collapsible too and **collapsed by default** — when collapsed only its header bar shows, pinned to the
  panel bottom (`marginTop:auto` on the files container absorbs leftover free space AFTER flexing, so it is a no-op while the body
  grows), and the `[ 文件 | 改动(N) ]` segmented tabs (`pi-explorer-tab:<wsId>`, git repos only) render only while open. Both
  sections' collapse state persists per
  workspace in `localStorage` key `pi-workbench-sections:<wsId>` (per-key defaults: 会话 open, 文件 collapsed;
  `WorkbenchSectionHeader` has no `collapsible` prop anymore — both headers are chevron-togglable). The panel header carries a **WorkspaceSwitcher**
  (current workspace name + ▾ → workspace dropdown, select to switch) plus the ＋ 新建会话 button.
- **知识库** — **only `kind === "knowledge"`** repositories; each is an **OKF (Open Knowledge Format v0.2)** bundle
  (Markdown + YAML frontmatter) browsed via a `FileExplorer` pointed at `knowledge/<alias>` (flat layout — sibling of `repositories/`, per `workspaceRepositoryPath`). A newly
  `init`'d bundle is seeded with `index.md` (progressive-disclosure entry), `log.md`, and a `concepts/welcome.md`
  example concept (`lib/workspaces/okf.ts`, `renderOkfSeed`); a `clone`d bundle keeps the remote structure untouched.
  **L0 access is always built-in** — `read`/`ls`/`grep` need no tool. The view has an "open index.md" hint as the L0
  entry point. Ranked retrieval augmentation (`kb_search`) is **opt-in**: the tool is mounted automatically when the
  `knowledge` capability is on, and searches across all active bundles (see "kb_search" below).
- **Loop** — the loop list itself: each loop row shows name + trigger summary with ▶ manual-trigger and ⚙ edit (opens the `LoopConfig` editor IN the middle column — temporarily widened); clicking a loop expands its **run records** in place (`GET /api/workspaces/[id]/loop/runs?loopId=` — web-process read of `RUNS.jsonl`, deduped latest snapshot per run). v3: runs are thin **selection rounds** — a run row with `seededSessionId` opens the seeded **execution session** (badge 已播种); unseeded runs open the selection orchestrator. Non-terminal runs poll every 5s while expanded.
- **工作项** — the FULL WorkspaceManager work-item surface (筛选/详情/对话链接/归档) as a middle-column panel; on desktop the detail opens in the RIGHT column via `workItemSplit` (list stays in the middle column — see the navigation section above) (`panel` mode: manager chrome header hidden — the PanelHeader already titles it — rail hidden, single column; rows/toolbars/detail compact below a 480px container query because the middle column is drag-resizable 200–560px while the full 5-col row alone needs ~410px). NOTE: same-specificity panel overrides in WorkspaceManager's styled-jsx sheet must stay AFTER the base rules — placed before them the cascade silently reverts them (the original bug: body kept the 280px rail track and the whole pane overflowed the column).

Mobile is a **separate shell with real bottom-tab navigation** (see "Shell split" below): `MobileShell` renders 36px tool strip (`ChatToolbar`, ☰ hidden — the drawer is gone) → WorkspaceTabBar → a tab-switched main area → **bottom tab bar** (`会话 → 工作台 → 知识库/Loop/工作项 (capability-gated) → 设置`, landing on 会话, persisted per workspace under `pi-mobile-tab:<wsId>`). Tapping a tab switches the main area; tapping the active tab is a no-op. 会话 = the current chat itself; with no session open it renders the fresh-session composer directly (no placeholder page — and never a pre-created session, pi creates the .jsonl only on first send); picking a session in 工作台 switches to the 会话 tab via the shared `chatFocusKey` signal. The chat stays mounted (hidden via `display:none`) across tab switches so SSE never breaks. Secondary pages use per-tab stacks with ‹返回 PanelHeaders: the Loop editor (Loop tab), archive (设置 tab — settings/work-items manage their own in-panel subpages); knowledge-file viewing uses the full-screen file overlay (the old right panel). Home renders full-screen without the tab bar. **Don't reintroduce a drawer or stacked focus views** — a new module gets a tab (register it in `ACTIVITY_VIEW_ORDER` + `TAB_ORDER`/`TAB_CAPABILITY` in MobileShell), not a new overlay. (Collapsible sections *inside* the 工作台 view
are fine — they are view content, not navigation.)

**Shell split (mobile tab refactor):** `AppShell` is a thin dispatcher — `useAppShellState()` (`components/shell/useAppShellState.ts`) owns ALL shared state (workspace tabs, sessions, SSE wiring, panel selection, persistence) and provides it via `components/shell/context.tsx` (`useShell()`); the state layer has **no `isMobile` branches** — cross-shell navigation intents travel as focus signals (`chatFocusKey` bumped by every chat-opening handler, `panelFocus` for the work-items create flow) that only MobileShell reacts to. **The shell choice must be correct in the FIRST HTML response**: `app/page.tsx` (async server component) sniffs the User-Agent into `initialIsMobile` and passes it to `AppShell`, which seeds `useViewportIsMobile(initial)` — the value drives BOTH the SSR render and the hydration render (no mismatch), then a mount effect corrects a wrong UA guess against `matchMedia(≤640px)`. `AppShell` provides the resolved flag via `IsMobileContext`; every `useIsMobile()` caller reads that context (zero per-caller subscriptions, one source of truth) and falls back to a standalone viewport hook only outside the shell tree. Without the server seed phones SSR the desktop shell and flip only after full hydration — seconds on a slow device. `DesktopShell.tsx` renders the three-column layout (rail + resizable middle column + center/right columns) migrated verbatim; `MobileShell.tsx` renders the bottom-tab navigation. `ChatToolbar.tsx` is the shared 36px tool strip (theme/language/history/auto-name/branch/system/token stats + dropdown panels) rendered by both shells. Shell-agnostic overlays (home create-workspace wizard, DirectoryPicker, ProjectTrustDialog) render in AppShell for both.

**Desktop middle column is drag-resizable.** The width is a CSS var (`--pi-sidebar-width`, default `260px`) set inline on
`.sidebar-container` from the shared `sidebarWidth` state; a thin `.sidebar-resize-handle` strip (sibling of the
container, desktop + open only) drives it via `onMouseDown` window listeners. Width persists in `localStorage`
(`pi-sidebar-width`), clamped `[200, 560]`; double-click the handle resets to 260. Mobile keeps a fixed 280px drawer
(its CSS overrides the var, and the handle isn't rendered). During drag a `sidebar-resizing` class disables the
open/close `width` transition so it tracks the cursor instantly.

### Work Items (`lib/work-items/`)

File-backed **Requirements (`REQ-####`)** and **Bugs (`BUG-####`)**. Storage under
`<workspace>/<requirements|bugs>/<KEY>-<slug>/`:

- `item.yaml` — structured metadata (status/phase/priority/repositories/conversations/…), `schemaVersion 1`.
- `README.md` — human body. **Original Description is preserved verbatim**; later analysis is appended, never overwriting it.
- `events.jsonl` — **append-only** timeline (id/at/type/actor/optional conversationId/data). Never rewrite it.

Key behavior:
- `listWorkItems()` reads ONLY `item.yaml` per directory (README/events are detail payloads — reading them here was the list hotspot) and returns `{ items, archivedItems, invalid }` in ONE pass — the sidebar's active+archived fetches and the importer dedup index (active ∪ archived) both consume this single result.
- The `KEY` counter lives in `manifest.work_items.next{Requirement,Bug}Number` and is incremented under the workspace
  write lock (`reserveWorkItemKey`).
- Updates take `expectedRevision` (optimistic concurrency); appending a milestone via `recordWorkItemMilestone` does
  **not** bump the revision.
- The pi extension (`work-items/extension.ts`) registers `workspace_list_work_items`, `workspace_get_work_item`,
  `workspace_create_work_item`, `workspace_update_work_item`, `workspace_record_milestone`.
- **来源展示**: items carrying `external` (importer-written) render their provenance — 详情「来源」行（禅道 #id ↗ + 最近同步时间）+ 列表 KEY 旁「禅道」小徽章（`source-labels.ts` 的标签映射；手动创建的项无此字段，不加徽章）。
- **Archive cascade** (`lib/archive-cascade.ts`): archiving a work item tucks its conversations into the session
  archive **only if no other active work item references them**; restoring brings them back. Sessions are physically
  moved to a `.archived/` subdirectory (`lib/session-archive.ts`) so `SessionManager.listAll()` no longer sees them.

### Loop (`lib/loop/`)

**v3 (`docs/dev-loop-v3-design.md`): the loop is a thin selector+seeder.** A run is one short **selection round**; execution is a **normal session** anchored to a work item, running the workspace's own skill contract. Gates are chat turns backed by `loop.gate` milestone stamps — the dedicated gate machinery (state machine, rehydration, LoopStatusBar, 409-for-executors) is retired.

Per-loop files under `<workspace>/loops/<loopId>/`: `loop.yaml` (triggers), thin `LOOP.md` (~15 lines: liveness + park keywords + pick KEY → `LOOP_SEED: <KEY>` / `LOOP_VERDICT: idle|no candidate`), `RUNS.jsonl` (append-only run snapshots; a seeded run records `seededSessionId`), `LEARN/` archive. The **contract** lives in `<workspace>/.agents/skills/<loopId>/SKILL.md` (loop id === skill name; must also be listed in `manifest.skills` — the workspace `skillsOverride` filter gates `/skill:` expansion too). **Roles** live in `<workspace>/.pi/agents/*.md` (subagent discovery; the seeder injects them via `extraAgentDirs`, no approval gate).

Round lifecycle (`runtime.ts` + `pi-execution.ts` + `seed.ts`):
1. **trigger** (`host.ts`) — dedups by `(workspace, loop, eventId)`; cron from `LoopHostScheduler` (30s tick, per-minute slot dedup).
2. **startRound** (`pi-execution.ts`) — starts a selection orchestrator AgentSession (rpc key `__loop_host__${run.id}`), runs the thin LOOP.md as the first prompt, bounded by a **30-min timeout** (`RUN_TIMEOUT_MS`) that rejects → run `failed`; a throttled 60s `onProgress` heartbeat keeps the run card alive.
3. **seed** (`seed.ts`) — on settle, the engine (deterministic code, never an LLM) regex-parses `LOOP_SEED: <KEY>` and calls `seedExecutionSession`: **double-open guard** (last `loop.active_session` stamp + wrapper-liveness probe + item terminality — live wrapper or idle-but-active-≤2h blocks; stale stamps are always harmless, no cleanup exists) → create a normal session (one-time key, cwd=workspace root, `extraAgentDirs=[<ws>/.pi/agents]`, deterministic name `<KEY> <title>`) → seed prompt `/skill:<loopId> 执行 <KEY>` (pi's input expansion mechanically injects the contract — `/skill:` is expanded by the SDK `AgentSession`, so the daemon-side send path gets it for free) → link `conversations` + stamp `loop.started`/`loop.active_session` → **hands off**. Guard refusals/errors are logged, never fail the selection run. Zombie finding is remind-only: the idle verdict lists 疑似中断 items (non-terminal phase + events quiet >2h); humans adopt via the work-item button.
4. **abort/timeout** — `session.destroy()` (aborts the in-flight prompt) + `reapOrphanedRoundProcesses` (SIGTERM→SIGKILL bash/npm/mvn trees still scoped by workspace cwd — kept for selection rounds; a user-killed *execution* session has the same orphan exposure as any normal session kill, surfaced by the zombie report).

The web layer: `/api/workspaces/[id]/loop/**` calls `daemonClient` (`lib/daemon/client.ts`) for list/trigger/run/abort + `POST /v1/workspaces/:id/seed` (the work-item buttons use it too — in a loop-capable workspace 「开始对话」(no conversations yet) = execute seed, 「收养续跑」 = adopt seed (both via `POST .../work-items/[key]/run-contract`), 「继续对话」 = open the latest conversation as a chat tab (the skill is already in its context). All entry points share one guard, one prompt shape, one bookkeeping path). `lib/loop/authoring.ts` writes `loop.yaml`/`LOOP.md` directly in the web process; the runs route is a plain web-process read of `RUNS.jsonl`.

**Execution sessions are first-class normal sessions.** They appear in the sidebar, hang off their work item via `conversations` (the item detail renders them as clickable links), accept steering messages at any time, and ask gates as ordinary turns — the SKILL.md contract requires stamping `loop.gate{kind,question}` (via `workspace_record_milestone`) *before* asking, which is also the UI's 待-decision audit signal. Manual trigger UX (`AppShell.handleLoopTriggered`): optimistic placeholder → poll the selection round → auto-open the seeded execution session when `seededSessionId` lands.

**Session-list routing of orchestrators (`lib/loop/session-tags.ts`).** `/api/sessions` tags every selection orchestrator `loopOrchestrator: true` (30s-cached RUNS.jsonl scan; no work-item join anymore) and the sidebar/home lists hide them — their only entry is the Loop view's run record (which opens `seededSessionId` first). Execution sessions are NOT tagged — they surface via their work item like any conversation.

### Subagent (`lib/subagent/`)

**Real isolated sessions**, not a subshell. The `subagent` tool (`extension.ts`) delegates a task to a specialized
agent running as its **own first-class AgentSession** (own context window, model, tools), linked to the parent via
`parentSession`. Modes: single `{agent, task}` or parallel `{tasks:[{agent,task,cwd?}]}` (max 8, concurrency 4).
Only streamed status + final result return to the parent; the full child run is viewable by opening its child session.

- **Agent discovery** (`agents.ts`): `~/.pi/agent/agents/*.md` (user, default), `<projectRoot>/.pi/agents/*.md`
  (project — repo-controlled, gated by a `ctx.ui.confirm` approval unless `confirmProjectAgents:false`), and injected
  loop agent dirs (highest precedence, no gate). `projectRoot` is resolved worktree→main repo so all worktrees share
  agents. Markdown frontmatter: `name`, `description`, optional `tools`, `model`. Built-in `general` fallback.
- **Always global**: `lib/rpc-manager.ts` attaches `createSubagentExtension(...)` to **every** session regardless of
  workspace. It is intentionally **not** in `WORKSPACE_EXTENSION_FACTORIES` or `ALL_WORKSPACE_CAPABILITIES`.
- **Child registry** (`registry.ts`): child session ids are appended to `~/.pi/agent/subagent-children.txt` so the
  sessions API tags them `subagentChild: true` and the sidebar hides them (they're openable only from the parent's
  result card). Append-only + mtime-cached because the daemon creates children in a different process.

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
  expanded, nested repo groups to collapsed; only clean repos produce no group). In `WorkspaceSidebar` the Changes list
  is **no longer a standalone section** — it is
  a `[ 文件 | 改动(N) ]` tab inside the 工作台 view's **文件 section** header (redesign decision 8), following the Explorer's current cwd
  scope; `ChangesPanel` itself is unchanged. Tab choice persists in `localStorage` key `pi-explorer-tab:<wsId>`;
  non-git directories hide the "改动" tab. `SessionSidebar` keeps its own standalone Changes section.

### Importer (`lib/work-items/importers/`)

**Inbound work-item source adapter** (design: `docs/autonomous-dev-loop.md`). The first (and currently only) adapter is **Chandao (禅道)**. This is the P0+P1 slice; the dev Loop / evolution are later cycles and **not** here.

- **Capability**: `requirement-sources` (registered in `ALL_WORKSPACE_CAPABILITIES`; toggled per-workspace, NOT in the init checklist). It gates the config UI + the cron runner. It is **not** an LLM extension (the runner is deterministic I/O, no tools).
- **Importer SPI** (`types.ts`): `listAssigned/getDetail/getAttachment` — the deep-module seam hiding REST+token+image-binary behind three methods. Swapping Chandao for Jira changes one adapter, not the runner.
- **`ChandaoImporter`** (`chandao-importer.ts`): REST+Token (`POST /api.php/v1/tokens`, **not** the web-login md5 flow). Token cached in-memory, **re-signed once on 401** via account+password. Field differences hidden (bug `steps` vs task `desc`; task list title is `name`). `fetch` is injectable for tests.
- **Credentials** (`config.ts`): `~/.pi/agent/importers/<workspaceId>.json` (mode `0600`); `toPublicConfig` never leaks password/token. Shape `{chandao:{base,account,password,token?,assignee,productId,executionId}}`.
- **Images** (`images.ts`, pure): `extractChandaoFileIds` / `rewriteChandaoImageSources` / `detectImageExt` (magic-byte sniffing). The runner downloads each `fileID` via `GET /api.php/v1/files/{id}` and rewrites README `<img src>` to a relative `attachments/<kind>-<id>.<ext>` so the work item renders offline and travels into git.
- **Runner** (`runner.ts`): `syncImporterForWorkspace(id)` is the deep-module seam hiding pull→dedup→create→localize-images→event. Per item: dedup by `external.source:sourceId`; not-exists→create (bug→`BUG-####`, task→`REQ-####`, KEY from `manifest.work_items.next{Bug,Requirement}Number`), download+persist images, append `imported` milestone; exists&open→`imported` sync heartbeat; archived→skip. Per-item errors recorded, never abort the run. **Deterministic I/O — never delegated to an LLM.**
- **Work-item `external` field**: `WorkItemExternalRef {source, sourceId, url?, lastSyncedAt}` added as an **optional** field on `WorkItemRecord`/`CreateWorkItemInput` (design §4/§5). Serialized as a snake_case `external:` block in `item.yaml`. Stamped at creation by the Importer only; the LLM work-item tools don't touch it. The dedup key.
- **Runner lives in the daemon, NOT the web server**: `ImporterScheduler` (`scheduler.ts`) is a **non-Loop system job** (30min) registered into the daemon's `DaemonJob` registry (`lib/daemon/jobs.ts`) — a registered peer of the loop trigger cron, independent of the Loop engine. **`instrumentation.ts` is untouched** (web server holds no timers — design §5). The daemon also exposes `POST /v1/workspaces/:id/importers/sync` for manual/webhook. The importer is the work-item domain's inbound adapter: SPI + adapter registry (`adapters.ts`), cron, runner, HTTP route all live under `lib/work-items/importers/`; swapping Chandao for Jira = one adapter + one line in `adapters.ts`. Work items render their source (详情「来源」行 + 列表 KEY 旁徽章, label map in `source-labels.ts`).
- **Web manual sync** (`app/api/workspaces/[id]/importers/sync/route.ts`): forwards to the host; **falls back to an in-process run if the host is down** (a one-shot sync is not a timer, so this does not violate "web owns no timers").
- **Config UI**: `components/ImporterConfig.tsx` (capability toggle + credential form + "测试连接"), mounted in `WorkspaceManager`.

### Dev Loop (per-workspace custom loop; reference: workspace-c)

**Loops are per-workspace custom definitions — pi-web ships no loop templates.** The generic engine (`runtime`/`pi-execution`/`store`/`scheduler`/`authoring`) is domain-agnostic; every loop's behavior lives in its workspace (`loops/<loopId>/LOOP.md` + `agents/*.md` + `loop.yaml`), authored/edited via the generic loop surface (`LoopConfig` / `lib/loop/authoring.ts`). There is **no dev-loop code path in pi-web** (the former `lib/loop/dev-loop/` template + `install.ts` + `POST /api/workspaces/[id]/dev-loop` route are retired — a loop is created like any other loop definition).

The **dev Loop** is the R&D loop pattern deployed in cxin (workspace-c), **v3** (design: `docs/dev-loop-v3-design.md`; v2 history: `docs/dev-loop-v2-design.md`). v3 shape: thin selection round → deterministic seed → normal execution session running the **skill contract** (`.agents/skills/dev-loop/SKILL.md`). It uses **only existing tools** (work-item tools, bash, edit, subagent, kb_search); no new tools injected. Its contracts are worth documenting because other workspaces can copy the pattern:

- **Four-layer SKILL.md** (moved from LOOP.md in v3): ① role menu (contracts: must-run **evidence** / optional / always) ② hard invariants — L0 branch/merge discipline plus orchestration bounds **N1 maker≠checker, N2 full gate exactly once before merge, N3 never split across coupling points** ③ composition rules + the **dispatch plan** as an explicit artifact (`loop.dispatch{steps[]}` milestone; illegal plans are re-composed, bounded ≤2; the plan gate can veto the composition) ④ recovery contract (adoption = the 收养 seed verb, resume from dispatch plan + milestone gaps — "most mature artifact", not sequence position). Plus an **opening step** (absorbed from the retired selector): triple judgment (predictedConf immutable / verifiable / riskTier) + data-flow quick screen + evidence pack + thin-SPEC write-through for pure-display items — identical for both entry points (cron seed & 按合同执行 button).
- **Roles** (`.pi/agents/*.md`, all subagents; selector retired in v3 — selection lives in the thin LOOP.md, judgment in the SKILL opening): **brainstorm** (全链路 trace UI→SQL + 反证, strongest model, produces `SPEC.md` = what-contract **+ task DAG** — coupling analysis decides split lines; `repos[]` is the repo-set authority; emits `tracedConf`, never overwrites `predictedConf`); **writing-plans** (optional plan step — only in the dispatch plan when multi-task/sensitive/multi-repo; produces `PLAN.md` = in-task steps + test plan w/ wiring coverage; cross-task ordering belongs to the SPEC DAG, never re-ordered here; re-dispatchable on plan-defect rework); **implementer** (TDD maker, **one instance per task** with per-task branch/worktree; single baseline per workspace AGENTS.md — worktrees and diffs from the declared cut baseline (cxin: `origin/master`), merge-target alignment before delivery (integration-ready); self-contained plan section when no standalone plan step; bounded fix loop, 5-round shared budget); **checker** (v2 merge of reviewer+verifier — the **single check seat**, join point after all tasks `impl_ready`; **review-then-run**: audits the full diff three ways (SPEC compliance / README 原始验收点 vs spec misreads / quality) before spending the single full gate; verdict worst-wins per-repo; rework list carries `<taskId> <file>:<line> <问题> <期望> <source: code|plan|spec>` — the orchestrator routes by source: code→implementer, plan→writing-plans, spec→contract-correction path; may be split back into reviewer+verifier seats for sensitive large items); **learner** (knowledge **consolidator**, see Learn below).
- **Gates (three kinds, all terse)**: plan gate (non-all-green only — human reviews SPEC **+ dispatch plan**, may veto the split/composition; one-shot all-clarifications); final-verify (post-merge); **contract-correction gate** (the only L0 exception slot, rare: a gate-approved SPEC judged to misread the README by checker goes back to the human with 3 terse options instead of a silent rework — skip-gate SPECs just get fixed against README, no extra gate). v3 semantics: a gate = **stamp `loop.gate{kind,question}` then ask tersely and end the turn** — the human answers in the composer like any message; no protocol machinery.
- **Install/authoring**: none special — the loop is a plain loop definition created via the generic loop authoring surface; its files are edited directly in the workspace (old copies in workspace-c keep `.bak` siblings).
- **No `checkers.ts`**: checker commands live in the workspace's own AGENTS.md; the full gate's only definition is the AGENTS.md repo gate command (targeted = file/module-level, used inside fix loops).
- **Phase mapping** (unchanged): 待开发=`intake` → 待计划评审=`plan_approval` → `implementation` → 待评审=`verification` → `complete`+`done`; 受阻=`blocked`.
- **PR = push branch** (no `gh` CLI): merge to the integration branch per-repo in the run worktree via temp branch `loop-integ/<runId>`; master is human-merged only (L0①).
- **API**: generic loop routes only (`/api/workspaces/[id]/loop/**`); no dev-loop-specific route.

### Learn (archive inline; consolidation via the `learner` agent)

**Qualitative knowledge transfer via consolidation, not per-run archiving.** Knowledge lives ONLY in KB `learnings/` notes, kept sharp by merging; run records are archives nothing reads for decisions.

- **Learn step** (terminal; idle runs excluded): the orchestrator ① writes `LEARN/<runId>.md` — a human-browsable archive (lesson candidate, learner's disposition, index fields incl. **both** `predictedConf` and `tracedConf` so the calibration chain closes; idempotent replace) and ② dispatches the **`learner`** only if a candidate exists. **`LEARN.jsonl` is retired/frozen** in place (its old `humanDecision` narrative was the "summarizing the run" failure mode).
- **learner = consolidator**: two-question generalization test — (1) is it still a rule with specifics deleted? (2) is it an instance of an existing rule (`kb_search`)? Then: merge-and-sharpen into an existing loop-owned note (abstraction lift **allowed but must stay instance-anchored**; trigger scenario inlined into the note's instance section) OR open a new file referencing near-kin. **`contentHash`** frontmatter guards against overwriting human edits — mismatch ⇒ the note is human-authoritative, degrade to new-file+reference.
- **Single home**: everything loop-written goes to `learnings/` (module traps too, with strong module tags); `standards/*` is **purely human-maintained** (the old "loop append" clause is gone — it had no executor). One note touched/created per run max.
- **Three artifacts, three purposes**: KB `learnings/*.md` = consolidated generalizable rules (loop-maintained via hash guard); `standards/*` = human-maintained; `LEARN/<KEY>-<date>.md` = per-execution archive (nothing parses it; the SKILL opening may `ls -t` it for calibration).
### cxin reference (研发 Loop target workspace)

- **dev Loop instance**: `~/.pi/workspaces/workspace-c/` at **v3** — thin selection `loops/dev-loop/LOOP.md` (v1/v2 baks kept as siblings), contract in `.agents/skills/dev-loop/SKILL.md` (+`dev-loop` in manifest `skills:`), five roles in `.pi/agents/` (selector retired; baks `agents.v2.bak/`). `LEARN.jsonl` frozen, `LEARN/` archive dir live. Seeded execution sessions carry `loop.gate`-stamped gate turns + `loop.active_session` double-open stamps. Sensitive module list + module→repo map: `cargo-knowledge/standards/dev-loop-modules.md`. Consolidated process lessons in `cargo-knowledge/learnings/` (5 notes incl. the v2 backfill merge "trace 覆盖不可见层", all contentHash'd).
- **Host wiring**: the daemon's job registry (`lib/daemon/jobs.ts`) registers `ImporterScheduler` (importer-sync) alongside `LoopHostScheduler` (loop-triggers). None runs in the web server (`instrumentation.ts` untouched).

### Workspace directory layout (reference)

```
~/.pi/
  workspace.yaml                         global workspace index
  workspaces/                            ($PI_WORKSPACES_DIR)
    workspace-<slug>/
      .pi/workspace.yaml                 manifest
      .gitignore  AGENTS.md              (software-development template)
      requirements/<KEY>-<slug>/{item.yaml, README.md, events.jsonl}
      bugs/<KEY>-<slug>/...
      designs/  plans/
      repositories/<alias>/              code repos (clone or init), flat layout
      knowledge/<alias>/                 knowledge bundles (OKF; flat, sibling of repositories/)
      loops/<loopId>/{loop.yaml, LOOP.md, [LEARN.md, LEARN.jsonl,] RUNS.jsonl, agents/, audit/}
    .pi/workspace-templates/<id>/        custom templates (template.yaml + seed/)
  agent/                                 (~/.pi/agent)
    sessions/<encoded-cwd>/*.jsonl
    agents/*.md                          user subagents
    importers/<workspaceId>.json         chandao importer credentials (0600)
    subagent-children.txt                child session id registry
```

---

## File Map

```
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
  workspaces/route.ts                    GET list+templates | POST create/import a workspace
  workspaces/[id]/route.ts               GET | PATCH (capabilities/name/skills) | DELETE
  workspaces/[id]/repositories/route.ts  GET | POST add(clone/init) | DELETE soft-remove | PATCH restore
  workspaces/[id]/work-items/route.ts            GET list | POST create
  workspaces/[id]/work-items/[key]/route.ts      GET | PATCH (revision-safe) | DELETE trash
  workspaces/[id]/work-items/[key]/events/route.ts   POST record milestone
  workspaces/[id]/work-items/[key]/content/route.ts  PUT update README body
  workspaces/[id]/loop/loops/route.ts            GET list | POST author a loop definition
  workspaces/[id]/loop/loops/[loopId]/route.ts   GET | PATCH | DELETE a loop
  workspaces/[id]/loop/loops/[loopId]/trigger/route.ts  POST manual trigger
  workspaces/[id]/loop/runs/route.ts             GET ?loopId= — sidebar run records (RUNS.jsonl latest snapshot per run; v3: plain runs, no join)
  workspaces/[id]/loop/runs/[runId]/route.ts     GET a run
  workspaces/[id]/work-items/[key]/run-contract/route.ts  POST 开始对话(execute)/收养续跑 seeding (daemon seeder proxy)
  workspaces/[id]/importers/route.ts             GET/PUT/DELETE chandao importer credentials
  workspaces/[id]/importers/test/route.ts        POST test chandao connection (listAssigned)
  workspaces/[id]/importers/sync/route.ts        POST manual importer sync (forward to host / in-process fallback)
  workspaces/[id]/loop/**                 generic loop mgmt/trigger/run (no dev-loop-specific routes; gate route retired in v3)
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
  abort-race.ts             raceAbort (promise vs AbortSignal, with onLateSettle cleanup) + creationTimeoutSignal — bounds session CREATION everywhere a startRpcSession hang would pin a turn/run (subagent spawn, loop orchestrator, seed)
  rpc-manager.ts            DAEMON-ONLY session registry + AgentSessionWrapper + startRpcSession (extension/skill/workspace wiring). No web-process code may import it — web routes proxy through lib/agent-proxy.ts
  workspaces/
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
    importers/              requirement-sources inbound adapter (design: autonomous-dev-loop.md) — the work-item domain's data inlet
      types.ts              Importer SPI (listAssigned/getDetail/getAttachment) + config shapes
      adapters.ts           adapter registry (chandao → ChandaoImporter) — add Jira here
      source-labels.ts      UI-safe source→中文标签 map (禅道)
      config.ts             chandao credentials ~/.pi/agent/importers/<wsId>.json (0600)
      images.ts             PURE extractChandaoFileIds / rewriteChandaoImageSources / detectImageExt
      chandao-importer.ts   ChandaoImporter: REST+Token API (POST /tokens, 401 re-sign), injectable fetch
      mapping.ts            PURE mapSourceKindToWorkItemType + buildExternalIndex (dedup)
      runner.ts             syncImporterForWorkspace — pull->dedup->work item->images->event (deep seam)
      scheduler.ts          ImporterScheduler — NON-Loop 30min system job (DaemonJob) registered into the daemon
      http.ts               /v1/workspaces/:id/importers/sync daemon route (DaemonRouteHandler)
  loop/
    types.ts                LoopDefinition / LoopRun / LoopRuntime / RoundExecutionBackend (v3: no gate types)
    http.ts                 loop engine routes (triggers/runs/abort/seed) — a DaemonRouteHandler registered into the daemon
    runtime.ts              DefaultLoopRuntime — lifecycle only (queued→running→succeeded|failed; records seededSessionId)
    seed.ts                 v3 deterministic seeder: parseLoopSeed/buildSeedPrompt/evaluateSeedGuard (pure, tested) + seedExecutionSession (guard → normal session + /skill:<loopId> prompt + conversations/loop.started/loop.active_session stamps) — one code path for cron seeding and the work-item button
    pi-execution.ts         PiRoundExecutionBackend — drives the single selection round + engine-side seeding on LOOP_SEED; abort/timeout reaps orphaned round processes
    process-cleanup.ts      reapOrphanedRoundProcesses — SIGTERM→SIGKILL bash/npm/mvn trees a destroyed session leaves behind (scoped by workspace cwd)
    store.ts                loop.yaml / RUNS.jsonl read+append, validation
    authoring.ts            create/update/delete loop definitions (writes files in the web process)
    scheduler.ts            cron evaluation + per-minute dedup (LoopHostScheduler implements DaemonJob; runs in the daemon only)
  daemon/                           THE pi-daemon: session-owning process + job registry (C2)
    host.ts                 createDaemon() composition root — /health, route chain (sessions → loop → importers), startDaemon (PI_DAEMON_HOST/PORT, legacy PI_LOOP_* fallbacks)
    http-sessions.ts        /v1/sessions/** surface (create/commands/probe/SSE/running/live/busy/reload-cwd/auto-name/teardown)
    jobs.ts                 DaemonJob {id,start,stop} + registry — domains register background jobs here
    http.ts                 shared route plumbing (DaemonRouteHandler, body/json, error→status)
    client.ts               daemonClient — HTTP client to the daemon (PI_DAEMON_URL, legacy PI_LOOP_URL fallback): session-daemon surface + loop mgmt + seedExecution + importer sync
    rpc-manager.ts          DAEMON-ONLY session registry + AgentSessionWrapper + startRpcSession (moved here from lib/ root — the daemon domain's core)
    session-heartbeat.ts    stall classify/warn/kill snapshot (moved with rpc-manager)
  session-daemon/                   sidecar lifecycle for the session daemon (C2)
    sidecar.ts               ensureSessionDaemonStarted (probe→attach / spawn detached) + pure guards (decideSidecarAction, spawnableDaemonUrl, sidecarSpawnEnv)
    workspace-resolver.ts   PiWorkspaceResolver (lists loop-capable workspaces)
    web.ts                  error → HTTP mapping
  (dev-loop/ retired — loops are per-workspace custom definitions; the R&D loop pattern lives in workspace-c, see Dev Loop section above)
  subagent/
    extension.ts            `subagent` tool (single/parallel) + project-agent approval gate
    worker.ts               spawn real child AgentSessions; stream usage + display trail
    agents.ts               discover agents (user / project / loop dirs), built-in "general"
    registry.ts             append-only child-id registry (~/.pi/agent/subagent-children.txt)
  git-changes.ts            getGitStatus (multi-repo groups) + getGitFileDiff (patch)
  git-status.ts             porcelain-v1 parse, status classify, buildRepoGroups (pure)
  git-discover.ts           walk tree to find nested repo roots (+ scattered files for file-index)
  git-types.ts              GitFileStatus / RepoGroup / response shapes
  session-reader.ts         index-backed SessionInfo mapping + buildSessionContext (tail window) + buildEarlierContext + path caches
  session-index.ts          persistent mtime-incremental session index (~/.pi/agent/sessions/.index.json, active + .archived; rebuildable cache)
  session-changed-files.ts  PURE deriveSessionChangedFiles — files written/edited in a session from the message stream (write/edit toolCalls + subagent displayItems; relative `file_path` args resolved against session cwd so openFile passes the /api/files allow-list; NOT git state; survives commits); isEditToolName consolidated here
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
  patch.ts, project-trust.ts, request-security.ts, path-security.ts, http-dispatcher.ts   security + routing
  npx.ts, skill-lock.ts, skill-message.ts, skills-service.ts, skill-updates.ts   skills/plugins plumbing (skill-message.ts also powers session titles: `skillMessageTitle` reduces pi's `/skill:` expansion wrapper — `header + SKILL.md body + </skill> + args` — back to the args or `/skill:name`, incl. a truncated-wrapper fallback for pre-v2 index clips; used by the session index, session-reader, locate route, auto-name, MessageView)

components/
  AppShell.tsx              thin dispatcher: useAppShellState → AppShellProvider → DesktopShell|MobileShell by viewport + shell-agnostic overlays (create-workspace wizard, DirectoryPicker, ProjectTrustDialog)
  shell/
    useAppShellState.ts     the shared shell-state hook — workspace tabs, URL restore, sessions, SSE wiring, panel selection/persistence, loop polling; NO isMobile branches (mobile intents = chatFocusKey/panelFocus signals)
    context.tsx             AppShellProvider/useShell — the shells consume the shared state
    DesktopShell.tsx        the desktop three-column render (rail + middle column + center + right panel), migrated verbatim from the former AppShell JSX
    MobileShell.tsx         the mobile shell: ChatToolbar + WorkspaceTabBar + bottom-tab-switched main area (会话/工作台/кnowledge/loop/work-items/settings, `TAB_ORDER`/`TAB_CAPABILITY`) + per-tab secondary stacks (loop editor, archive) + full-screen file overlay + persistent chat mount
    ChatToolbar.tsx         the shared 36px tool strip (theme/language/chat-scoped buttons/token stats + dropdowns); ☰ desktop-only
  HomeLanding.tsx           the workspace picker / home screen (desktop scrolling column; mobile one-screen two-zone layout: compact hero row + horizontal 工作区 chips + internal-scroll 最近会话)
  ActivityBar.tsx           the icon rail (desktop left strip / mobile fixed bottom bar): module group 工作台→知识库→loop→工作项 + separator + global group 模型→Skills→插件→归档→设置(bottom-pinned; the config trio renders in the RIGHT column, not the middle column); defines `SidebarView` + `ConfigView`/`isConfigView` + `ACTIVITY_VIEW_ORDER` + `RAIL_GLOBAL_VIEWS` (rail icon order) + `GLOBAL_ACTIVITY_VIEWS` (middle-column persistence surface: archive/settings only) + `visibleActivityViews()`
  PanelHeader.tsx           unified ~36px middle-column panel header (title + back + context actions + mobile ×) + PanelHeaderButton
  SettingsPanel.tsx         the 设置 panel — iOS-settings index → 工作区/模型/Skills/插件/偏好 subpages (mounts the config bodies in `embedded` mode)
  WorkspaceSidebar.tsx      middle-column content for module views (workbench/knowledge/loop-list under a PanelHeader) + the home workspace-list panel; 工作台 = stacked collapsible 会话 (fixed 40% share) + 文件 sections with [ 文件 | 改动(N) ] tabs (`pi-workbench-sections:<wsId>` persistence)
  WorkspaceManager.tsx      workspace create/import + settings (`embedded` in-panel, `panel` narrow single-column variant, `split` = desktop three-column mode: rail list inline + settings detail portaled into the right column's config area); remaining modal = home create-workspace wizard
  WorkspaceOverview.tsx     workspace dashboard — the unconditional landing view (quick actions incl. Loop trigger/manage, 活跃工作项, Loop 动态 run rows, 仓库/知识库 rows that navigate the sidebar, recent sessions with delete)
  WorkspaceTabBar.tsx       workspace switcher tabs (shortest-unique labels) + ＋ workspace picker (body-portal dropdown; select → open/switch workspace and land in chat view — handleOpenWorkspaceToChat; creating/importing workspaces lives on HomeLanding only)
  SessionSidebar.tsx        in-workspace session tree + FileExplorer + Changes section
  ChangesPanel.tsx          git changes list (flat or per-repo grouped)
  FileExplorer.tsx          file tree inside sidebar
  FileViewer.tsx            file content in a tab
  CapabilityToggle.tsx      the capability on/off switch used in settings panels
  LoopConfig.tsx            loop definition editor + create wizard (runs live in the sidebar Loop view; gate bar retired in v3 — gates are chat turns in execution sessions)
  ImporterConfig.tsx        requirement-sources (chandao importer) credential + test panel
  ChatWindow.tsx            chat composition + completion sound wrapper
  SessionChangedFiles.tsx   "本会话改动 N 个文件" toolbar button (right of the sound toggle in ChatInput) + slide-in drawer (desktop) / full-screen list (mobile); entries open the file via the openFile/file-tab pipeline
  ChatInput.tsx             input bar + model/thinking/tools/compact controls
  MessageView.tsx           renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx       in-session branch switcher
  ChatMinimap.tsx           scroll minimap alongside the message list
  MarkdownBody.tsx / MermaidBlock.tsx   markdown + mermaid renderers
  ModelsConfig.tsx          models.json editor (`split` mode = list in middle column + detail/footer portaled into the right column; `embedded` mode = settings-subpage body; `onSaved` refresh hook)
  PluginsConfig.tsx         installed package plugins panel body (`split`/`embedded` modes as above)
  SkillsConfig.tsx          loaded/search/installable skills panel body (`split`/`embedded` modes as above)
  ArchiveModal.tsx          archived sessions/items (embedded = the 归档 panel body)
  TabBar.tsx                chat + open-file tabs
  FileIcons.tsx / git-ui.tsx   file icon + git-status UI helpers

hooks/
  useAgentSession.ts        messages + streaming + SSE + fork/navigate/reconciliation logic
  useGitStatus.ts           polls /api/git/status for the Changes panel
  useSessionActivity.ts     running-session activity signals
  useGlobalAgentEvents.ts   global running-session SSE subscription
  useAudio.ts               completion sound + AudioContext unlock
  useDragDrop.ts            shared drag/drop state
  useKeyboardShortcuts.ts   global keyboard shortcuts
  useI18n.tsx / useTheme.ts / useIsMobile.ts   i18n / theme / responsive hooks (useIsMobile reads IsMobileContext — server-seeded UA guess, see Shell split)
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts` — daemon process)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`.
- **Session CREATION is abortable + bounded** (`StartSessionOptions.signal`): `startRpcSession` races creation against the signal (`raceAbort`, `lib/abort-race.ts`) — an already-aborted signal throws immediately, a hung creation (e.g. stuck network call in model resolution) rejects on abort/timeout, and a session that materializes late (after the caller gave up) is destroyed on arrival so no live zombie wrapper stays in the registry. Callers bound it: subagent `runWorker` (parent tool signal + 5-min timeout; failure degrades to a failed WorkerResult, not a throw), loop orchestrator + seed (`creationTimeoutSignal`, 5-min). Without this, a creation hang pinned the parent's turn, the daemon's `abort` path (which awaits idle), and the running set forever. The start-lock key for NEW sessions is a one-time `__new__<uuid>` — never `""`, which made concurrent creations (parallel subagents) coalesce onto the first session.
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
The `subagent` tool is attached to **every** session in `rpc-manager.ts` via `createSubagentExtension`, regardless of workspace or capability. It is intentionally absent from `WORKSPACE_EXTENSION_FACTORIES` and `ALL_WORKSPACE_CAPABILITIES`. Loop worker agents are injected per-session through `StartSessionOptions.extraAgentDirs` — and when a wrapper is cold-rebuilt from the `.jsonl` (idle eviction after a long gate wait, daemon restart) with no caller to re-pass them, `startRpcSession` re-derives `extraAgentDirs = [<workspace>/.pi/agents]` from the enclosing workspace, so loop roles keep their gate-exempt `loop` source instead of degrading to `project` discovery (which would hang unattended runs on a per-dispatch confirm dialog — the REQ-0027 lesson). The child-run timeout in `lib/subagent/worker.ts` is an **inactivity** budget (`RUN_TIMEOUT_MS`, re-armed on every child event), not a wall-clock cap: a still-streaming child never trips it, and on timeout the child is deliberately NOT aborted (quiet builds are legitimately eventless; the heartbeat monitor owns truly-hung children) — the parent gets a `childSessionId` hint and must verify the child's state before re-dispatching.

### The session daemon (C2 redesign): one process owns every AgentSession

The pi-daemon process (`npm run daemon` → `bin/pi-daemon.js` → `lib/daemon/host.ts`) — formerly the "loop host" — is **THE single session-owning daemon**, and a generic host for registered background jobs (`lib/daemon/jobs.ts`). Motivation for the original strangler: the old split — web process and loop host each holding AgentSessions, with the UI needing to answer "who owns session X" in six places (state probe, pin/reprobe, client-side badge merge, host probe, locate bypass, reducer promotion) — accreted a patch cluster that this redesign eliminates at the source. Strangler phases:

- **Phase 0 (done)**: all outbound/inbound channels removed (feishu/wecom/notify/exporters). The daemon surface is now purely sessions + loop + importer.
- **Phase 1 (done)**: daemon command surface + sidecar lifecycle (below). Web routes still own interactive sessions locally — nothing flipped yet.
- **Phase 2**: flip `/api/agent/new`, `/api/agent/[id]` (GET/POST), `/api/agent/[id]/events`, and the session lifecycle routes to pure proxies over the daemon client. The pin/reprobe/loop-badge-merge hacks retire here. The web proxy for create-session must call `allowFileRoot(cwd)` with the daemon's returned cwd (the files/git routes' allow-list lives in the web process).
- **Phase 3 (done)**: the web-side session registry is gone — no `app/`/`components/` code imports `lib/rpc-manager` (its header now declares it daemon-process-only; `notifyRunningChange` is module-private). The probe-404-fallback double-writer race is structurally impossible: the web process never constructs an AgentSession, so it cannot race the daemon for a .jsonl.

**Daemon command surface (`lib/daemon/http-sessions.ts`, mounted by `lib/daemon/host.ts`)**: `POST /v1/sessions` (create + optional pre-selected model/thinking/tools + optional first command — mirrors `/api/agent/new` including the one-time `__new__<uuid>` key), `POST /v1/sessions/:id/commands` (generic passthrough to `wrapper.send` — ANY command incl. extension UI responses; orchestrators are 409, everything else live-or-cold-started exactly like `/api/agent/[id]` POST), `GET /v1/sessions/running` (`{ids}` — the registry is keyed by real session id and contains interactive sessions + subagent children + orchestrators, so this one set is the complete running answer), plus the pre-existing `GET /v1/sessions/:id` probe and `/v1/sessions/:id/events` SSE. Client methods: `daemonClient.createSession/sendSessionCommand/runningSessionIds` (`lib/daemon/client.ts`).

**Sidecar lifecycle (`lib/session-daemon/sidecar.ts`)**: `ensureSessionDaemonStarted()` — probe `/health` (attach if healthy), else spawn `node bin/pi-daemon.js` detached+unref'd and wait (≤15s) for health. Wired fire-and-forget from `instrumentation.ts` (`PI_SESSION_DAEMON_DISABLED=1` opts out). In-flight guard on `globalThis` dedupes concurrent callers and retries after failure. Guards: `spawnableDaemonUrl` refuses to spawn for non-local `PI_DAEMON_URL` (legacy `PI_LOOP_URL` still honored; a remote URL means the daemon is managed elsewhere); `sidecarSpawnEnv` translates the URL → the child's `PI_DAEMON_HOST`/`PI_DAEMON_PORT` (explicit env wins, legacy `PI_LOOP_HOST/PORT` spellings honored) — without this a URL-only config spawns a daemon on the default port while the web polls the URL's port forever. Spawn races resolve quietly: the EADDRINUSE loser exits 0 (`bin/pi-daemon.js`). The "web owns no unattended timers" rule is preserved — daemon timers live in the daemon process and survive web restarts; the web only ever re-attaches by port probe.

### Loop runs in its own process; the web server only manages + proxies
`npm run daemon` starts the pi-daemon (`lib/daemon/host.ts`; `npm run loop` is a deprecated alias). The web server never starts loop timers (`instrumentation.ts`). Web routes for list/trigger/run/abort/seed are thin proxies over `daemonClient`; only authoring writes files directly. A selection orchestrator session physically lives in the daemon — the web server probes the daemon and proxies its SSE so it can be opened live. v3 execution sessions are normal daemon sessions (interactive registry), indistinguishable from user chats. The daemon hosts background jobs via the `DaemonJob` registry (`lib/daemon/jobs.ts`): loop trigger cron (`LoopHostScheduler`) and importer sync (`ImporterScheduler`) are registered peers. None of these touches the engine core or runs in the web server.

**Watching a live session (any session — interactive, subagent child, or orchestrator) is one mechanism now (C2).** The daemon owns every session; `/api/agent/[id]/events` is a pure pipe onto `/v1/sessions/:id/events`, which resolves via `findLiveSession` (orchestrator index first, then the ordinary registry where subagent children live) and cold-starts idle sessions for viewing. Two subtleties remain:

1. `globalAgentEvents.pinSession(sid)` (`lib/sse/global-agent-events.ts`) — a daemon session that is **alive but idle** (between turns, e.g. a gate-paused v3 execution session or any warm idle session) appears in NO running set, and `syncRunningIds` **disconnects** any source not in that set. A pinned sid is exempt from the sweep and stays connected while viewed (so a resumed turn's `agent_start` arrives live). `useAgentSession` pins on mount when the state response says `loopOwned` (= "live in the daemon") and unpins the previous session on switch/unmount. On a fatal SSE error a pinned session re-probes the state route before retrying (bounded retries; unpin when the daemon no longer holds it).
2. The event reducer promotes `agentPhase` to `running_tools` on a `tool_execution_update` partial even without a prior `tool_execution_start` — a viewer joining mid-subagent-run never saw the start event, and the subagent worker's streamed partials are the only proof the tool is running. Without this the phase sits on `waiting_model` (「思考中」) for the whole multi-minute run.

**Opening a subagent child by click goes through `/api/sessions/[id]/locate`, never the cached `/api/sessions` list.** `handleOpenSessionViewer` resolves the child id via locate (Loop-Host probe first — now hitting for children too — then a forced disk scan that bypasses the 30s list cache). The old list lookup silently no-op'd for a freshly spawned running child (it isn't in the cached list yet), which felt like "you must wait for the subagent to finish before you can open it". Locate also enriches a loop-hit from disk (real firstMessage/stats for the tab label, keeping the probe's authoritative path/cwd).

**Running badges come from one server-side set.** `/api/agent/running/events` pipes the daemon's `/v1/sessions/running/events`; because the daemon registry holds interactive sessions + subagent children + orchestrators alike (keyed by real session id), the sidebar/tab badges need no client-side merge anymore (the old `loopRunningSnapshot` merge existed only because the web set could never contain Loop sessions).

**The daemon's session SSE ends on destroy.** `serveSessionSse` registers `session.onDestroy(cleanup)` — when a round ends (terminal/timeout/abort) the stream closes, the browser's pinned EventSource fails fatally, `reprobePinned` sees the daemon no longer holds the session, unpins and clears the badge. Without this a destroyed round leaves the pinned runtime `agentRunning=true` forever (no `agent_end` is ever emitted after destroy), spinning the tab badge indefinitely.

**Orphan-process reaping on abort/timeout.** `session.destroy()` — used by `abortRound` and reached on the 30-min `capturePrompt` timeout — does **not** kill the bash subprocesses a round spawned via subagents: pi-coding-agent's bash tool spawns each shell `detached` (own process group) and only sweeps its tracked detached children on a **process-level** SIGHUP/SIGTERM, which a never-exiting daemon never sends. Those `bash → npm → node` trees would otherwise orphan into launchd (PID 1) still holding `node_modules` handles (which is why `rm -rf` then fails and they sit at ~100% CPU). So `PiRoundExecutionBackend` keeps a `run.id → workspacePath` map and, on abort/timeout/error, calls `reapOrphanedRoundProcesses` (`lib/loop/process-cleanup.ts`): it SIGTERM→SIGKILL every pid in the round's trees — discovered as (a) direct children of the daemon whose cwd is in the workspace, plus (b) launchd-reparented (ppid 1) build/shell processes whose cwd is in the workspace. Pure parsers (`parsePgrepChildren`/`parseLsofCwd`/`parsePsRows`/`isCwdInWorkspace`/`isBuildOrShellCommand`) are tested. Scoped by workspace cwd so concurrent rounds in other workspaces are untouched; never throws (cleanup must not break the abort flow).

### Session changed-files quick access (SessionChangedFiles)
"本会话改动 N 个文件" — a compact icon+count button at the end of the ChatInput controls row (right of the sound toggle; on mobile it lives inside the "更多控件" pill; not rendered in `embedded` view mode), opening a slide-in drawer (full-screen list on mobile). **Data source is the message stream, not git**: `deriveSessionChangedFiles` (`lib/session-changed-files.ts`, pure + tested) walks write/edit toolCalls (incl. `isEditToolName` variants) + subagent result `details.displayItems`, plus the streaming message and live `tool_execution_update` partials for **real-time** counting (partials already finalized are de-duped by `toolCallId`). Scope is the **whole session file** (not just the current branch path), deduped **most-recent-first** with a ×N badge; bash-written files (`cat >`, `git commit`) are deliberately not counted. Clicking an entry → `openFile` (existing file-tab pipeline; `/api/files` allow-list already covers session cwds). The list intentionally **survives commits** — it answers "what did this session touch", not "what is uncommitted" (that's the Explorer 改动 tab). Drawer state is not persisted; switching sessions closes it.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events` — a pure pipe onto the daemon's running-id SSE (the complete set: interactive + children + orchestrators), so running badges update without polling.
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

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — it maps each displayed message back to its `.jsonl` entry id, used for fork and `navigate_tree` calls. Subagent/loop child sessions use the same format and link back via `parentSession`; their ids are recorded in `~/.pi/agent/subagent-children.txt` so the sidebar hides them.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
