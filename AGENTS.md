# Pi Web - Development Notes

Pi Web is a web UI for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It runs a Next.js
server that owns **AgentSessions in-process**, plus a **Workspace** subsystem (manifest/capability/repositories,
work-items, loop, subagent, git/changes, feishu) layered on top.

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
  │  │ loops / feishu-channel           │                    │
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
- **Workspace management**: `app/api/workspaces/**` reads/writes `~/.pi/workspaces/**` and `~/.pi/workspace.yaml` (the global index). Capability edits, repository add/remove, work-item CRUD, loop authoring, and feishu config all flow through this surface.

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
template: { id: software-development, version: 1 }
skills: [grilling, domain-modeling, codebase-design, tdd]
repositories: [{ id, alias, name, kind: code|knowledge, status: active|removed, removed_at? }]
agent: { default_model?, thinking_level? }
capabilities: [sessions, explorer, work-items, repositories, overview, ...]   # cached snapshot
git: { branch_rules: { requirement, bug }, create_after: plan_approved }      # sw-dev only
work_items: { next_requirement_number, next_bug_number }
created_at / updated_at
```

- **Global index**: `~/.pi/workspace.yaml` (or `$PI_WORKSPACE_INDEX_FILE`) lists every known workspace
  `{ id, path, name, template_id, template_version, added_at, last_opened_at }`. `discoverWorkspaces()` reconciles it
  against disk on read and migrates legacy `workspace-*` dirs into it on first run.
- **WorkspaceRepository**: `{ id, alias, name, kind: "code"|"knowledge", status }`. **`code` and `knowledge` behave
  identically** — `kind` only drives the storage path (`repositories/<kind>/<alias>`), some UI labels, and that an
  `init`-ed knowledge repo gets an `index.md`. There is *no* knowledge-specific behavior. (`docs/workspace-redesign.md` §5.1)
- **Templates** (`lib/workspaces/templates.ts`): two built-ins — `empty` (sessions + explorer, nothing seeded) and
  `software-development` (sessions, work-items, repositories, explorer, overview + the dev skills + git branch rules;
  seeds `requirements/ bugs/ designs/ plans/ repositories/code/ repositories/knowledge/`, writes `AGENTS.md`,
  `.gitignore`, then `git init` + initial commit). Custom templates live under `.pi/workspace-templates/<id>/`
  (discovered from the workspaces root *and* a bundled `<cwd>/.pi/workspace-templates/`; user copies override bundled
  ones by id) and may carry a `seed/` directory copied on creation.

### Capability system & extension mounting

`WorkspaceCapability` (`types.ts`) is the per-workspace module switch. **`ALL_WORKSPACE_CAPABILITIES`** in
`lib/workspaces/service.ts` is the validation registry (the source of truth for which capabilities can be persisted):

```
sessions, explorer, work-items, repositories, overview, workflows,
feishu-transport, loop, feishu-channel
```

- **`effectiveCapabilities(manifest)`** = `manifest.capabilities` if present, else the matching built-in template's set
  (by id **and** version), else `["sessions", "explorer"]`. Legacy manifests without a cached `capabilities` snapshot
  are derived from the template lookup.
- **`parseCapabilities()`** rejects anything not in `ALL_WORKSPACE_CAPABILITIES` (`WorkspaceValidationError` → **HTTP 400**). To add a toggleable module you must (1) add the value to `ALL_WORKSPACE_CAPABILITIES` *and* the `WorkspaceCapability` type, (2) add an extension factory, (3) add a config UI panel.
- **Extension factories** (`lib/workspaces/extensions.ts`, `WORKSPACE_EXTENSION_FACTORIES`) turn a capability into an LLM-callable tool extension: `work-items` → work-item tools, `feishu-transport` → feishu send tools. **`subagent` is deliberately NOT registered here** (see Subagent below). **`feishu-channel`** is a service module, not an extension (see Feishu).
- **Attachment point**: `buildWorkspaceExtensions(manifest, path)` filters factories by effective capabilities. `lib/rpc-manager.ts` always attaches `createSubagentExtension(...)` globally, then — when the session's cwd is inside a workspace — appends `buildWorkspaceExtensions(...)` and filters skills to `manifest.skills`.

### AGENTS.md auto-management (managed segments)

Each workspace may carry an `AGENTS.md` at its root. **`renderSoftwareDevelopmentAgents(manifest)`** generates the full
file for the software-development template: a collaboration policy, a git block, a repositories block, and work-item
records.

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
2. **infer** — starts an orchestrator AgentSession (rpc key `__loop_host__${run.id}`), injects the loop's own `agents/`
   dir as trusted subagent source, asks for a JSON maker/checker plan.
3. `L1/L2` → `waiting_for_confirmation` (human approves/rejects the plan); `L3` → auto-execute.
4. **execute** — runs the plan, delegating each maker/checker step to the `subagent` tool when available (else inline,
   but producer and verifier are always separate). In-round gates pause on `LOOP_GATE: <decision>`; monitors emit
   `LOOP_VERDICT: changed|unchanged|unknown`.

The web layer: `/api/workspaces/[id]/loop/**` calls `loopHostClient` (`loop/client.ts`, `PI_LOOP_URL`) for
list/trigger/run/gate, and `lib/loop/authoring.ts` for create/update/delete (which writes `loop.yaml`/`LOOP.md`/agents
**directly in the web process**). The web server also **probes** the loop host for live orchestrator sessions
(`/v1/sessions/:id`) and **proxies their SSE** so a Loop run can be watched in the browser even though the session
lives in the loop process.

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
  groups when cwd spans several).

### Feishu (`lib/feishu/`, `lib/feishu-channel/`)

Two modules sharing **one Feishu app per workspace**. Credentials live outside the workspace dir (workspaces are often
git repos) at `~/.pi/agent/feishu/<workspaceId>.json` (mode `0600`).

- **feishu-transport** (capability + **extension**): outbound tools `feishu_send_message` / `feishu_send_card`.
  Degrades to a clear message when credentials are missing.
- **feishu-channel** (capability + **service module**, not an extension): inbound 1:1 DM bot over a Feishu WebSocket
  long-connection. 1 app ↔ 1 workspace; 1 chat ↔ 1 long-lived pi session (`/new` starts fresh). **pi-web is the single
  session owner** — the router (`feishu-channel/router.ts`) reuses `startRpcSession`, never spawns its own. Handles
  live on `globalThis.__piFeishuChannels` and are **booted at server start** by `instrumentation.ts`
  (`ensureAllFeishuChannelsStarted`) for every workspace with the capability + credentials. Chat↔session bindings are
  persisted at `~/.pi/agent/feishu-channel/<workspaceId>/bindings.json`.
- Capability toggles and credential writes both re-sync the channel (`ensureFeishuChannelStarted` / `restartFeishuChannel`).

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
      repositories/code/<alias>/         git repos (clone or init)
      repositories/knowledge/<alias>/
      loops/<loopId>/{loop.yaml, LOOP.md, STATE.md, RUNS.jsonl, agents/, audit/}
    .pi/workspace-templates/<id>/        custom templates (template.yaml + seed/)
  agent/                                 (~/.pi/agent)
    sessions/<encoded-cwd>/*.jsonl
    agents/*.md                          user subagents
    feishu/<workspaceId>.json            feishu credentials (0600)
    feishu-channel/<workspaceId>/bindings.json
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
  workspaces/[id]/feishu/route.ts                GET/PUT/DELETE feishu credentials
  workspaces/[id]/feishu-channel/route.ts        GET status | POST restart
  workspaces/[id]/feishu/test/route.ts           POST send a test message
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
    service.ts              manifest CRUD, capability validation (ALL_WORKSPACE_CAPABILITIES), repos, index, managed AGENTS.md
    templates.ts            built-in templates + renderSoftwareDevelopmentAgents + renderWorkspaceRepositories
    extensions.ts           WORKSPACE_EXTENSION_FACTORIES + buildWorkspaceExtensions (tool modules)
    id.ts                   ULID generator
  work-items/
    types.ts                WorkItemRecord / phases / events
    service.ts              item.yaml + README.md + events.jsonl CRUD, revision locking, key reservation
    extension.ts            pi extension: list/get/create/update/record-milestone tools
    web.ts                  error → HTTP mapping
  loop/
    types.ts                LoopDefinition / LoopRun / LoopRuntime / RoundExecutionBackend
    host.ts                 pi-loop HTTP host (createLoopHost/startLoopHost)
    runtime.ts              DefaultLoopRuntime — lifecycle only (infer/execute/gate/fail)
    pi-execution.ts         PiRoundExecutionBackend — drives the orchestrator session + subagent delegation
    store.ts                loop.yaml / RUNS.jsonl read+append, validation
    authoring.ts            create/update/delete loop definitions (writes files in the web process)
    scheduler.ts            cron evaluation + per-minute dedup (runs in the loop host only)
    client.ts               loopHostClient — HTTP client to the loop host (PI_LOOP_URL)
    workspace-resolver.ts   PiWorkspaceResolver (lists loop-capable workspaces)
    web.ts                  error → HTTP mapping
  subagent/
    extension.ts            `subagent` tool (single/parallel) + project-agent approval gate
    worker.ts               spawn real child AgentSessions; stream usage + display trail
    agents.ts               discover agents (user / project / loop dirs), built-in "general"
    registry.ts             append-only child-id registry (~/.pi/agent/subagent-children.txt)
  feishu/
    extension.ts            feishu_send_message / feishu_send_card tools
    client.ts               Feishu HTTP API client
    config.ts               credential read/write (under ~/.pi/agent/feishu/, 0600)
    types.ts                FeishuConfig / FeishuConfigPublic
  feishu-channel/
    manager.ts              long-connection lifecycle (globalThis.__piFeishuChannels), boot scan
    long-connection.ts      Feishu WS long-connection (callback pings, reconnect backoff)
    router.ts               inbound DM → pi session turn + reply (1 chat ↔ 1 session)
    binding-store.ts        chat↔session bindings (~/.pi/agent/feishu-channel/<id>/bindings.json)
    proto.ts / types.ts     Feishu event proto + module types
  git-changes.ts            getGitStatus (multi-repo groups) + getGitFileDiff (patch)
  git-status.ts             porcelain-v1 parse, status classify, buildRepoGroups (pure)
  git-discover.ts           walk tree to find nested repo roots (+ scattered files for file-index)
  git-types.ts              GitFileStatus / RepoGroup / response shapes
  session-reader.ts         SessionManager wrappers + path cache + buildSessionContext adapter
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
  WorkspaceSidebar.tsx      stacked-group sidebar: sessions / work-items / repositories(code|knowledge) / explorer / archive
  WorkspaceManager.tsx      workspace create/import + settings modal (capabilities, skills, feishu)
  WorkspaceOverview.tsx     workspace landing view (recent sessions, work items, repos)
  WorkspaceTabBar.tsx       workspace switcher tabs (shortest-unique labels)
  SessionSidebar.tsx        in-workspace session tree + FileExplorer + Changes section
  ChangesPanel.tsx          git changes list (flat or per-repo grouped)
  FileExplorer.tsx          file tree inside sidebar
  FileViewer.tsx            file content in a tab
  CapabilityToggle.tsx      the capability on/off switch used in settings panels
  LoopConfig.tsx            loop author/run/gate UI (+ LoopLaunchOverlay)
  FeishuConfig.tsx          feishu-transport credential + test panel
  FeishuChannelPanel.tsx    feishu-channel status + bindings panel
  ChatWindow.tsx            chat composition + completion sound wrapper
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
`ALL_WORKSPACE_CAPABILITIES` (`lib/workspaces/service.ts`) is **the** validation list. `parseCapabilities()` throws on any value not in it, so a capability missing from this array — e.g. `subagent` — **cannot be persisted** (a `PATCH …/capabilities` with it returns **400 "Unknown capability"**). The `WorkspaceCapability` *type* union contains `subagent` anyway because the tool is global; treat the type as a superset, not the validatable set. (`workflows` is registered but currently inert — no factory, no template.)

### `effectiveCapabilities` template fallback
A manifest with no cached `capabilities` is derived from the built-in template lookup (by id **and** version). If that lookup misses (e.g. a custom template id that no longer exists), it falls back to `["sessions", "explorer"]`. New built-in templates *cache* capabilities into the manifest on creation, so edits persist independently of the template definition.

### AGENTS.md managed-segment replacement is a no-op without markers
`updateManagedRepositoryInstructions()` only rewrites content **between** `<!-- workspace-managed:repositories:start/end -->`. If a user deletes the markers it will silently stop syncing — it never recreates them. The git block (`<!-- workspace-managed:git:start/end -->`) is generated once by `renderSoftwareDevelopmentAgents` and not re-managed afterwards.

### Subagent is global, not a workspace capability
The `subagent` tool is attached to **every** session in `rpc-manager.ts` via `createSubagentExtension`, regardless of workspace or capability. It is intentionally absent from `WORKSPACE_EXTENSION_FACTORIES` and `ALL_WORKSPACE_CAPABILITIES`. Loop worker agents are injected per-session through `StartSessionOptions.extraAgentDirs`.

### Loop runs in its own process; the web server only manages + proxies
`npm run loop` starts `pi-loop` (`lib/loop/host.ts`). The web server never starts loop timers (`instrumentation.ts`). Web routes for list/trigger/run/gate are thin proxies over `loopHostClient`; only authoring writes files directly. A loop orchestrator session physically lives in the loop process — the web server probes the loop host and proxies its SSE so it can be opened live.

### Feishu channel is a boot-time service, not an extension
`feishu-channel` long-connections are started by `instrumentation.ts` for every workspace with the capability + credentials, and live on `globalThis.__piFeishuChannels`. Capability toggles and credential writes re-sync the channel via `ensureFeishuChannelStarted`/`restartFeishuChannel`. It reuses `startRpcSession` (1 chat ↔ 1 long-lived session) — it never spawns its own AgentSession.

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
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

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
