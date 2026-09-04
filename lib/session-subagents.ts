import type { AgentMessage, ToolResultMessage } from "./types.ts";

/**
 * "Subagents spawned in this session" — a pure derivation from the session
 * message stream (no I/O, no backend). Data source: `delegate_task` /
 * `delegate_flow` tool results and live updates (community @henryqw/pi-subagent
 * transport shape):
 *
 *   details = { mode, entries: [{ id, index, role, status, summary?, model?,
 *               thinkingLevel?, session?: { id, cwd } }] }
 *
 * `session` is stamped at child LAUNCH (the package's prepare step), so
 * running delegations contribute too — ChatWindow feeds the live
 * tool_execution_update partials in as synthetic ToolResultMessages.
 *
 * Why this exists: a persisted child session is hidden from EVERY session
 * list (subagent-child.ts prefix filter), and kit loop rounds are
 * auto-archived by the spawner's D9 hook — the delegate_task result card in
 * the transcript was the ONLY remaining entry. This derivation gives the
 * parent chat a scroll-free index of everything it delegated, durable across
 * compaction-free history and usable from archived round sessions.
 *
 * Matching is by SHAPE, not tool name: persisted toolResult messages don't
 * always carry `toolName`, and any entry exposing `session.id` through this
 * transport is by construction a jumpable child session.
 */

export type SubagentEntryStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "skipped";

export interface SubagentEntry {
  /** Persisted child session id (`pi-subagent-<uuid>`). */
  id: string;
  role: string;
  status: SubagentEntryStatus;
  summary?: string;
  /** Child cwd — worktree-isolated children carry the worktree path. */
  cwd?: string;
}

interface Accumulator extends SubagentEntry {
  /** Monotonic sequence of the last mention — higher = more recent. */
  lastIndex: number;
}

function normalizeStatus(v: unknown): SubagentEntryStatus {
  switch (v) {
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "rejected":
    case "skipped":
      return v;
    default:
      return "pending";
  }
}

/** Record every entries[].session found in one transport payload. */
function collectFromDetails(map: Map<string, Accumulator>, seq: { n: number }, details: unknown): void {
  if (!details || typeof details !== "object") return;
  const entries = (details as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const session = (entry as { session?: unknown }).session;
    if (!session || typeof session !== "object") continue;
    const id = (session as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const e = entry as Record<string, unknown>;
    const s = session as Record<string, unknown>;
    const next: Accumulator = {
      id,
      role: typeof e.role === "string" ? e.role : "agent",
      status: normalizeStatus(e.status),
      ...(typeof e.summary === "string" && e.summary.length > 0 ? { summary: e.summary } : {}),
      ...(typeof s.cwd === "string" && s.cwd.length > 0 ? { cwd: s.cwd } : {}),
      lastIndex: seq.n++,
    };
    // Same child mentioned by successive updates (running → succeeded):
    // keep the latest role/status/summary, refresh recency.
    map.set(id, next);
  }
}

function collectFromToolResult(map: Map<string, Accumulator>, seq: { n: number }, message: AgentMessage): void {
  if (message.role !== "toolResult") return;
  collectFromDetails(map, seq, message.details);
}

export interface DeriveSessionSubagentsOptions {
  /** Synthetic toolResults built from live tool_execution_update partials
   *  (ChatWindow's streamingToolResults map) — running delegations count
   *  immediately, exactly like completed ones. */
  streamingToolResults?: ReadonlyMap<string, ToolResultMessage> | null;
}

/** Derive the deduplicated, most-recent-first list of subagent child sessions
 *  referenced by this session's delegate tool traffic. Pure. */
export function deriveSessionSubagents(
  messages: readonly AgentMessage[],
  options?: DeriveSessionSubagentsOptions,
): SubagentEntry[] {
  const map = new Map<string, Accumulator>();
  const seq = { n: 0 };

  for (const message of messages) {
    collectFromToolResult(map, seq, message);
  }
  for (const partial of options?.streamingToolResults?.values() ?? []) {
    collectFromDetails(map, seq, partial.details);
  }

  return Array.from(map.values())
    .sort((a, b) => b.lastIndex - a.lastIndex || (a.id < b.id ? -1 : 1))
    .map(({ id, role, status, summary, cwd }) => ({
      id,
      role,
      status,
      ...(summary !== undefined ? { summary } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    }));
}
