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

### Feedback Loops

**Feedback Loop**:
A persistent definition of repeatable work whose completed Rounds can improve later Rounds.
_Avoid_: Scheduled Job, recurring prompt

**Round**:
One bounded execution of a Feedback Loop, with its own input, progress, and outcome.
_Avoid_: Loop, schedule tick

**Trigger**:
An idempotent request from a Trigger Source to start a Round of a specific Feedback Loop.
_Avoid_: Round, schedule

**Trigger Source**:
The origin that decides when to request a Round, such as a schedule, message, webhook, or person.
_Avoid_: Orchestrator, Feedback Loop

**Orchestrator Conversation**:
The single persistent Pi Conversation that coordinates a Round and presents its progress to the user.
_Avoid_: Worker Conversation, parent session

**Worker**:
An isolated, temporary agent invocation that performs one delegated responsibility and returns its result to the Orchestrator Conversation.
_Avoid_: Child Conversation, persistent subagent

**Maker**:
The Worker responsible for producing a Step's declared outcome.
_Avoid_: Checker, Orchestrator

**Checker**:
The Worker responsible for independently evaluating a Maker's outcome against declared acceptance criteria.
_Avoid_: Maker, self-reviewer

**Loop Definition**:
The Workspace-owned, authoritative description of a Feedback Loop's purpose, trigger policy, Round behavior, verification requirements, Gates, and improvement boundaries.
_Avoid_: Registry record, scheduled prompt

**Loop Service**:
The shared local service that accepts Triggers, schedules and dispatches Rounds, and coordinates their execution across trusted Workspaces.
_Avoid_: Pi extension, Workspace daemon, Loop Definition

**Loop Host**:
The independent local process that keeps the Loop Service available without requiring Pi Web or an interactive Pi session to remain open.
_Avoid_: Pi extension, Pi Web server

**Registry Index**:
A disposable catalog derived from registered Workspace Loop Definitions for discovery and dispatch.
_Avoid_: Loop database, source of truth

**Round Execution Backend**:
The adapter that runs an Orchestrator Conversation and its Workers for one Round within the target Workspace.
_Avoid_: Loop Service, Scheduler, Trigger Source

**Autonomy Level**:
The approved authority of a Feedback Loop: L1 reports only, L2 prepares or performs assisted actions requiring review, and L3 may perform proven low-risk actions unattended.
_Avoid_: Progress status, model capability

**Loop Audit**:
A review of Run evidence, failures, false positives, human escalations, and cost used to change a Loop or its Autonomy Level.
_Avoid_: Automatic self-modification, Checker verification

**Watchlist Monitor**:
The first real Feedback Loop used to discover the shared Loop contract: it observes configured targets, evaluates changes, and may deliver a verified report to Feishu.
_Avoid_: Example Loop, generic Loop template

**Watchlist**:
The Workspace-owned set of targets a Watchlist Monitor is responsible for observing.
_Avoid_: Report recipients, schedule

**Observation**:
A sourced fact collected about a Watchlist target during one Round.
_Avoid_: Report, unverified claim

**Baseline**:
The accepted prior state against which a Round evaluates new Observations.
_Avoid_: Run history, current report

**Monitor Verdict**:
The domain conclusion that a completed monitoring Round found either no reportable change or a reportable change.
_Avoid_: Round status, execution result
