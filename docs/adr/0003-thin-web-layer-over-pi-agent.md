# Keep the Web layer thin over Pi Agent

Pi Workspace owns Workspace management, Work Item persistence, responsive views, and a small set of structured Work Item tools, while Pi Agent continues to own conversations, models, tools, skills, retries, compaction, usage, and execution lifecycle. New agent-facing behavior is delivered through Pi skills and a first-party extension instead of modifications to Pi core or a second workflow engine, reducing duplicated behavior and the cost of tracking upstream Pi releases.
