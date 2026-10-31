# Keep one Orchestrator Conversation and use ephemeral Workers

> **已退役（2026-10 标注）**：Orchestrator 会话 + Maker/Checker 临时 Worker 模型已随 v3 loop 引擎拆除。现行形态 = pi-loop kit 一次性轮会话（`knowledge/designs/pi-loop-kit-design.md`）与交付四角色会话（`knowledge/architecture.md`）。

Each Round has one persistent Orchestrator Conversation, while Maker and Checker responsibilities run as isolated, temporary Workers whose results return to that Conversation. This preserves role and context isolation without filling Pi's session history with implementation-only child conversations, and keeps the Round observable in one window; independently resumable worker conversations are deliberately excluded.
