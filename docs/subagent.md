# Subagent (community `@henryqw/pi-subagent`)

The `delegate_task` tool delegates a task to an **isolated pi child process** —
a real `pi` CLI invocation (`--mode json -p`) with its own context window,
model, and tool allow-list. The package is
`@henryqw/pi-subagent`, pinned locally at `../pi-subagent-upstream/henryqw-pi-subagent-7.1.0.tgz`
(a packed tarball of the A2-enhanced branch `feat/project-roles-and-child-sessions` @
b2007f4 — project-level roles + persisted child sessions; an immutable snapshot where a
`file:` directory pin would live-track the upstream tree; swap to the npm version once
the upstream PR merges). pi-web's built-in `lib/subagent/` was deleted in this
switch (A3).

## How it's attached (daemon-side)

- `lib/daemon/pi-subagent-host.ts` is the host adapter: it jiti-imports the
  package's extension entry (`extensions/subagent.ts` — not exposed via the
  package's `exports` map), presents the pi CLI process identity the package's
  ephemeral executor requires (`PI_CODING_AGENT=true`, process title
  `pi-rpc`, `argv[1]` → pi's bundled CLI), and wraps the factory with pi-web's
  timeout policy.
- `lib/rpc-manager.ts` attaches it to **every** session (global capability —
  still not in `WORKSPACE_EXTENSION_FACTORIES` or `ALL_WORKSPACE_CAPABILITIES`).
- Each delegation spawns `node <pi-cli> --mode json -p …` — the SAME pi version
  the daemon hosts, sharing `~/.pi/agent` settings and auth.

## Roles

Markdown with YAML frontmatter. Discovery (precedence: built-in < project <
user — same name wins upward):

- built-in `implementer` / `reviewer` (package-shipped)
- **project**: `<cwd>/.pi/agents/pi-subagent/*.md` — trust-gated by pi's
  project trust; `.pi/agents` is NOT a trust-requiring resource, so plain
  workspaces are trusted by default
- **user**: `~/.pi/agent/config/pi-subagent/*.md`

```markdown
---
name: scout
description: Fast codebase recon
tools: [read, grep, find, ls, bash]
extensions: []
skills: []
# isolation: worktree   # optional — run the child in a throwaway git worktree
# persist: false        # optional — opt this role out of persisted child sessions
---
System prompt body...
```

`tools` / `extensions` / `skills` are **mandatory arrays** (empty is fine);
legacy pi-web agent files without them fail to parse loudly. There is no
`model` key — per-delegation `model`/`modelClass` (fast/balanced/frontier/fav)
routes through `~/.pi/agent/config/pi-task-models.json`, which MUST exist or
delegation errors with "Run /task-models".

> Migration note: the old `<workspace>/.pi/agents/*.md` layout is NOT read.
> Workspace/loop roles move to `<workspace>/.pi/agents/pi-subagent/*.md` with
> the mandatory frontmatter arrays added.

## Tool modes & results

- **single**: `{ role, task }` — one child.
- **parallel**: `{ tasks: [{ role, task }] }` — up to 8, FIFO-capped by
  `maxSubagents` (default 5; `PI_SUBAGENT_MAX_SUBAGENTS` env or config).
- **chain**: `{ chain: [{ role, task }] }` — sequential, `{previous}` carries
  the prior output. `background: true` returns immediately.

Tool results carry `details.entries[]` with `{ role, status, summary, model,
thinkingLevel, session?: { id, cwd } }`. `MessageView`'s `delegate_task` panel
renders one row per entry; the `open →` button jumps to `session.id`.

## Child sessions & tagging

Children persist by default as `pi-subagent-<uuid>`-id sessions (named
`pi-subagent <role>`; file `<ts>_pi-subagent-<uuid>.jsonl` under the cwd's
session dir). `lib/subagent-child.ts` tags them `subagentChild: true` in
`GET /api/sessions` by that id/name prefix — the sidebar hides them, the
parent's result card still opens them (cold, from disk). The old
`~/.pi/agent/subagent-children.txt` registry is retired.

## Timeouts (philosophy difference — read this)

The package KILLS children on timeout: idle (no recognized pi events for
`idleMs`) → SIGTERM→SIGKILL; hard cap `maxMs` → SIGKILL. The deleted built-in
never aborted a quiet build (inactivity budget, heartbeat monitor owned hung
children). Mitigation (A3 criterion ③): pi-web pins **idle 30 min / max
120 min** in `pi-subagent-host.ts` — output-producing builds renew the idle
deadline (`bash_execution_update` counts as activity), so only a totally
silent build can die. Per-machine overrides:
`~/.pi/agent/config/pi-subagent/pi-subagent.json` (`timeout.idleMinutes` /
`maxMinutes`, `maxSubagents`, `childSessions: false` global opt-out).

## Module layout

| File | Responsibility |
|------|----------------|
| `lib/daemon/pi-subagent-host.ts` | Daemon host adapter: process identity, extension load, timeout policy |
| `lib/daemon/pi-subagent-roles.test.mjs` | Role discovery + precedence tests against the package's `loadRoles` |
| `lib/subagent-child.ts` | `subagentChild` tagging (id/name prefix) |
| `lib/rpc-manager.ts` | Attaches the extension to every session |
| `components/MessageView.tsx` | `delegate_task` result panel + `open →` jump (`session.id`) |
| `package.json` | `"@henryqw/pi-subagent": "file:../pi-subagent-upstream/henryqw-pi-subagent-7.1.0.tgz"` (temporary local tgz pin — immutable snapshot, swap to npm when upstream merges) |
