# Keep one Orchestrator Conversation and use ephemeral Workers

Each Round has one persistent Orchestrator Conversation, while Maker and Checker responsibilities run as isolated, temporary Workers whose results return to that Conversation. This preserves role and context isolation without filling Pi's session history with implementation-only child conversations, and keeps the Round observable in one window; independently resumable worker conversations are deliberately excluded.
