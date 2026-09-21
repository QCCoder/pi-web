# Subagents (built-in, ported from upstream v0.9.1)

Subagents are **in-process child `AgentSession`s** owned by the same daemon
registry as interactive sessions and kit rounds — live SSE, steer and abort all
flow through the existing session surface. Ported from upstream
`agegr/pi-web` v0.9.1 (commits `b77a25f` queue / `2661247` worktrees /
`a31d5c5` persistence / `bbe2f7d` profiles / `e3fbbf6` extension-tool
selectors) plus the two post-release fixes `9d282da` (provider stream errors
report as failed runs) and `20a2579` (session id in foreground completion
text). The community `@henryqw/pi-subagent` package (2026-08-30 switch, A3)
was removed in this port; its `delegate_task` result panel stays for history.

## Tools

`Agent` (delegate to a profile; `subagent_type`, `prompt`, `description`,
`run_in_background`, `resume`, `input_files`, `model`, `thinking`,
`max_turns`, `inherit_context`, `isolation: worktree`),
`get_subagent_result` (poll/wait a run), `steer_subagent` (message a running
child). Attached **globally to every session** in
`lib/daemon/rpc-manager.ts` (`createSubagentExtension`), same posture the
community package had. Children strip these tools again at creation and on
reopen (`SUBAGENT_CONTROL_TOOL_NAMES`) — no recursive orchestration.

## Profiles

Markdown + YAML frontmatter, discovery `builtin < global < workspace <
project` (same name wins upward). Builtin: `general-purpose`, `explore`,
`plan`.

- global: `~/.pi/agent/agents/*.md`
- workspace: `<cwd>/.agents/agents/*.md`
- project: `<cwd>/.pi/agents/*.md` (flat — NOT the community package's
  `.pi/agents/pi-subagent/` subdirectory)

Frontmatter keys: `description`, `display_name`, `tools` (builtin names +
`ext:<extension>[/<tool>]` selectors), `load_skills`/`skills`,
`load_extensions`/`extensions`, `model` (`provider/modelId`), `thinking`,
`max_turns`, `inherit_context`, `run_in_background`, `prompt_mode`
(`append`|`replace`), `color`, `isolation` (`worktree`|`off`),
`persist_session`, `enabled`. Unmanaged keys (e.g. another runtime's
`allowed_subagents`) round-trip untouched on save; the reader accepts the
community package's `skills:`/`extensions:` aliases, so old role files are
mostly readable (their `tools:` arrays must name builtin tools to survive
`parseTools` filtering; move them out of the `pi-subagent/` subdirectory).

Managed in the settings panel (`Agents` section, `AgentsConfig.tsx`):
enable/disable per profile, create/edit with the full field set, scope
(global/project), overridden-by-higher-scope badges
(`lib/subagent-profile-precedence.ts`).

## Settings

`~/.pi/agent/agents/settings.json` — `builtInEnabled` (fork default:
**true** unless explicitly disabled; upstream defaults off — this fork swaps
the built-ins in for the always-on community package, so continuity for
pi-loop kit rounds requires on-by-default; a damaged file fails OPEN) and
`maxConcurrent` (per-parent FIFO queue, default 10, max 32;
`lib/subagent-queue.ts` — separate parents never block each other).

## Runs, persistence, timeouts

Every run appends `pi-web:subagent` (meta + resource snapshot),
`pi-web:subagent-status`, `pi-web:subagent-result` custom entries to the
child session file — crash recovery derives `interrupted` from their absence.
Children keep the **`pi-subagent-<uuid>` id prefix** (created via
`NewSessionOptions.id`; names = the run's description), so
`lib/subagent-child.ts` prefix detection, sidebar hiding, locate/open and
completion-push suppression all work unchanged across the eras.

**Timeout philosophy: upstream semantics.** No idle kill, no hard runtime
cap — a quiet build runs to completion; limits are the opt-in `max_turns`
soft limit (steer-to-wrap-up at N, abort at N+1). The daemon heartbeat
monitor **exempts subagent children** (`rpc-manager.ts`) — killing a hidden
silent child mid-build was the community package's kill semantics this fork
rejected; recovery belongs to the parent (`steer_subagent` /
`get_subagent_result(wait)` / abort). The settled-idle 10-min teardown still
applies as ordinary registry cleanup.

Model routing: per-profile `model`/`thinking`, else inherit the parent's
model. The community package's `pi-task-models.json` routing key
(`pi-subagent/delegateTask`) is inert now — pin models per profile instead.

## Web surface

- `app/api/subagents/profiles` — profile CRUD (fs, file-access-guarded)
- `app/api/subagents/settings` — enabled / maxConcurrent
- `app/api/subagents/[id]` — run status / steer / abort (proxies daemon
  `GET|POST /v1/subagents/:id`)
- `components/AgentsConfig.tsx` — settings panel (SettingsUi kit +
  ModelSelector ported verbatim from upstream)
- `components/MessageView.tsx` — `pi-web:subagent` result details get an
  open-session button; the legacy `delegate_task` panel renders history
- `lib/session-subagents.ts` — drawer derivation understands BOTH transports

## Module layout

| File | Responsibility |
|------|----------------|
| `lib/subagents.ts` | Profiles (parse/save/delete/scope precedence), run metadata readers, extension-tool selectors |
| `lib/subagent-extension.ts` | Agent / get_subagent_result / steer_subagent tools; legacy `pi-subagents` suppression |
| `lib/subagent-runtime.ts` | Controller: start/resume/get/steer/abort/notifyParent; per-parent queue; worktrees |
| `lib/subagent-queue.ts` | FIFO per-parent concurrency queue |
| `lib/subagent-settings.ts` | settings.json (fork default ON, fail open) |
| `lib/subagent-prompt.ts`, `lib/subagent-input.ts` | Prompt plan (chatOnly/replace) and input-file loading |
| `lib/subagent-profile-precedence.ts` | Higher-scope override badges |
| `lib/daemon/rpc-manager.ts` | Global attach + `SUBAGENT_CONTROLLER` wiring onto the daemon registry; child reopen guard; heartbeat exemption |
| `lib/subagent-child.ts` | `pi-subagent-` prefix tagging (unchanged from the community era) |
| `app/api/subagents/*` | Web routes (profiles/settings direct; run control proxied) |
| `components/AgentsConfig.tsx` | Settings panel |
