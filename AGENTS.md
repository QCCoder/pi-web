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
npm run loop   # OPTIONAL — the Loop engine, a separate process on :30142 (see Loop subsystem)
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
Tests: `npm test` (node:test over `lib/**/*.test.mjs`)

**Never run `next build` during dev** — it pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

```
Browser                Next.js Server                AgentSession (in-process)
  │                        │                                │
  │  ┌──────── Workspace layer ────────┐                    │
  │  │ manifest .pi/workspace.yaml      │                    │
  │  │ capabilities → extensions        │                    │
  │  │ repositories / work-items /      │                    │
  │  │ loops / work-items            │                    │
  │  └──────────────┬───────────────────┘                    │
  │                 │                                          │
  ├─ GET /api/sessions ──────▶ reads ~/.pi/agent/sessions/    │
  ├─ GET /api/sessions/[id] ─▶ reads .jsonl directly          │
  ├─ GET /api/agent/running/events ─▶ running-id SSE          │
  │                 │                                          │
  ├─ send message ──▶ POST /api/agent/[id]                     │
  │                   startRpcSession() ──────────────────────▶│ createAgentSession()
  │                   session.send(cmd) ──────────────────────▶│ session.prompt()
  │                 │                                          │
  ├─ SSE connect ───▶ GET /api/agent/[id]/events               │
  │                   session.onEvent() ◀──────────────────────│ session.subscribe()
  │◀── data: {...} ──│                                          │
```

- **Session browsing** (read-only): reads `.jsonl` files via SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession is created.
- **Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process. At creation it resolves the enclosing **Workspace** (if any) and attaches that workspace's extensions + skills + AGENTS.md.
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

- **Global index**: `~/.pi/workspace.yaml` (or `$PI_WORKSPACE_INDEX_FILE`) lists every known workspace
  `{ id, path, name, template_id, template_version, added_at, last_opened_at }`. `discoverWorkspaces()` reconciles it
  against disk on read and migrates legacy `workspace-*` dirs into it on first run.
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
  rules are set only when `work-items` is on). The built-in templates (`empty`, `software-development`) and custom
  template discovery (`lib/workspaces/templates.ts`, `.pi/workspace-templates/<id>/`) are **kept but `@deprecated`** —
  they exist only so `effectiveCapabilities` can fall back to a built-in template's capabilities for legacy manifests
  that have no cached `capabilities`.

### Capability system & extension mounting

`WorkspaceCapability` (`types.ts`) is the per-workspace module switch (includes `knowledge`, promoted from a mere
repository `kind` to a first-class capability — redesign decision 4, type layer). **`ALL_WORKSPACE_CAPABILITIES`** in
`lib/workspaces/service.ts` is the validation registry (the source of truth for which capabilities can be persisted):

```
sessions, explorer, work-items, repositories, knowledge, overview, workflows,
requirement-sources, loop
```

(Retired channel capabilities — `feishu-transport`, `feishu-channel`, `wecom-channel` — were removed together with their modules; `parseCapabilities` silently strips them from legacy manifests, so old workspaces keep loading and self-heal on the next save.)

- **`effectiveCapabilities(manifest)`** = `manifest.capabilities` if present, else the matching built-in template's set
  (by id **and** version), else `["sessions", "explorer"]`. Legacy manifests without a cached `capabilities` snapshot
  are derived from the template lookup.
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

### Navigation: Activity Bar (single focus)

`WorkspaceSidebar` is **no longer a stacked-group sidebar** — it is a left **Activity Bar** (`components/ActivityBar.tsx`) + a
single focused view (redesign decisions 2 & 6). Exactly one view is active at a time (`activeView`, persisted per workspace
in `localStorage` key `pi-active-view:<wsId>`, default `sessions`); switching workspace re-derives the stored view and falls
back to `sessions` if it is absent or no longer valid.

Icon order is fixed and strict (redesign §6 decision 6):
**会话(sessions) → Explorer(explorer) → 仓库(repositories) → 知识库(knowledge) → Loop(loop) → 工作项(work-items)**.
`sessions` and `explorer` are **always shown** (mandatory capabilities); the rest appear only when the workspace capability is
on. `ACTIVITY_VIEW_ORDER` + `visibleActivityViews()` in `ActivityBar.tsx` are the single source of truth for order/visibility.

Per-view content (data still comes from `loadWorkspaceData` — only the render organization changed; decision 3 splits repos by kind):
- **会话** — session list + 新建会话 (header).
- **Explorer** — Slice-3 Explorer, including the `[ 文件 | 改动(N) ]` segmented tabs (`pi-explorer-tab:<wsId>`).
- **仓库** — **only `kind === "code"`** repositories (decision 3: Repositories only holds code).
- **知识库** — **only `kind === "knowledge"`** repositories; each is an **OKF (Open Knowledge Format v0.2)** bundle
  (Markdown + YAML frontmatter) browsed via a `FileExplorer` pointed at `knowledge/<alias>` (flat layout — sibling of `repositories/`, per `workspaceRepositoryPath`). A newly
  `init`'d bundle is seeded with `index.md` (progressive-disclosure entry), `log.md`, and a `concepts/welcome.md`
  example concept (`lib/workspaces/okf.ts`, `renderOkfSeed`); a `clone`d bundle keeps the remote structure untouched.
  **L0 access is always built-in** — `read`/`ls`/`grep` need no tool. The view has an "open index.md" hint as the L0
  entry point. Ranked retrieval augmentation (`kb_search`) is **opt-in**: the tool is mounted automatically when the
  `knowledge` capability is on, and searches across all active bundles (see "kb_search" below).
- **Loop** — a "管理 Loops" entry that opens the center `LoopConfig` view (the icon also highlights when the center shows loops).
- **工作项** — the requirements/bugs groups.

Mobile: the Activity Bar becomes a **bottom tab bar** (`variant="horizontal"`); desktop is a left icon strip
(`variant="vertical"`). The header (workspace switcher / 新建 / 设置), the 归档 button and `SettingsBar` are preserved outside
the focus area. **Don't reintroduce stacked sections** — a new module gets an Activity Bar icon (register it in
`ACTIVITY_VIEW_ORDER` + `visibleActivityViews`), not a new collapsible group.

**Desktop sidebar is drag-resizable.** The width is a CSS var (`--pi-sidebar-width`, default `260px`) set inline on
`.sidebar-container` from `AppShell`'s `sidebarWidth` state; a thin `.sidebar-resize-handle` strip (sibling of the
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
- The `KEY` counter lives in `manifest.work_items.next{Requirement,Bug}Number` and is incremented under the workspace
  write lock (`reserveWorkItemKey`).
- Updates take `expectedRevision` (optimistic concurrency); appending a milestone via `recordWorkItemMilestone` does
  **not** bump the revision.
- The pi extension (`work-items/extension.ts`) registers `workspace_list_work_items`, `workspace_get_work_item`,
  `workspace_create_work_item`, `workspace_update_work_item`, `workspace_record_milestone`.
- **Archive cascade** (`lib/archive-cascade.ts`): archiving a work item tucks its conversations into the session
  archive **only if no other active work item references them**; restoring brings them back. Sessions are physically
  moved to a `.archived/` subdirectory (`lib/session-archive.ts`) so `SessionManager.listAll()` no longer sees them.

### Loop (`lib/loop/`)

The generic **maker/checker automation engine**. **It runs as a separate process** — `npm run loop` →
`bin/pi-loop.js` → `startLoopHost()` (`host.ts`), listening on `127.0.0.1:30142` (`PI_LOOP_HOST`/`PI_LOOP_PORT`). The
**web server never owns Loop timers** (`instrumentation.ts` explicitly does not start it); it is only a management
adapter + SSE proxy.

Per-loop files under `<workspace>/loops/<loopId>/`: `loop.yaml` (definition: triggers, autonomy `L1|L2|L3`),
`LOOP.md` (task contract), `STATE.md` (persistent state), `RUNS.jsonl` (**append-only** run snapshots),
`agents/*.md` (loop-scoped worker subagents), `audit/`.

Round lifecycle (`runtime.ts` + `pi-execution.ts`):
1. **trigger** (`host.ts`) — dedups by `(workspace, loop, eventId)`; cron triggers fire from `LoopHostScheduler`
   (30s tick, per-minute slot dedup).
2. **startRound** (`pi-execution.ts`) — starts an orchestrator AgentSession (rpc key `__loop_host__${run.id}`), injects
   the loop's own `agents/` dir as trusted subagent source, runs `LOOP.md` as the first prompt. The whole turn (many
   tool/LLM round-trips, incl. subagent delegation) is one `capturePrompt`, bounded by a **30-min timeout**
   (`RUN_TIMEOUT_MS`, `unref`'d) that rejects → run `failed`. Mid-turn the orchestrator emits `LOOP_GATE: <payload>`
   to pause for a human, or `LOOP_VERDICT: <conclusion>` (free text) to end.
3. **gate** — `LOOP_GATE:` → run `waiting_for_gate` (orchestrator session kept alive in-memory across the pause). A
   free-text answer (`answerGate`) resumes the same session via `resumeRound`. The session is **file-backed**: if the
   in-memory wrapper expired (rpc-manager's 10-min idle timeout) or the host restarted while paused, `resumeRound`
   **rehydrates** it from its `.jsonl` (`resolveSessionPath` + `startRpcSession`) so the gate continues transparently.
   Only an archived/missing file is unrecoverable (→ run `failed`).
4. **heartbeat** — a long round sits in `running` with no status transition for many minutes (subagent trace, slow
   model), which looks frozen in the UI. `capturePrompt` emits a throttled (60s) `onProgress` hint; the runtime turns
   each into a `progress`-field snapshot (`LoopRun.progress`, e.g. `tool: bash` / `subagent: brainstorm`) so the run
   card's `updatedAt` advances. Snapshot appends are **serialized per run** (`runtime.writeSnapshot`) so a
   fire-and-forget heartbeat cannot overtake the terminal snapshot. `progress` is cleared on terminal.
5. **reap orphaned gates** (`runtime.reapOrphanedGates`, called at host startup) — every `waiting_for_gate` run whose
   orchestrator `.jsonl` is gone from the live sessions dir (archived/removed) is marked `failed`; runs whose file is
   still live are left alone (they rehydrate on the next answer). This is the only recovery for a gate whose session
   was archived out from under it (e.g. archive-cascade on a linked work item).

The web layer: `/api/workspaces/[id]/loop/**` calls `loopHostClient` (`loop/client.ts`, `PI_LOOP_URL`) for
list/trigger/run/gate, and `lib/loop/authoring.ts` for create/update/delete (which writes `loop.yaml`/`LOOP.md`/agents
**directly in the web process**). The web server also **probes** the loop host for live orchestrator sessions
(`/v1/sessions/:id`) and **proxies their SSE** so a Loop run can be watched in the browser even though the session
lives in the loop process.

**Orchestrator session titles.** Every orchestrator session is seeded with the same generic bootstrap prompt, so
without intervention they all share an identical title. The host fixes this with an injected `sessionNamer` seam:
after a round settles, `PiRoundExecutionBackend` asks the namer for a title and renames a still-unnamed session. The
host's namer (`findWorkItemByConversation`) resolves the requirement a dev-loop run picked by scanning work items
whose `conversations` includes the orchestrator's session id (the dev-loop LOOP.md appends it on selection) and
returns `(Loop) <title>`. Runs that pick nothing (idle / park-all) keep their default title. The engine stays
domain-agnostic — it just calls the host-provided callback and never imports work-items code itself.

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
  result card). Append-only + mtime-cached because the loop host creates children in a different process.

### Git & Changes (`lib/git-changes.ts`, `lib/git-status.ts`, `lib/git-discover.ts`)

- `getGitStatus(cwd)`: walks the tree once (`git-discover.ts`) to find **every** nested repo root, queries each, and
  builds per-repo `RepoGroup[]` (the cwd-enclosing repo, scoped to cwd, first; then nested repos by relative path).
  Nested-repo boundary entries reported by a parent are deduped against the nested repo's own group. Returns groups +
  grand `additions`/`deletions` totals.
- `getGitFileDiff(cwd, filePath)`: resolves the repo from the **file's** location, builds a unified patch (synthesized
  "new file" patch for untracked; `git diff HEAD` otherwise; respects rename pairs).
- APIs: `GET /api/git/status?cwd=`, `GET /api/git/diff?cwd=&path=` — guarded by the file-access allow-list. Polled by
  `hooks/useGitStatus.ts`; rendered by `components/ChangesPanel.tsx` (flat list for one repo, collapsible per-repo
  groups when cwd spans several). In `WorkspaceSidebar` the Changes list is **no longer a standalone section** — it is
  a `[ 文件 | 改动(N) ]` tab inside the single-focus **Explorer view** (redesign decision 8), following the Explorer's current cwd
  scope; `ChangesPanel` itself is unchanged. Tab choice persists in `localStorage` key `pi-explorer-tab:<wsId>`;
  non-git directories hide the "改动" tab. `SessionSidebar` keeps its own standalone Changes section.

### Importer (`lib/importers/`)

**Inbound work-item source adapter** (design: `docs/autonomous-dev-loop.md`). The first (and currently only) adapter is **Chandao (禅道)**. This is the P0+P1 slice; the dev Loop / evolution are later cycles and **not** here.

- **Capability**: `requirement-sources` (registered in `ALL_WORKSPACE_CAPABILITIES`; toggled per-workspace, NOT in the init checklist). It gates the config UI + the cron runner. It is **not** an LLM extension (the runner is deterministic I/O, no tools).
- **Importer SPI** (`types.ts`): `listAssigned/getDetail/getAttachment` — the deep-module seam hiding REST+token+image-binary behind three methods. Swapping Chandao for Jira changes one adapter, not the runner.
- **`ChandaoImporter`** (`chandao-importer.ts`): REST+Token (`POST /api.php/v1/tokens`, **not** the web-login md5 flow). Token cached in-memory, **re-signed once on 401** via account+password. Field differences hidden (bug `steps` vs task `desc`; task list title is `name`). `fetch` is injectable for tests.
- **Credentials** (`config.ts`): `~/.pi/agent/importers/<workspaceId>.json` (mode `0600`); `toPublicConfig` never leaks password/token. Shape `{chandao:{base,account,password,token?,assignee,productId,executionId}}`.
- **Images** (`images.ts`, pure): `extractChandaoFileIds` / `rewriteChandaoImageSources` / `detectImageExt` (magic-byte sniffing). The runner downloads each `fileID` via `GET /api.php/v1/files/{id}` and rewrites README `<img src>` to a relative `attachments/<kind>-<id>.<ext>` so the work item renders offline and travels into git.
- **Runner** (`runner.ts`): `syncImporterForWorkspace(id)` is the deep-module seam hiding pull→dedup→create→localize-images→event. Per item: dedup by `external.source:sourceId`; not-exists→create (bug→`BUG-####`, task→`REQ-####`, KEY from `manifest.work_items.next{Bug,Requirement}Number`), download+persist images, append `imported` milestone; exists&open→`imported` sync heartbeat; archived→skip. Per-item errors recorded, never abort the run. **Deterministic I/O — never delegated to an LLM.**
- **Work-item `external` field**: `WorkItemExternalRef {source, sourceId, url?, lastSyncedAt}` added as an **optional** field on `WorkItemRecord`/`CreateWorkItemInput` (design §4/§5). Serialized as a snake_case `external:` block in `item.yaml`. Stamped at creation by the Importer only; the LLM work-item tools don't touch it. The dedup key.
- **Runner lives in the loop host, NOT the web server**: `ImporterScheduler` (`scheduler.ts`) is a **non-Loop system timer** (30min) in the loop host process — a sibling of `LoopHostScheduler`, independent of the Loop engine. **`instrumentation.ts` is untouched** (web server holds no timers — design §5). The host also exposes `POST /v1/workspaces/:id/importers/sync` for manual/webhook.
- **Web manual sync** (`app/api/workspaces/[id]/importers/sync/route.ts`): forwards to the host; **falls back to an in-process run if the host is down** (a one-shot sync is not a timer, so this does not violate "web owns no timers").
- **Config UI**: `components/ImporterConfig.tsx` (capability toggle + credential form + "测试连接"), mounted in `WorkspaceManager`.

### 对外通知渠道（已移除）

Feishu (`lib/feishu/` + `lib/feishu-channel/`)、企微 (`lib/wecom-channel/` + `lib/wecom/`)、多通道通知 (`lib/notify/` + `lib/exporters/`) 已全部删除（2025 清场决策：pi-web 不再有任何对外通信渠道，为 session-daemon 化准备）。三个 capability 值保留在 `RETIRED_CAPABILITIES` 里惰性剔除；磁盘上残留的凭证文件（`~/.pi/agent/feishu|notify|feishu-channel|wecom-channel/`）无代码引用，可手动清理。git 历史可找回全部实现。

### Dev Loop (`lib/loop/dev-loop/`)

**The one Loop that evolves** (design §7; P3). It is a **user of the engine**, not engine code — the generic engine (`runtime`/`pi-execution`/`store`/`scheduler`) is untouched. Its entire behavior ships as **static template files** under `lib/loop/dev-loop/template/` (`LOOP.md` + `agents/{selector,brainstorm,writing-plans,implementer,reviewer,verifier,learner}.md` + `loop.yaml`), copied verbatim into `loops/dev-loop/` by `install.ts`. **No generators, no hardcoded project facts** — the `LOOP.md` contract guides the orchestrator (a capable LLM) through a thin dispatch Round sequence named after the superpowers skills they mirror (`orient → selector → brainstorm → plan gate → writing-plans → subagent-driven development → code review → verification → finishing → learn`), delegating all judgment to seven subagents, using **only existing tools** (work-item tools, bash, edit, subagent, kb_search). No new tools are injected (decision D10).

- **Roles** (template `agents/*.md`, all subagents): **selector** (选品 + 三重判定 + **数据流快筛** → outputs `ceremony` incl. per-role model tiers; writes the thin SPEC itself for pure-display items where `trace==skip`); **brainstorm** (全链路 trace UI→SQL + 反证, strongest model, produces `SPEC.md` — the what-contract: 需求解读/范围边界/验收标准/待澄清 — consumed by the human plan gate and the code review); **writing-plans** (reads SPEC, produces `PLAN.md` — the how: 落点/dev+test 计划/接线覆盖; acceptance criteria only in SPEC, test commands only in PLAN); **implementer** (TDD maker, reads SPEC+PLAN, **bounded fix loop** — max 5 rounds, escalate model at R4-5); **reviewer** (code review, dispatched after implementer and **before** verifier — audits the feature-branch diff three ways: SPEC acceptance-criteria compliance, README 原始验收点 cross-check against spec misreads, code quality; emits `pass` or `rework` with a file:line list; rework feeds the implementer's bounded fix loop shared with verifier rejections); **verifier** (pure executor — runs PLAN's test plan as the run's single full gate, **never self-creates coverage or writes prod code**); **learner** (learn ② — receives the orchestrator's distilled lesson candidate, mechanically applies the generalizability test and writes the OKF note to KB `learnings/`; `written=none` when the test fails). The plan gate sits **between SPEC and PLAN** (design approved before planning effort is spent); the orchestrator (`LOOP.md`) only dispatches + handles gates + runs the inline `learn` step.
- **`install.ts`**: `createDevLoopDefinition`/`ensureDevLoopDefinition` `cp` the template into `loops/dev-loop/` with `errorOnExist`+`force:false` (never silently overwrites) + rollback. Idempotent ensure. No `contract.ts`/`authoring.ts` generators (removed — the template *is* the source of truth).
- **No `checkers.ts`**: checker commands live in the workspace's own AGENTS.md / knowledge standards; `tester` reads them at runtime (no hardcoded repo→command map in the engine).
- **Phase mapping** (reuses the work-item state machine verbatim, zero new enums): 待开发=`intake` → 待计划评审(gate1)=`plan_approval` → `implementation` → 待评审(gate2)=`verification` → `complete`+`done`; 受阻=status `blocked`.
- **PR = push branch** (no `gh` CLI; repos have codeup remotes): maker pushes `git push origin <branch>`, records branch on the work item, phase→`verification`; gate2 (human merge) **never skipped** (L0①).
- **API**: `POST /api/workspaces/[id]/dev-loop` creates (idempotent `ensure`); `GET` reports existence.

### Learn (audit line inline; notes via the `learner` agent)

**Qualitative knowledge transfer, not quantitative calibration.** The old §7.4 "aggregate LEARN.jsonl → STATE.md calibration table → demote confidence tiers" machinery was **removed** (it never fired — needed `MIN_SAMPLES=3` per module, never reached). Evolution works by writing **generalizable process/judgment rules into the knowledge base**, where `kb_search` surfaces them in future selector/brainstorm rounds.

- **Learn step** (terminal, two halves split by context fit): the orchestrator **inline** ① appends the thin JSON audit line to `LEARN.jsonl` (its own run's testimony — fields copied from SPEC/VERDICT) and ② distills a lesson candidate (judgment needs run memory); **only if a candidate exists** it dispatches the **`learner`** subagent (cheap model, fresh context — mechanical fidelity where the long-tail format work needs it) to run the **generalizability test** and write the OKF note. No candidate → no dispatch; round-0 idle → nothing at all.
- **`LEARN.jsonl`** (per dev-loop): a **thin append-only audit log**, one line per run: `{runId,workItemKey,module,repo,predictedConf,riskTier,outcome,tests,ts}` (no `humanDecision` — rich lessons go to the KB, not the JSONL). Machine-readable trail; nothing parses it structurally.
- **Generalizability test** (mechanical, in `agents/learner.md`): delete the specific keys/class names from the lesson — is the remaining sentence still a rule that guides a future round? ✅ "查询类需求必须 trace 完整请求路径含后端专用拦截器"; ❌ "`<ServiceImpl>` 硬编码 OR" (rots with the code). Failing lessons stay in `LEARN.jsonl` audit only; code-specific facts belong in the work item's own SPEC/PLAN/IMPLEMENTATION.md (in git).
- **No learn code**: `lib/loop/learn/` (the old `knowledge.ts` formatter + test) and the top-level `LEARN.md` spec were **deleted** — the learner agent's `agents/learner.md` is the single source of truth (path scheme `learnings/<module>-<runId>.md`, frontmatter `author: loop`/`autoManaged`/`derivedFrom: run:*`, anti-pollution "always a new file, never edit existing notes" — all specified in `agents/learner.md`). STATE.md is removed from the dev-loop (the generic loop framework still has it for non-dev loops).
- **Three artifacts, three purposes (no overlap)**: KB `learnings/*.md` = generalizable rules (loop-authored); `standards/dev-loop-modules.md` = module-specific traps/sensitive map (hand-maintained + loop append); `LEARN.jsonl` = raw outcome audit log.

### cxin reference (研发 Loop target workspace)

- **dev Loop instance**: `~/.pi/workspaces/workspace-c/loops/dev-loop/` (autonomy-free engine; manual + weekday cron triggers). Sensitive module list + module→repo map: `cargo-knowledge/standards/dev-loop-modules.md` (Phase-0 artifact, §8). Generalizable process lessons append to `cargo-knowledge/learnings/` (one back-filled note seeded from the REQ-0012 run).
- **Host wiring**: `createLoopHost()` starts **one** sibling non-Loop timer — `ImporterScheduler` — alongside `LoopHostScheduler`. (The old `LearnScheduler` and `ExporterScheduler` were removed — learn is now an inline orchestrator step, and the outbound exporters were deleted with the channel cleanup.) None runs in the web server (`instrumentation.ts` untouched).

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
  sessions/[id]/context/route.ts         GET ?leafId= — context for a specific leaf
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
  workspaces/[id]/loop/runs/[runId]/route.ts     GET a run
  workspaces/[id]/loop/runs/[runId]/gate/route.ts  POST approve/reject gate
  workspaces/[id]/importers/route.ts             GET/PUT/DELETE chandao importer credentials
  workspaces/[id]/importers/test/route.ts        POST test chandao connection (listAssigned)
  workspaces/[id]/importers/sync/route.ts        POST manual importer sync (forward to host / in-process fallback)
  workspaces/[id]/dev-loop/route.ts              GET dev-loop existence | POST create/ensure the dev-loop definition
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
  rpc-manager.ts            AgentSessionWrapper + registry + startRpcSession (extension/skill/workspace wiring)
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
    types.ts                WorkItemRecord / phases / events
    service.ts              item.yaml + README.md + events.jsonl CRUD, revision locking, key reservation; findWorkItemByConversation (loop session naming)
    extension.ts            pi extension: list/get/create/update/record-milestone tools
    web.ts                  error → HTTP mapping
  loop/
    types.ts                LoopDefinition / LoopRun / LoopRuntime / RoundExecutionBackend
    host.ts                 pi-loop HTTP host (createLoopHost/startLoopHost) — wires the Importer sibling timer; injects the orchestrator sessionNamer
    runtime.ts              DefaultLoopRuntime — lifecycle only (infer/execute/gate/fail)
    pi-execution.ts         PiRoundExecutionBackend — drives the orchestrator session + subagent delegation; abort/timeout reaps orphaned round processes; optional host sessionNamer renames the orchestrator after a round
    process-cleanup.ts      reapOrphanedRoundProcesses — SIGTERM→SIGKILL bash/npm/mvn trees a destroyed session leaves behind (scoped by workspace cwd)
    store.ts                loop.yaml / RUNS.jsonl read+append, validation
    authoring.ts            create/update/delete loop definitions (writes files in the web process)
    scheduler.ts            cron evaluation + per-minute dedup (runs in the loop host only)
    client.ts               loopHostClient — HTTP client to the loop host (PI_LOOP_URL)
    workspace-resolver.ts   PiWorkspaceResolver (lists loop-capable workspaces)
    web.ts                  error → HTTP mapping
    dev-loop/               the one evolving Loop — a USER of the engine (design §7); behavior ships as static template files
      install.ts            create/ensureDevLoopDefinition — cp template/ into loops/dev-loop/ (errorOnExist + rollback); idempotent
      template/             the source of truth: LOOP.md (thin dispatcher) + agents/{selector,brainstorm,writing-plans,implementer,reviewer,verifier,learner}.md + loop.yaml + LEARN.jsonl (no LEARN.md — learn spec lives in the learner agent; no STATE.md, no generators)
  subagent/
    extension.ts            `subagent` tool (single/parallel) + project-agent approval gate
    worker.ts               spawn real child AgentSessions; stream usage + display trail
    agents.ts               discover agents (user / project / loop dirs), built-in "general"
    registry.ts             append-only child-id registry (~/.pi/agent/subagent-children.txt)
  importers/                         requirement-sources inbound adapter (design: autonomous-dev-loop.md)
    types.ts                Importer SPI (listAssigned/getDetail/getAttachment) + config shapes
    config.ts               chandao credentials ~/.pi/agent/importers/<wsId>.json (0600)
    images.ts               PURE extractChandaoFileIds / rewriteChandaoImageSources / detectImageExt
    chandao-importer.ts     ChandaoImporter: REST+Token API (POST /tokens, 401 re-sign), injectable fetch
    mapping.ts              PURE mapSourceKindToWorkItemType + buildExternalIndex (dedup)
    runner.ts               syncImporterForWorkspace — pull->dedup->work item->images->event (deep seam)
    scheduler.ts            ImporterScheduler — NON-Loop 30min system timer in the loop host
  git-changes.ts            getGitStatus (multi-repo groups) + getGitFileDiff (patch)
  git-status.ts             porcelain-v1 parse, status classify, buildRepoGroups (pure)
  git-discover.ts           walk tree to find nested repo roots (+ scattered files for file-index)
  git-types.ts              GitFileStatus / RepoGroup / response shapes
  session-reader.ts         SessionManager wrappers + path cache + buildSessionContext adapter
  session-changed-files.ts  PURE deriveSessionChangedFiles — files written/edited in a session from the message stream (write/edit toolCalls + subagent displayItems; relative `file_path` args resolved against session cwd so openFile passes the /api/files allow-list; NOT git state; survives commits); isEditToolName consolidated here
  session-archive.ts        move .jsonl to/from .archived/ to hide/restore sessions
  archive-cascade.ts        work-item archive ↔ session archive bridge
  worktree.ts               project/worktree resolution (worktree→main repo) + git worktree ops
  file-access.ts            allowed file roots for /api/files, /api/git, worktrees
  agent-client.ts           typed fetch helper for /api/agent commands
  agent/                    agent event reducer + helpers + types
  stores/                   models-store, session-messages-cache, session-runtime-store, file-resource-cache, map-store
  sse/global-agent-events.ts  global running-session event fan-out
  types.ts, normalize.ts, tool-presets.ts, api-types.ts  shared types + toolCall normalization + presets
  model-catalog.ts, model-discovery.ts, models-cache.ts   model list/discovery/caching
  markdown.ts, ansi.ts, compaction-summary.ts, message-display.ts   rendering helpers
  file-paths.ts, file-types.ts, file-fuzzy.ts, file-index.ts, file-links.ts   file viewer/open helpers
  patch.ts, project-trust.ts, request-security.ts, path-security.ts, http-dispatcher.ts   security + routing
  npx.ts, skill-lock.ts, skill-message.ts, skills-service.ts, skill-updates.ts   skills/plugins plumbing

components/
  AppShell.tsx              top-level layout + URL state + tab management
  HomeLanding.tsx           the workspace picker / home screen
  ActivityBar.tsx           workspace Activity Bar — single-focus capability switcher (left icon strip on desktop / bottom tab bar on mobile); icon order sessions→explorer→repositories(code)→knowledge→loop→work-items
  WorkspaceSidebar.tsx      single-focus sidebar: ActivityBar (left) + one focused view (sessions / explorer / repositories(code-only) / knowledge / loop / work-items); explorer view has [ 文件 | 改动(N) ] tabs; archive + SettingsBar footer
  WorkspaceManager.tsx      workspace create/import + settings modal (capabilities, skills)
  WorkspaceOverview.tsx     workspace landing view (recent sessions, work items, repos)
  WorkspaceTabBar.tsx       workspace switcher tabs (shortest-unique labels)
  SessionSidebar.tsx        in-workspace session tree + FileExplorer + Changes section
  ChangesPanel.tsx          git changes list (flat or per-repo grouped)
  FileExplorer.tsx          file tree inside sidebar
  FileViewer.tsx            file content in a tab
  CapabilityToggle.tsx      the capability on/off switch used in settings panels
  LoopConfig.tsx            loop author/run/gate UI (+ LoopLaunchOverlay)
  ImporterConfig.tsx        requirement-sources (chandao importer) credential + test panel
  ChatWindow.tsx            chat composition + completion sound wrapper
  SessionChangedFiles.tsx   "本会话改动 N 个文件" toolbar button (right of the sound toggle in ChatInput) + slide-in drawer (desktop) / full-screen list (mobile); entries open the file via the openFile/file-tab pipeline
  ChatInput.tsx             input bar + model/thinking/tools/compact controls
  MessageView.tsx           renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx       in-session branch switcher
  ChatMinimap.tsx           scroll minimap alongside the message list
  MarkdownBody.tsx / MermaidBlock.tsx   markdown + mermaid renderers
  ModelsConfig.tsx          modal for editing models.json
  PluginsConfig.tsx         modal for installed package plugins
  SkillsConfig.tsx          modal for loaded/search/installable skills
  ArchiveModal.tsx          archived sessions/items modal
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
  useI18n.tsx / useTheme.ts / useIsMobile.ts   i18n / theme / responsive hooks
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`.
- `globalThis` survives Next.js hot-reload; a plain module-level Map does not.
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
`ALL_WORKSPACE_CAPABILITIES` (`lib/workspaces/service.ts`) is **the** validation list. `parseCapabilities()` throws on any value not in it, so a capability missing from this array — e.g. `subagent`, or historically `knowledge` before it was registered — **cannot be persisted** (a `PATCH …/capabilities` with it returns **400 "Unknown capability"**). The `WorkspaceCapability` *type* union contains `subagent` anyway because the tool is global; treat the type as a superset, not the validatable set. (`workflows` is registered but currently inert — no factory, no template.)

### `effectiveCapabilities` template fallback
`effectiveCapabilities(manifest)` reads `manifest.capabilities` first; if absent it falls back to the built-in template lookup (by id **and** version) for legacy manifests that still carry `template`; if that misses (or `template` is absent — now allowed for capability-driven workspaces) it returns `["sessions", "explorer"]`. **This template fallback path must be preserved** so existing `software-development` workspaces (which carry `template` + cached `capabilities`) keep working. New workspaces always write `capabilities` explicitly and omit `template`, so they never rely on the fallback.

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
The `subagent` tool is attached to **every** session in `rpc-manager.ts` via `createSubagentExtension`, regardless of workspace or capability. It is intentionally absent from `WORKSPACE_EXTENSION_FACTORIES` and `ALL_WORKSPACE_CAPABILITIES`. Loop worker agents are injected per-session through `StartSessionOptions.extraAgentDirs`.

### Loop runs in its own process; the web server only manages + proxies
`npm run loop` starts `pi-loop` (`lib/loop/host.ts`). The web server never starts loop timers (`instrumentation.ts`). Web routes for list/trigger/run/gate are thin proxies over `loopHostClient`; only authoring writes files directly. A loop orchestrator session physically lives in the loop process — the web server probes the loop host and proxies its SSE so it can be opened live. The host also runs **one sibling non-Loop system timer** alongside `LoopHostScheduler`: `ImporterScheduler` (inbound). (The old `LearnScheduler` was removed — dev-loop learn is now an inline orchestrator step writing to the knowledge base, not a host timer; `ExporterScheduler` was deleted with the outbound channels.) None of these touches the engine core or runs in the web server.

**Watching a Loop session live requires three cooperating pieces** (all must hold, or the chat view is static with no running indicator):

1. `GET /api/sessions/[id]/state` **probes the Loop Host** (like `GET /api/agent/[id]`) and returns `{running, state, loopOwned:true}` for host-owned sessions. This is the route ChatWindow's mount uses — without the probe it would answer `running:false` for a mid-round orchestrator, never mark `agentRunning`, and never connect the SSE proxy (the "no spinner while subagents run" bug).
2. `globalAgentEvents.pinSession(sid)` (`lib/sse/global-agent-events.ts`) — Loop sessions never appear in the web process's running-id set, and `syncRunningIds` **disconnects** any source not in that set. A pinned sid is exempt from the sweep and stays connected while viewed (including across a gate pause, so a resumed round's `agent_start` arrives live). `useAgentSession` pins on mount when the state response says `loopOwned` and unpins the previous session on switch/unmount. On a fatal SSE error a pinned session re-probes the state route before retrying (bounded retries; unpin when the host no longer owns it).
3. The event reducer promotes `agentPhase` to `running_tools` on a `tool_execution_update` partial even without a prior `tool_execution_start` — a viewer joining mid-subagent-run never saw the start event, and the subagent worker's streamed partials are the only proof the tool is running. Without this the phase sits on `waiting_model` (「思考中」) for the whole multi-minute run.

**The Loop Host serves ANY live session in its process, not just orchestrators.** `/v1/sessions/:id` (probe) and `/v1/sessions/:id/events` (SSE) resolve via `findLiveSession`: the orchestrator index first, then the ordinary rpc registry (`getRpcSession`, keyed by real session id) — which is where the **subagent children** an orchestrator spawns live (worker.ts starts them via `startRpcSession`). This is what makes a *running* subagent child of a Loop run watchable live: without it the probe 404s and Pi Web would load the child's .jsonl itself — a second writer racing the live child. (For a subagent child of a normal web session, the child lives in the web process's registry and streams natively.)

**Opening a subagent child by click goes through `/api/sessions/[id]/locate`, never the cached `/api/sessions` list.** `handleOpenSessionViewer` resolves the child id via locate (Loop-Host probe first — now hitting for children too — then a forced disk scan that bypasses the 30s list cache). The old list lookup silently no-op'd for a freshly spawned running child (it isn't in the cached list yet), which felt like "you must wait for the subagent to finish before you can open it". Locate also enriches a loop-hit from disk (real firstMessage/stats for the tab label, keeping the probe's authoritative path/cwd).

**Tab/sidebar running badges cover Loop sessions via a client-side merge.** The badge set (`/api/agent/running/events` ← web-process registry) can never contain Loop sessions. AppShell merges `globalAgentEvents.loopRunningSnapshot()` (pinned ids whose runtime `agentRunning` is true) into `effectiveRunningIds` for the sidebar/workspace-tab badges. The manager notifies on pin/unpin, on `agentRunning` flips via onMessage, and via a global `sessionRuntimeStore.subscribe` (so mount-time `patchRuntime` paths count too); the snapshot is a stable sorted-joined string so `useSyncExternalStore` bails when unchanged.

**The host's session SSE ends on destroy.** `serveSessionSse` registers `session.onDestroy(cleanup)` — when a round ends (terminal/timeout/abort) the stream closes, the browser's pinned EventSource fails fatally, `reprobePinned` sees the host no longer owns the session, unpins and clears the badge. Without this a destroyed round leaves the pinned runtime `agentRunning=true` forever (no `agent_end` is ever emitted after destroy), spinning the tab badge indefinitely.

**Orphan-process reaping on abort/timeout.** `session.destroy()` — used by `abortRound` and reached on the 30-min `capturePrompt` timeout — does **not** kill the bash subprocesses a round spawned via subagents: pi-coding-agent's bash tool spawns each shell `detached` (own process group) and only sweeps its tracked detached children on a **process-level** SIGHUP/SIGTERM, which a never-exiting loop host never sends. Those `bash → npm → node` trees would otherwise orphan into launchd (PID 1) still holding `node_modules` handles (which is why `rm -rf` then fails and they sit at ~100% CPU). So `PiRoundExecutionBackend` keeps a `run.id → workspacePath` map and, on abort/timeout/error, calls `reapOrphanedRoundProcesses` (`lib/loop/process-cleanup.ts`): it SIGTERM→SIGKILL every pid in the round's trees — discovered as (a) direct children of the host whose cwd is in the workspace, plus (b) launchd-reparented (ppid 1) build/shell processes whose cwd is in the workspace. Pure parsers (`parsePgrepChildren`/`parseLsofCwd`/`parsePsRows`/`isCwdInWorkspace`/`isBuildOrShellCommand`) are tested. Scoped by workspace cwd so concurrent rounds in other workspaces are untouched; never throws (cleanup must not break the abort flow).

### Session changed-files quick access (SessionChangedFiles)
"本会话改动 N 个文件" — a compact icon+count button at the end of the ChatInput controls row (right of the sound toggle; on mobile it lives inside the "更多控件" pill; not rendered in `embedded` view mode), opening a slide-in drawer (full-screen list on mobile). **Data source is the message stream, not git**: `deriveSessionChangedFiles` (`lib/session-changed-files.ts`, pure + tested) walks write/edit toolCalls (incl. `isEditToolName` variants) + subagent result `details.displayItems`, plus the streaming message and live `tool_execution_update` partials for **real-time** counting (partials already finalized are de-duped by `toolCallId`). Scope is the **whole session file** (not just the current branch path), deduped **most-recent-first** with a ×N badge; bash-written files (`cat >`, `git commit`) are deliberately not counted. Clicking an entry → `openFile` (existing file-tab pipeline; `/api/files` allow-list already covers session cwds). The list intentionally **survives commits** — it answers "what did this session touch", not "what is uncommitted" (that's the Explorer 改动 tab). Drawer state is not persisted; switching sessions closes it.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
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
