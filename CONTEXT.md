# Pi Workspace

Pi Workspace is a local-first workspace for organizing software work around Pi Agent conversations. It gives files, repositories, requirements, bugs, and agent activity a shared language without replacing Pi Agent's execution model.

## Language

**Workspace**:
The top-level boundary that groups related files, repositories, conversations, collaboration rules, and work items.
_Avoid_: Project

**Workspace Template**:
A reusable starting point that supplies a Workspace with an initial structure, collaboration policy, and default skill selection.
_Avoid_: Project template, workflow engine

**Workspace Explorer**:
The view of files that belong to the current Workspace.
_Avoid_: Explorer directory, Project Explorer

**Repository**:
A version-controlled codebase registered with a Workspace. A Workspace may contain several repositories, while a repository belongs to only one Workspace working copy.
_Avoid_: Workspace, project

**Conversation**:
A persistent exchange between a user and Pi Agent that belongs to exactly one Workspace. A Conversation may be general or may advance one primary Work Item.
_Avoid_: Conversion, task

**Work Item**:
A user-visible unit of desired change or correction whose progress and outcomes are tracked.
_Avoid_: Task, ticket

**Requirement**:
A Work Item that describes a desired capability or behavior.
_Avoid_: Feature task

**Bug**:
A Work Item that describes behavior that differs from the expected behavior.
_Avoid_: Defect task

**Execution Task**:
A concrete unit of work performed by Pi Agent while advancing a Work Item.
_Avoid_: Work Item

**Original Description**:
The user's initial account of a Requirement or Bug, preserved separately from later analysis and clarification.
_Avoid_: Current specification

**Status**:
The broad lifecycle condition of a Work Item, such as open, in progress, blocked, done, or cancelled.
_Avoid_: Phase

**Phase**:
The current step within the workflow selected for a Work Item, such as analysis, approval, design, implementation, or verification.
_Avoid_: Status

**Milestone**:
A meaningful event in the history of a Work Item, such as approval, branch creation, a successful test, or completion.
_Avoid_: Tool call, chat message

**Collaboration Policy**:
The human-readable rules that explain how users and Pi Agent work together inside a Workspace.
_Avoid_: Machine configuration

**Workspace Configuration**:
The structured choices that Pi Workspace must apply deterministically for a Workspace.
_Avoid_: Collaboration Policy

**Skill Selection**:
The set of Pi skills chosen for new Conversations in a Workspace.
_Avoid_: Skill catalog

**Unassigned Conversation**:
An existing Pi Conversation that has not yet been associated with a Workspace.
_Avoid_: Orphaned Conversation
