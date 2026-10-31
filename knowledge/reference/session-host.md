# 会话宿主与会话面（session host / SSE / 索引 / 文件格式 / 服务面杂项）

> 深细节基线，2026-10 自 AGENTS.md 迁出（AGENTS.md 现为总览与用法说明，细节住此）。

> 内容与迁移时点一致；后续变更直接更新本文档。



---



## 会话浏览、发消息与管理面（Architecture 细则）

- **Session browsing** (read-only): list views are served from the **persistent session index** (`lib/session-index.ts`, mtime+size incremental over `~/.pi/agent/sessions` incl. `.archived/`, cache file `~/.pi/agent/sessions/.index.json`, rebuildable, tmp+rename atomic write, failed saves retried in background via a dirty flag; schemaVersion 2 — v1 clipped `/skill:` expansions mid-wrapper, so firstMessage is now skill-reduced BEFORE the 400-char truncation, and the bump discards the stale cache for a one-time rebuild). **The in-process memo is TTL-bound (`PI_SESSION_INDEX_MEMO_TTL_MS`, default 3s)** — once it served a forever-snapshot, session files written outside the walk (the host spawning subagent children / loop rounds — pre-M1 these came from a separate daemon process; today same-process writes are caught the same way) stayed invisible to locate/detail/list until a web restart, which resurfaced as "opening a subagent (child) does nothing / opens blank"; now every TTL expiry re-runs the cheap incremental walk (stat-heavy, not read-heavy) through the single in-flight promise. `listAllSessions()` in `lib/session-reader.ts` maps index entries to `SessionInfo` (firstMessage truncated to 160 chars for display — the raw text once inflated the payload to 1MB+); `GET /api/sessions?archived` and `listArchivedSessions()` derive from the same index; `GET /api/sessions/[id]/locate` resolves by id through `findSessionIndexEntry` (display title via the shared `firstMessageTitle`) and — on the live-registry probe hit (`facade.probeSession`) — also seeds `cacheSessionPath` from the probe's `sessionFile`, so a just-spawned child whose .jsonl isn't flushed yet still opens (detail answers the empty-but-valid placeholder, live SSE renders on top). Opening a session detail still reads the whole .jsonl via SDK `SessionManager`, but the response is a **tail window** (`?tail=100`): `buildSessionContext(..., { tailMessages })` maps only the last N entries and sets `hasEarlier`; older pages arrive via `GET /api/sessions/[id]/earlier?before=<entryId>&limit=&leafId=` (`buildEarlierContext` — needs an explicit leaf, defaults to the session's current leaf). The client (`useAgentSession.loadEarlier` + ChatWindow prepend detection) grows the window as the user scrolls up; `VISIBLE_PAGE_SIZE` render-windowing in `lib/chat-lazy-load.ts` sits on top of the loaded window — **first render is staged** (2026-09): `INITIAL_VISIBLE_COUNT = 10`, then a rAF chain in ChatWindow grows `visibleCount` by `STAGED_VISIBLE_STEP = 10` per frame up to `getStagedTargetCount`（= min(50, messages.length)；步长前保存距底距离，复用既有 restore effect 保位）。 Motivation: dev 冷 JIT 下首开大会话，消息到达与 loading=false 同 tick 批处理成一次同步挂载满窗 50 条（react-markdown 全家桶 + Prism），主线程被占满、「正在加载会话…」挂数秒（服务端/网络无率，实测亚秒）。 哨兵 observer 的滚动增长语义不变；短内容时哨兵可见直接整页跳满，天然兼容。
- **Sending a message**: the web routes call the **in-process session host facade** (`lib/session-host/facade.ts`, direct function call — no proxy, no second process), under which `startRpcSession()` in `lib/session-host/registry.ts` creates the AgentSession. At creation it resolves the enclosing **Workspace** (if any) and attaches that workspace's extensions + AGENTS.md. (Skills are not workspace-scoped since 2026-10 — global frontmatter toggle only.)
- **Workspace management**: `app/api/workspaces/**` reads/writes `~/.pi/workspaces/**` and `~/.pi/workspace.yaml` (the global index). Capability edits, repository add/remove, work-item CRUD) all flow through this surface. Kit loops are plain files under the workspace root — the loop management surface is `app/api/workspaces/[id]/loops/**` (status/pause/resume/frontmatter edit/manual round/stop/recover) + the WorkspaceOverview Loops block; heartbeats run inside the Next.js host (LoopKitSpawner, see Session Host).

---

### AgentSession lifecycle (`lib/session-host/registry.ts` — Next.js host process)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`.
- **Session CREATION is abortable + bounded** (`StartSessionOptions.signal`): `startRpcSession` races creation against the signal (`raceAbort`, `lib/abort-race.ts`) — an already-aborted signal throws immediately, a hung creation (e.g. stuck network call in model resolution) rejects on abort/timeout, and a session that materializes late (after the caller gave up) is destroyed on arrival so no live zombie wrapper stays in the registry. Callers bound it: subagent `runWorker` (parent tool signal + 5-min timeout; failure degrades to a failed WorkerResult, not a throw), kit rounds (`lib/session-host/loop-spawner.ts`, `creationTimeoutSignal` 5-min). Without this, a creation hang pinned the parent's turn, the host's `abort` path (which awaits idle), and the running set forever. The start-lock key for NEW sessions is a one-time `__new__<uuid>` — never `""`, which made concurrent creations (parallel subagents) coalesce onto the first session.
- **Heartbeat monitor — the zombie safety net** (`lib/session-host/heartbeat.ts` pure logic + `startSessionHeartbeatMonitor` in registry.ts, started from `getRegistry()` init): every 60s (unref'd) each RUNNING wrapper is checked for time-since-last-activity (any agent event — streaming deltas, tool partials — or inbound command, tracked in `lastActivityAt`). Silent past `STALL_WARN_MS` (5min) → listed in `facade.runningStatus()`'s additive `stalled` snapshot and `get_state`'s `stalledMs`; silent past `STALL_KILL_MS` (20min, env `PI_SESSION_STALL_*_MS`) → synthetic `prompt_error` (visible as a chat notice, NOT persisted) then `destroy()` (aborts in-flight prompt, drops registry, closes SSE → badges clear; human resends to resume). Rationale: a false kill costs one resend, a zombie costs a host restart (REQ-0026: 4 silent hours). NOT covered: creation-phase hangs (bounded by `StartSessionOptions.signal`/raceAbort above), gate-paused sessions (not `running`, never monitored — human waits can be arbitrarily long), and sessions with a **pending extension UI request** (`hasPendingUiRequests()` — running but human-paused on a confirm/select dialog; exempt like gate-paused, since the dialog is replayed to any reconnecting viewer and stays answerable). The KILL margin exists for QUIET BUILDS: pi's bash tool only emits partials when there IS output, so a legit `npm install`/`mvn` (and a subagent parent waiting on such a child) is genuinely eventless — kill must outlive the longest normal build.
- The registry lives in the **Next.js Node.js server process**. The `globalThis` guard means Next.js route cold-loading and dev hot reload (HMR) can never create a second owner — a reloaded module graph re-attaches to the same `__piSessions` Map, wrappers survive, only code is swapped; a server restart cold-starts sessions from their .jsonl on demand (same revive semantics as commands).
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`).
- **`destroy()` aborts an in-flight prompt** (`promptRunning || isStreaming → inner.abort()`). Without this, destroying a wrapper mid-run (Loop round timeout/abort) only unsubscribes events and drops the registry entry — the inner prompt keeps executing as an invisible zombie: still writing the .jsonl and spawning subagents for many minutes after every surface (run status, running badge, host probe) says it is gone. The idle-timer path is unaffected (it guards on `isRunning()` and never destroys a busy session), and fork is idle-only, so the abort branch fires only where a kill is intended.
- Session creation resolves the enclosing **Workspace** (`findWorkspaceForPath`) and attaches its extensions. If none, only the global `subagent` extension is attached. (Skills are not workspace-filtered since 2026-10 — the per-workspace `skillsOverride` whitelist was removed; skill availability is global, controlled only by the `disable-model-invocation` frontmatter toggle and install location.)

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
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `lib/session-host/registry.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

---

### Session Host (`lib/session-host/`): the Next.js process owns every AgentSession（2026-10 M1 单进程）

The pi-daemon process is **GONE** — every session, subagent child and kit loop round runs inside the Next.js Node.js
server. `instrumentation.ts` boots the host fire-and-forget (`ensureHostBooted()`, `lib/session-host/background.ts`);
`lib/daemon/`、`lib/session-daemon/`、`lib/agent-proxy.ts`、`bin/pi-daemon.js`、`bin/load-env-local.js` 与 `npm run
daemon` 已删除；原 daemon HTTP 面的所有调用方（/api/agent/** + SSE、/api/subagents/[id]、会话生命周期路由、
project-trust、session-archive、session-payload + SSR 预取、loop run/stop）如今全部直连进程内 facade。历史：该
单进程形态是 C2「daemon 单一会话宿主」strangler 的终态——两进程时代为「谁是会话 X 的 owner」在六处打的补丁簇
（state probe / pin-reprobe / badge merge / host probe / locate bypass / reducer promotion）随 proxy 层一起消失。

- **`registry.ts`** — 单一会话宿主：`AgentSessionWrapper` + `startRpcSession` + subagent controller 单例
  （`globalThis.__piSubagentController`）。**globalThis 单例**：registry/start-locks/running-listeners 全挂
  `globalThis`，Next.js 路由冷加载与 dev HMR 重载模块图后重新附着同一个 Map——**热重载永不出第二个 owner**（HMR
  语义：wrapper 存活，只换代码）；服务器重启后按 .jsonl 冷启动 revive（与命令路径同一语义）。routes 不直接 import
  本模块——一律经 facade（错误→状态映射与冷 revive 语义归 facade 所有）。
- **`facade.ts`** — 类型化进程内 facade：`createSession/sendCommand/probeSession/destroySession/
  autoNameSession/busyForCwd/reloadCwdSessions/liveSessions/runningStatus/getSubagentRunStatus/controlSubagent`；
  `SessionHostError(.status)` 负责错误→HTTP 映射。live-first + cold-start-from-.jsonl revive（旧 daemon
  `/v1/sessions` 面的进程内移植；wire 字段名 `liveInDaemon` 为客户端兼容保留，语义 = 「宿主注册表里有它」）。
- **`sse.ts`** — 进程内 Web-stream SSE（`serveSessionEventStream`/`serveRunningEventStream`，外接入
  `openSessionEventStream`）：connected 帧先行、30s 心跳注释、wrapper destroy 即断流（`onDestroy(cleanup)`）、
  `req.signal` 只取消订阅不碰会话。慢客户端 stall 上限是 **drain-aware** 的：`ByteLengthQueuingStrategy({
  highWaterMark: SSE_STALL_BYTES_DEFAULT /* 1MB 常量 */ })` + `desiredSize <= 0` —— 只按**未排水字节**判死，健康
  观看者无论累计流过多少数据都不会被误切。
- **`heartbeat.ts`** — stall classify/warn/kill 纯逻辑（warn 5min / kill 20min，env `PI_SESSION_STALL_*_MS`；
  语义见上面 AgentSession lifecycle 节）。
- **`jobs.ts`** — `HostJob {id,start,stop}` + `HostJobRegistry`，静态装配、无运行时发现。
- **`loop-spawner.ts`** — `LoopKitSpawner`（HostJob `loop-kit-heartbeats`，30s tick，无条件注册，deps 可注入）。
  **恢复门禁**：起轮前查 `listPendingExecutionRecords` —— 未确认中断记录在场则该 loop 不起新轮。**轮登记**：
  `markActive/clearActive` 写入 background 的 active-round 表，关停据此决定给哪些轮写中断记录。reaper 依赖默认
  **NO-OP**——共享宿主禁止按 cwd 收割（见下条 reaping 口径）；beat CLI 自带收割不受影响。
- **`background.ts`** — `ensureHostBooted`（globalThis 单次装配：**老 daemon 迁移守卫** → LoopKitSpawner +
  DeliveryDispatcher（Phase-2 T7 交付自动化心跳——并行懒加载链，各自 catch；见
  `lib/work-items/delivery-runner/dispatcher.ts`）→
  shutdown handlers；`PI_TEST_NO_BACKGROUND=1` 测试缝同时跳过守卫、默认 spawner 与 delivery dispatcher）+ 轮登记原语
  （`markRoundActive/clearRoundMark/listActiveRounds`）+ `registerShutdownHandlers`/`buildShutdownPlan`。
  **关停序列**（SIGINT/SIGTERM）：停后台 job（stopBackgroundSafely——loop spawner 与 delivery dispatcher 双覆盖，任一未启动 no-op、抛错不挡另一个）→ 快照 running（必须在 destroy 前取——destroy 后
  isRunning 恒 false）→ destroy **全部** wrapper → 为仍在跑的轮写中断记录（写失败不吞销毁流程，单条只记日志）→
  exit 0。不承诺恢复内存中的模型调用现场，重启后按文件记录接续。**迁移守卫**：boot 时探测 `PI_DAEMON_URL`
  （默认 `127.0.0.1:30142`，该 env 仅此一处幸存）的 `/health`——健康且 `service === "pi-daemon"` 说明旧 daemon
  仍持有会话，拒绝启动（console error + `exit(1)`），杜绝双写会话文件；spawner 必须在守卫放行后才启动（注定
  夭折的 boot 不许真起轮）。

**执行中断记录与恢复门禁（`lib/loops/executions.ts`）**：关停为每个在跑轮写 `ExecutionRecord`（kind
`loop-round`，runId/loopName/sessionId/workspacePath/host{pid,hostname}/startedAt/stoppedAt，`stopResult:
interrupted-on-shutdown | recovered-auto | recovered-manual | confirmed-dead`，needsAttention，diagnostic）——
tmp+rename 原子写。`listPendingExecutionRecords` 是 fire 门禁的数据源；管理面 `GET …/loops` 附带 `interruptions`
字段呈现，`POST …/loops/[name]/recover` = `detectSurvivingRoundProcesses` **只读探测**（ppid=1 + build/shell 命令
+ cwd ∈ workspace）——残留进程在场 → 409（带 pid，manual 也不放行）；干净 → `resolveExecutionRecords`
（manual=true 记 recovered-manual/actor=user，否则 recovered-auto）解除门禁。

---

**Watching a live session (any session — interactive, subagent child or kit loop round) is one mechanism.** The host owns every session; `/api/agent/[id]/events` = `openSessionEventStream`（`lib/session-host/sse.ts`）— live-first（`getRpcSession` 命中即流式接上），miss 则按 .jsonl 冷启动一个 wrapper 供观看（idle timer 稍后回收）；kit 轮与交互会话同注册表，同一解析路径。(已删除的 community 包子会话曾是独立 OS 进程、只能冷看盘上 `.jsonl`；builtin 子会话是注册表会话，可 live 观看。) Two subtleties remain:

1. `globalAgentEvents.pinSession(sid)` (`lib/sse/global-agent-events.ts`) — a host session that is **alive but idle** (between turns, e.g. a gate-paused kit round session or any warm idle session) appears in NO running set, and `syncRunningIds` **disconnects** any source not in that set. A pinned sid is exempt from the sweep and stays connected while viewed (so a resumed turn's `agent_start` arrives live). `useAgentSession` pins on mount when the state response says `liveInDaemon` (wire field name kept for client compat — it now means "in the host registry") and unpins the previous session on switch/unmount. On a fatal SSE error a pinned session re-probes the state route before retrying (bounded retries; unpin when the host no longer holds it).
2. The event reducer promotes `agentPhase` to `running_tools` on a `tool_execution_update` partial even without a prior `tool_execution_start` — a viewer joining mid-tool-run never saw the start event, and the streamed partials are the only proof the tool is running. Without this the phase sits on `waiting_model` (「思考中」) for the whole multi-minute run.

**Opening a subagent child by click goes through `/api/sessions/[id]/locate`, never the cached `/api/sessions` list.** `handleOpenSessionViewer` resolves the child id via locate (registry probe via `facade.probeSession` first — then a forced disk scan that bypasses the list cache). The old list lookup silently no-op'd for a freshly spawned running child (it isn't in the cached list yet), which felt like "you must wait for the subagent to finish before you can open it". Locate also enriches a probe-hit from disk (real firstMessage/stats for the tab label, keeping the probe's authoritative path/cwd).

**Running badges come from one server-side set.** `/api/agent/running/events` = `serveRunningEventStream`（进程内 `subscribeRunningSessions`，快照先行）; because the host registry holds interactive sessions + subagent children + kit loop rounds alike (keyed by real session id), the sidebar/tab badges need no client-side merge anymore (the old `loopRunningSnapshot` merge existed only because the web set could never contain Loop sessions). Subagent children never show a running badge — the sidebar/tab strip hide them by prefix (`lib/subagent-child.ts`), so no row renders one even though their id may be in the set.
**The host's session SSE ends on destroy.** `serveSessionEventStream` registers `session.onDestroy(cleanup)` — when a wrapper is destroyed (kit round `max_minutes` timeout, session delete/teardown) the stream closes, the browser's pinned EventSource fails fatally, `reprobePinned` sees the host no longer holds the session, unpins and clears the badge. Without this a destroyed round leaves the pinned runtime `agentRunning=true` forever (no `agent_end` is ever emitted after destroy), spinning the tab badge indefinitely.

---

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
pi emits `compaction_start` / `compaction_end`; `handleAgentEvent` handles exactly these (the old `auto_compaction_*` spellings are gone — pi's version is pinned by this repo). Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events` — the in-process running-id SSE (`lib/session-host/sse.ts`, the complete set: interactive + children + kit rounds), so running badges update without polling.
- `useAgentSession` treats per-session SSE as primary, but while a run is active it periodically calls `GET /api/agent/[id]` and reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo group together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

---

### File access allow-list
- `/api/files` and `/api/git/*` are intentionally not general filesystem browsers. Allowed roots come from session cwds, their resolved project roots, workspace paths, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, `/api/worktrees`, and `/api/workspaces` (GET/POST) call `allowFileRoot()` when they make a new location browsable.

### Local pi data home (`.env.local`)
The pi data home is env-driven everywhere: `PI_CODING_AGENT_DIR` (SDK `getAgentDir()` — sessions, settings, models,
skills, agents, auth, importer credentials, subagent registry), `PI_WORKSPACES_DIR` (`workspacesRoot()`),
`PI_WORKSPACE_INDEX_FILE`. Docker deployments already set these (docker-compose.yml); `scripts/adopt-pi-home.mjs`
pointed them at `<repo>/.pi/` for local dev. Wiring rules that must NOT regress:
- **`.env.local` is loaded by Next.js itself** — single process (2026-10 M1): every env consumer (session host,
  spawner, workspaces) lives in the one server process, so there is no second boot path that could miss it (the old
  `bin/load-env-local.js` self-loader died with `bin/pi-daemon.js`). Next.js NEVER overrides values already in
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
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them. Skills are NOT workspace-scoped (2026-10 removed the per-workspace `manifest.skills` whitelist and `skillsOverride` session filter); the toggle below is the only availability control.
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

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — it maps each displayed message back to its `.jsonl` entry id, used for fork and `navigate_tree` calls. Subagent children (`pi-subagent-<uuid>` ids — builtin children are created with this prefix; the legacy community-package children used it too) use the same format; the sidebar hides them via the id/name prefix check in `lib/subagent-child.ts`. Builtin children additionally carry a `parentSession` link + `pi-web:subagent` meta entries (crash recovery + resume read them).

---

## Subagent 全量细节（自原 AGENTS.md Subagent 节迁入）

### Subagent (built-in, upstream v0.9.1 port)

**In-process child AgentSessions** owned by the same in-process host registry as
interactive sessions and kit rounds (live SSE / steer / abort through the
existing session surface). Ported from upstream v0.9.1 + fixes `9d282da`/`20a2579`;
the community `@henryqw/pi-subagent` package was removed (its `delegate_task`
result panel remains for history rendering). Canonical doc: `knowledge/designs/subagent.md`.

- **Tools**: `Agent` (profile, prompt, run_in_background, resume, input_files,
  model/thinking/max_turns/inherit_context/isolation overrides),
  `get_subagent_result`, `steer_subagent`. Children strip them again
  (`SUBAGENT_CONTROL_TOOL_NAMES`) — no recursive orchestration.
- **Always global**: `lib/session-host/registry.ts` attaches
  `createSubagentExtension` to **every** session (same posture the community
  package had); still NOT in `WORKSPACE_EXTENSION_FACTORIES` /
  `ALL_WORKSPACE_CAPABILITIES`.
- **Profiles** (builtin `general-purpose`/`explore`/`plan` < global
  `~/.pi/agent/agents/*.md` < workspace `<cwd>/.agents/agents/*.md` < project
  `<cwd>/.pi/agents/*.md` — FLAT, not the community package's `pi-subagent/`
  subdir; same name wins upward). Frontmatter: `display_name`/`description`/
  `tools`(+`ext:` selectors)/`skills|load_skills`/`extensions|load_extensions`/
  `model`/`thinking`/`max_turns`/`inherit_context`/`run_in_background`/
  `prompt_mode`/`isolation`/`persist_session`/`enabled`; unmanaged keys
  round-trip on save. CRUD in the settings panel `Agents` section
  (`AgentsConfig.tsx`).
- **Settings**: `~/.pi/agent/agents/settings.json` — `builtInEnabled`
  (fork default ON — replaces the always-on community package; damaged file
  fails OPEN) + `maxConcurrent` (per-parent FIFO, default 10, max 32).
- **Timeouts — upstream semantics**: NO idle kill, NO runtime cap; opt-in
  `max_turns` soft limit only. The heartbeat monitor EXEMPTS subagent children
  (killing a hidden silent child was the community kill policy this fork
  rejected); the settled-idle 10-min teardown is ordinary registry cleanup.
- **Child sessions**: in-process, persisted by default, keep the
  `pi-subagent-<uuid>` id prefix (via `NewSessionOptions.id`) so
  `lib/subagent-child.ts` tagging, sidebar hiding and locate/open work
  unchanged across eras. Run status/status transitions are custom entries in
  the child file (`pi-web:subagent[-status|-result]`) — crash recovery derives
  `interrupted`.
- **Result shape** (MessageView): `details = {kind: "pi-web-subagent",
  sessionId, profile, status, error?, worktreePath?}` with an open-session
  button; `lib/session-subagents.ts` derives the drawer from BOTH transports.
- **Model routing**: per-profile `model`, else inherit the parent's. The old
  `pi-task-models.json` `pi-subagent/delegateTask` key is inert.


---

## Git & Changes 全量细节（自原 AGENTS.md Git & Changes 节迁入）

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
  `[ 文件 | 改动(N) ]` segmented switch in `FilesExplorerPanel` — ONE component, two hosts (desktop right panel's pinned「文件」tab /
  mobile「文件」tab; both persist the choice in `localStorage` key `pi-explorer-tab:<wsId>` so the surfaces agree) — both
  follow the Explorer's current cwd scope; `ChangesPanel` itself is unchanged.
  Non-git directories hide the "改动" segment. `SessionSidebar` keeps its own standalone Changes section.

