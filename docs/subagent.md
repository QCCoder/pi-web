# Subagent (real isolated child agents)

A reusable workspace capability that lets the agent delegate a task to a **real,
isolated child `pi` agent** running in its own process with a fresh context
window. This is the "plugin" form of subagents; the Loop runtime (and any
workspace) consumes it — nothing here is loop-specific.

## Why subprocess

`pi`'s `ExtensionAPI` does not expose a `ModelRuntime` or a way to create a child
`AgentSession` in-process. The canonical, fully-isolated approach (used by pi's
own `examples/extensions/subagent`) is to spawn a separate `pi` process. We do
the same, resolving the bundled `dist/cli.js` from the installed package so it
works without `pi` on PATH.

Each worker runs with `--mode json -p --no-session`, so it is a genuine
independent agent: own context, own model, own tools, no persisted session.
Internal steps stay isolated; only streamed status + the final result return to
the parent conversation.

## Enable

Add the `subagent` capability to a workspace manifest. `rpc-manager` then
attaches the `pi-subagent` extension, which registers the `subagent` tool for
that workspace's sessions.

## Agent definitions

Markdown with YAML frontmatter, discovered from (project overrides user by name):

- `<workspace>/.pi/agents/*.md` (workspace-scoped)
- `~/.pi/agent/agents/*.md` (user-global)

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: glm-5.2          # optional; falls back to the runtime default
---
System prompt body...
```

If none are defined, a built-in `general` agent is provided so the tool works
out of the box.

## Tool modes

- **single**: `{ agent, task }` — one worker, streams progress, returns final text.
- **parallel**: `{ tasks: [{ agent, task, cwd? }] }` — up to 8 tasks, 4 concurrent,
  aggregate `N/M done` status, each task's result capped at 50 KB in the summary.

## Module layout

| File | Responsibility |
|------|----------------|
| `lib/subagent/cli.ts` | Resolve the `pi` invocation (bundled CLI → PATH fallback) |
| `lib/subagent/agents.ts` | Discover + parse agent definitions |
| `lib/subagent/worker.ts` | Spawn workers, capture JSON events, stream, parallel runner |
| `lib/subagent/extension.ts` | Workspace `InlineExtension` registering the `subagent` tool |
| `lib/workspaces/extensions.ts` | Registers the factory under the `subagent` capability |
