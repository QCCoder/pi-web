# Subagent (real, viewable child-agent sessions)

A reusable workspace capability that lets the agent delegate a task to a **real,
isolated child AgentSession** — a first-class session with its own context
window, model, and tools, linked to the parent conversation as a child. The
child's full run is **viewable**: open it from the tool result to inspect the
whole subagent conversation live. This is the "plugin" form of subagents; the
Loop runtime (and any workspace) consumes it — nothing here is loop-specific.

## Why in-process sessions (not subprocess)

pi-web already has everything to view a session: sidebar tree (with
`parentSession` child linking), session browsing, live SSE, chat tabs. So a
subagent is just **another session created via the normal path** and linked to
the parent. That makes it:

- listed in the sidebar as a child of the parent session,
- openable as a chat tab with **live streaming** (it lives in the in-process
  registry, so opening it reconnects to the running session),
- fully inspectable afterwards (persisted to its own `.jsonl`).

Internal steps are NOT copied into the parent; only streamed status + the final
result text return here. The full subagent conversation lives in its own
viewable session.

`startRpcSession` was extended (`StartSessionOptions`) to support
`parentSession` (sidebar nesting), `appendSystemPrompt` (the agent's role
prompt), and an explicit `model`.

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
model: provider/model-id     # optional, "provider/modelId" form; falls back to the parent's model
---
System prompt body...
```

If none are defined, a built-in `general` agent is provided so the tool works
out of the box.

## Tool modes

- **single**: `{ agent, task }` — one child session, streams progress, returns
  final text + `childSessionId`.
- **parallel**: `{ tasks: [{ agent, task, cwd? }] }` — up to 8 tasks, 4
  concurrent, aggregate `N/M done` status, each task a separate viewable child
  session.

The tool result `details` carries `childSessionId` (single) or
`results[].childSessionId` (parallel). `MessageView` renders an "open subagent →"
link for `subagent` tool results; clicking opens the child session tab
(`AppShell.handleOpenLoopSession`).

## Module layout

| File | Responsibility |
|------|----------------|
| `lib/subagent/agents.ts` | Discover + parse agent definitions |
| `lib/subagent/worker.ts` | Create in-process child sessions, run prompts, stream, parallel runner |
| `lib/subagent/extension.ts` | Workspace `InlineExtension` registering the `subagent` tool |
| `lib/rpc-manager.ts` | `startRpcSession` options: `parentSession`, `appendSystemPrompt`, `model` |
| `lib/workspaces/extensions.ts` | Registers the factory under the `subagent` capability |
| `components/MessageView.tsx` | "open subagent →" child-session link in tool results |
