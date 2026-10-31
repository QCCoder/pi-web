# Use OpenCode as the execution reference and Codex as a product reference

> **已退役（2026-10 标注）**：项目已整体以 pi coding agent 为底座，OpenCode 本地服务模式与 Codex Automation 概念不再作为参照。现行 loop 协议见 `knowledge/designs/pi-loop-kit-design.md`。

Pi's verified constraints remain authoritative; within those constraints, the Loop system follows OpenCode's local-server patterns for Workspace-scoped instances, asynchronous execution, events, cancellation, and concurrency, while borrowing only Codex's user-facing Automation concepts such as recurrence, destination, continuity, and run review. Combining both internal models would create competing owners for schedules, sessions, approvals, and state, so Codex's unpublished scheduler and storage behavior and OpenCode's persistent child-session model are deliberately excluded.
