# Pi Workspace MVP Product Design

## Summary

Pi Workspace evolves Pi Web from a browser for working-directory-based Pi sessions into a local-first workspace for agent-driven software development. A Workspace contains collaboration rules, portable Work Items, one or more Git repositories, a Workspace Explorer, and Pi Conversations. The Web layer remains deliberately thin: it organizes work and records milestones while Pi Agent, Pi skills, and Pi extensions perform the actual analysis and development.

The MVP is single-user, runs on a private Linux server, and is usable from both desktop and mobile browsers. It does not create native clients or expose a high-privilege agent directly to the public internet.

## Implemented MVP snapshot

The `feature/2026-07-29/workspace-mvp` implementation includes:

- file-discovered Empty and Software Development Workspaces;
- file-backed Requirements and Bugs with revision-safe metadata and append-only events;
- Workspace, repository, Work Item, content, and milestone APIs;
- repository clone, registration, status, unregistration, and recoverable trash;
- a first-party Pi extension for Work Item tools;
- Pi-native skill discovery with per-Workspace selection applied by `ResourceLoader`;
- Work Item-to-Conversation start/continue links;
- safe Explorer text editing with protected Workspace and Work Item metadata;
- responsive desktop and mobile views with mobile Work Items, Conversations, Explorer, and More navigation;
- private-network Docker Compose deployment.

The current MVP deliberately does not implement user-authored Workspace templates, automatic repository detection, Workspace export/import, a permanent-delete UI, SQLite search projections, or native clients. These remain future work and are not required for the first deployment.

## Product goals

1. Let one Pi Web instance manage multiple isolated Workspaces.
2. Let each Workspace contain multiple Git repositories and multiple Conversations.
3. Provide lightweight Requirement and Bug management backed by ordinary files.
4. Create Workspaces from reusable templates with default collaboration rules and Pi skill selections.
5. Preserve Pi Agent as the execution engine instead of rebuilding its lifecycle and workflow behavior.
6. Make the complete agent-driven workflow usable from a phone without attempting to build a browser IDE.
7. Keep authoritative user data portable, Git-friendly, and recoverable without the application database.

## Non-goals

The MVP does not include:

- multi-user tenancy or a public account system;
- native iOS, Android, Windows, or macOS clients;
- a complete offline mode;
- push, email, or third-party completion notifications;
- a full source-code IDE or interactive terminal;
- a draggable project-management board;
- a custom skill marketplace or skill package manager;
- a hard-coded workflow state machine;
- an execution-budget system layered over Pi Agent;
- per-Conversation operating-system containers;
- automatic deletion of remote Git repositories.

## Guiding principles

### Workspace is the boundary

A Conversation belongs to exactly one Workspace. Repositories, Work Items, collaboration rules, and the Workspace Explorer are interpreted within that boundary. A Conversation cannot be rebound to another Workspace; transferring context creates a new Conversation with a recorded source relationship.

### Files are authoritative

Workspace configuration and Work Items are stored in files. SQLite is limited to rebuildable search projections, recency, and UI state. Deleting the cache must not lose Workspace data.

### Pi remains the agent runtime

Pi Agent owns model execution, tools, sessions, retries, compaction, token and cost statistics, abort behavior, and skill execution. Pi Workspace selects resources for a Conversation and exposes Work Item commands through a first-party Pi extension.

### Policies have two representations

`.pi/workspace.yaml` stores settings the application must execute deterministically. `AGENTS.md` contains the human-readable collaboration policy for Pi Agent and users. Settings owned by the UI are mirrored into a marked, managed section of `AGENTS.md`; user-authored content outside managed sections is preserved.

### Destructive actions are recoverable

Disabling a repository does not move or delete its files, and it can be restored from the Workspace UI. Deleting a Workspace moves it to a server-side trash area.

## Workspace storage

The default local layout is configurable through an environment variable and resolves to `~/pi-workspaces` outside containers.

```text
~/pi-workspaces/
├── .pi/
│   ├── workspace-templates/
│   ├── trash/
│   └── state.sqlite
├── workspace-ecommerce/
│   ├── AGENTS.md
│   ├── .pi/
│   │   └── workspace.yaml
│   ├── requirements/
│   ├── bugs/
│   ├── designs/
│   ├── plans/
│   └── repositories/
│       ├── code/
│       └── knowledge/
└── workspace-crm/
    └── .pi/workspace.yaml
```

There is no authoritative central Workspace registry. Discovery scans `workspace-*` directories for a valid `.pi/workspace.yaml`. `state.sqlite` can be rebuilt from those manifests and Work Item files.

### Workspace identity and naming

- Directory names use `workspace-<slug>`.
- A Workspace manifest contains an immutable internal identifier and a user-editable display name.
- A Workspace directory is the root and safety boundary for its Explorer.
- A repository working copy belongs to one Workspace. Reuse in another Workspace requires a separate clone or Git worktree.

### Workspace configuration

An illustrative manifest:

```yaml
schema_version: 1
id: 01K1W4WZQ2T7NQ8J8X8SE8X4B1
slug: ecommerce
name: Ecommerce
template:
  id: software-development
  version: 1
skills:
  - grilling
  - domain-modeling
  - codebase-design
  - tdd
agent:
  default_model: openai/gpt-5
  thinking_level: high
repositories:
  - id: 01K1W5C3S8R9AF7Y24JQK21P0X
    alias: web
    name: Web
    kind: code
    status: active
git:
  branch_rules:
    requirement: feature/{date}/{slug}
    bug: hotfix/{date}/{slug}
  create_after: plan_approved
work_items:
  next_requirement_number: 9
  next_bug_number: 13
```

Provider credentials and API keys are never written to this file. They stay in Pi's instance-level authentication storage. A Workspace may select an allowed/default model without owning credentials.

## Workspace Templates

### Empty

The `empty` template creates only:

```text
workspace-<slug>/
└── .pi/
    └── workspace.yaml
```

It does not create `AGENTS.md`, a Git repository, a workflow, or default skills.

### Software development

The `software-development` template creates:

```text
workspace-<slug>/
├── AGENTS.md
├── .pi/
│   └── workspace.yaml
├── requirements/
├── bugs/
├── designs/
├── plans/
└── repositories/
    ├── code/
    └── knowledge/
```

It initializes a local management Git repository at the Workspace root and automatically commits Workspace-managed changes. The nested repositories under `repositories/` are excluded from that management repository.

Its default collaboration policy has two human approval points:

```text
analysis → Requirement/Bug approval → design and plan → plan approval
→ implementation → verification → completion
```

The policy guides Pi through `AGENTS.md` and selected skills. The Web backend does not implement a mandatory state machine.

### Template ownership

The two built-in templates ship with the application source. User-created templates live in the global Workspace data directory. Creating a Workspace applies a snapshot; template changes never overwrite an existing Workspace automatically.

## Pi skill selection

Pi Workspace does not introduce a skill catalog. It reuses Pi's native global, project, settings, npm, and Git skill/package mechanisms. A Workspace manifest stores only the skill selection for new Conversations.

The Workspace settings view presents skills exactly as Pi's ResourceLoader sees them and lets the user choose which ones apply to new Workspace Conversations. An empty selection means "follow Pi defaults." Pi still installs, updates, removes, discovers, loads, and executes the skills; Pi Workspace stores only their names and applies a ResourceLoader filter.

## Repository management

A Workspace may manage several typed repositories. The MVP supports:

- cloning a Git URL as a `code` or `knowledge` repository;
- initializing a new `code` or `knowledge` repository;
- disabling and restoring a repository without moving or deleting its files;
- viewing branch and dirty-state information;
- recording repository, branch, and commit links on Work Items.

All repositories are managed inside the Workspace at `repositories/<kind>/<alias>`. External repository paths are not registered.

When a Work Item reaches implementation after plan approval, the default collaboration policy creates a branch in each selected repository. Branch naming is configured in `workspace.yaml` and mirrored into the managed Git section of `AGENTS.md`.

## Work Items

### Types

The MVP has two Work Item types:

- Requirement — desired capability or behavior;
- Bug — observed behavior that differs from the expected behavior.

Both appear in a unified Work Items area with Requirement, Bug, and All views.

### Identity

Each Work Item has:

- an immutable internal ULID;
- a human key allocated within the Workspace, such as `REQ-0001` or `BUG-0001`.

Sequence allocation is atomic. The human key is used in the UI, Conversations, branches, and cross-links.

### File bundle

Each Work Item is a directory:

```text
bugs/BUG-0001/
├── item.yaml
├── README.md
├── events.jsonl
└── attachments/
```

Requirements use the equivalent path under `requirements/`.

`item.yaml` contains validated, structured metadata:

```yaml
schema_version: 1
id: 01K1W5KEDFS8HH8X5M8ZJBJY9R
key: BUG-0001
revision: 4
type: bug
title: Login succeeds but the page is blank
status: in_progress
phase: implementation
priority: P1
repositories: [01K1W5C3S8R9AF7Y24JQK21P0X]
tags: [login, regression]
conversations: [conversation-id]
related_items: [REQ-0003]
designs: [DES-0001]
plans: [PLAN-0001]
created_at: 2026-07-29T10:20:00+08:00
updated_at: 2026-07-29T14:20:00+08:00
```

`README.md` contains user- and agent-readable narrative:

```markdown
# Login succeeds but the page is blank

## Original Description

The exact description supplied at creation.

## Reproduction

## Expected Behavior

## Actual Behavior

## Agent Analysis

## Acceptance Criteria
```

The Original Description is preserved. Later clarification updates other sections rather than rewriting the original account.

`events.jsonl` is append-only and contains milestone events:

```json
{"id":"event-ulid","at":"2026-07-29T10:20:00+08:00","type":"work_item.created","actor":"user"}
{"id":"event-ulid","at":"2026-07-29T10:31:00+08:00","type":"approval.recorded","actor":"user","conversation_id":"..."}
{"id":"event-ulid","at":"2026-07-29T12:26:00+08:00","type":"tests.passed","actor":"agent","conversation_id":"...","data":{"repository":"web"}}
```

The event log records meaningful milestones, not every model message, file read, command, or tool call. Full execution details remain in the linked Conversation.

### Status and Phase

Status is deliberately small:

```text
open | in_progress | blocked | done | cancelled
```

Phase expresses the current workflow step and is template-configurable. The software-development defaults are:

```text
intake
analysis
requirement_approval
design
plan_approval
implementation
verification
complete
```

Requirement and Bug may use different labels while sharing the status model.

### Updates and concurrency

All structured updates go through the Work Item domain service:

1. compare the caller's expected revision;
2. validate the requested transition and references;
3. atomically replace `item.yaml`;
4. append a milestone to `events.jsonl`;
5. refresh the derived projection.

A stale revision returns a conflict instead of overwriting another client or Agent. Milestone history is corrected by appending a correction event, never by rewriting old lines.

Explorer permissions are:

- `README.md`: editable, with content-change milestones;
- `attachments/`: upload and management allowed;
- `item.yaml`: read-only in the generic editor and editable through Work Item forms;
- `events.jsonl`: read-only and append-only through the domain service;
- `.pi/workspace.yaml`: normally changed through Workspace settings, with a validated advanced editor.

External Git, SSH, or filesystem edits are supported. A watcher and startup scanner validate changed files and rebuild projections. Invalid Work Items remain visible with actionable validation errors; the application does not overwrite them.

### Attachments

Images and text attachments up to 10 MB are committed with the management repository by default. Larger or potentially sensitive attachments stay local and are referenced from metadata. The limit and optional Git LFS behavior are configurable.

## Work Item user experience

### Creation

New Requirement and New Bug actions ask for:

- title;
- Original Description;
- optional priority;
- optional repositories;
- optional attachments.

Pi may suggest priority, duplicates, or affected repositories, but the user owns the final structured values.

### List

Desktop uses a sortable table with key, title, status, phase, priority, repositories, current Conversation, and update time. Mobile uses cards with the same important information. Filters cover type, status, priority, repository, and text.

The MVP is list-first and does not include a draggable board.

### Detail

A detail view combines:

- Original Description and current narrative;
- status, phase, priority, repositories, and relationships;
- a Continue Conversation action;
- related designs and plans;
- branch, commit, and verification links;
- the milestone timeline.

## Conversations

### Ownership

Every new Conversation belongs to one Workspace. A general Conversation has no primary Work Item. A work-oriented Conversation has exactly one primary Work Item and may reference related Work Items.

Conversation metadata records:

- Workspace identifier;
- optional primary Work Item identifier;
- resolved skill selection;
- selected/allowed repositories;
- source Conversation when context was copied across Workspaces.

### Historical sessions

Existing Pi session JSONL files are never moved or rewritten for Workspace migration. Sessions that cannot be matched to a Workspace appear under Unassigned Conversations. Associating one with a Workspace stores an external mapping while preserving the original Pi file.

### Runtime

Pi Agent remains in-process as in upstream Pi Web. Closing the browser, changing tabs, or locking a phone does not terminate an active Agent turn. Reconnecting restores running state and missing events. The user can explicitly stop the current Pi operation.

Pi Workspace displays Pi's token, cost, context, retry, compaction, and running state. It does not add a second execution-budget system.

### Repository permissions

A work-oriented Conversation may read all registered repositories in its Workspace and writes only to repositories selected on its primary Work Item. Expanding the writable set requires updating the Work Item scope and user confirmation.

In the single-user MVP, the fine-grained rule is a guard against accidental writes, not a security boundary against adversarial shell code.

## Pi extension

A first-party Pi extension exposes structured Work Item tools:

```text
work_item.get
work_item.create
work_item.update
work_item.change_phase
work_item.record_milestone
work_item.link_artifact
```

The extension and Web APIs call the same Work Item domain service. This guarantees identical schema validation, revision handling, atomic writes, and milestone creation for user and Agent actions.

Requirements analysis, Bug diagnosis, design, implementation, Git operations, testing, and review are still guided by Pi skills and `AGENTS.md`; they are not reimplemented in these tools.

## Workspace Explorer

The Explorer is a view rooted at the current Workspace, not a separate directory or domain object. It shows management documents, Work Items, knowledge, and all repositories.

The MVP adds:

- file and directory creation;
- document editing for Markdown, YAML, JSON, and plain text;
- preview and save-time diff;
- upload, rename, move, and recoverable delete;
- optimistic concurrency using revision or ETag;
- protected handling for application-managed files.

Source code remains viewable with syntax highlighting, Git diff, and line references to Conversations. A full source-code editor is outside the MVP.

## Responsive Web UI

### Desktop

Desktop retains the productive three-pane shape:

1. Workspace, Conversation, and Explorer navigation;
2. active Conversation or Work Item content;
3. file preview, diff, or supporting detail.

Workspace and Work Item affordances are added without replacing Pi Web's existing chat behavior.

### Mobile

Mobile renders one main view at a time with bottom navigation:

```text
Work Items | Conversations | Explorer | More
```

Navigation preserves scroll position and draft input across views. A Work Item can open its primary Conversation; a file can be cited into that Conversation and then return to the prior view.

Mobile supports agent-driven development:

- creating and advancing Work Items;
- chatting with Pi Agent;
- reviewing files and diffs;
- uploading screenshots and documents;
- approving requirements and plans;
- reviewing test and completion results.

It does not attempt to provide an IDE or terminal.

### Network resilience

The browser stores unsent drafts locally, reconnects SSE automatically, reconciles missed session and Work Item events, and preserves unsaved document content on network failure. It does not execute offline.

## Security and deployment

Pi Web has no application-level authentication and can invoke a high-privilege agent. The MVP therefore runs on a private network such as Tailscale or WireGuard and is not directly exposed to the public internet.

Docker Compose is the default server deployment:

- Pi Workspace runs as a dedicated non-root user;
- only the Workspace root and required Pi/Git configuration are mounted;
- host files outside those mounts are inaccessible;
- persistent volumes hold Pi sessions, Workspace files, template data, trash, and caches;
- health checks and restart policies keep the service recoverable.

Per-Conversation containers and strict repository-level mount permissions are deferred until a future multi-user design.

## Export and recovery

A Workspace export includes:

- `.pi/workspace.yaml`;
- collaboration policy;
- Work Items, designs, plans, and knowledge;
- selected attachments;
- repository URLs, branches, and commit references.

It excludes API keys, authentication material, caches, and Conversations by default. Full repositories may be included explicitly. Import validates paths and manifests before creating a Workspace.

Workspace deletion moves the whole Workspace into the global trash directory. Repository removal only marks it inactive and leaves its working copy in place.

## MVP acceptance criteria

1. A user can create `workspace-<slug>` from Empty or Software Development.
2. Workspace discovery works after deleting the SQLite cache.
3. A user can switch Workspaces and the Explorer root changes safely.
4. A software-development Workspace contains the agreed directories, collaboration policy, and management Git repository.
5. A user can clone, initialize, disable, and restore multiple code and knowledge repositories.
6. A user can create, edit, filter, and close Requirements and Bugs.
7. Work Item changes are revision-safe and produce append-only milestone events.
8. A Work Item can start or continue one primary Pi Conversation.
9. New Conversations receive the Workspace's Pi skill selection; Pi remains the execution engine.
10. Existing Pi sessions remain readable and appear as assigned or unassigned without JSONL rewrites.
11. Pi can read and update Work Items through the first-party extension.
12. The Workspace and Work Item flows are usable at desktop and mobile breakpoints.
13. Document editing cannot directly corrupt protected metadata or event files.
14. A Docker Compose deployment operates through a private-network URL with persistent data.
15. Type checking, linting, focused domain tests, and existing regression tests pass.
