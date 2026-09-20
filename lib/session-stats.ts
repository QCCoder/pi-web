export interface CacheRateTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Average cache hit rate across the session (upstream #471).
 *
 * Cache reads / (input + cache writes + cache reads) — the denominator covers
 * all input-class tokens. Returns null when there is nothing cache-related to
 * report (no reads/writes at all, or a zero denominator).
 */
export function computeCacheHitRatePercent(tokens: CacheRateTokens): number | null {
  const cacheTraffic = tokens.cacheRead + tokens.cacheWrite;
  const denominator = cacheTraffic + tokens.input;
  if (cacheTraffic <= 0 || denominator <= 0) return null;
  return (tokens.cacheRead / denominator) * 100;
}

// ---------------------------------------------------------------------------
// Cumulative session-file stats (upstream 93633c8): usage over ALL entries,
// including history a compaction summarized away, so token/cost counters do
// not visibly reset after compaction or branch navigation.
// ---------------------------------------------------------------------------

export interface SessionFileStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

type UsageLike = {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  cost?: { total?: number | null } | null;
};

type StatsEntry = {
  type?: string;
  usage?: UsageLike;
  message?: { role?: string; content?: unknown; usage?: UsageLike };
};

function emptyStats(): SessionFileStats {
  return {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function addUsage(stats: SessionFileStats, usage?: UsageLike | null): void {
  if (!usage) return;
  stats.tokens.input += usage.input ?? 0;
  stats.tokens.output += usage.output ?? 0;
  stats.tokens.cacheRead += usage.cacheRead ?? 0;
  stats.tokens.cacheWrite += usage.cacheWrite ?? 0;
  stats.cost += usage.cost?.total ?? 0;
}

/** Aggregate usage across ALL entries in a session file — the same semantics
 *  as the SDK's AgentSession.getSessionStats(): besides assistant (and
 *  tool-result) messages, this also counts usage recorded on compaction and
 *  branch-summary entries. Compaction only appends a summary entry — the
 *  summarized history stays in the file — so these totals grow monotonically,
 *  while sums over the visible context shrink whenever history is compacted
 *  away. Computed server-side by GET /api/sessions/[id] over the entries it
 *  already materializes. */
export function computeSessionFileStats(entries: readonly unknown[]): SessionFileStats {
  const stats = emptyStats();
  for (const entry of entries as readonly StatsEntry[]) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(stats, entry.usage);
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    stats.totalMessages += 1;
    if (message.role === "user") {
      stats.userMessages += 1;
    } else if (message.role === "toolResult") {
      stats.toolResults += 1;
      addUsage(stats, message.usage);
    } else if (message.role === "assistant") {
      stats.assistantMessages += 1;
      if (Array.isArray(message.content)) {
        stats.toolCalls += message.content.filter((c) => (c as { type?: string }).type === "toolCall").length;
      }
      addUsage(stats, message.usage);
    }
  }
  stats.tokens.total = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  return stats;
}

/** Per-field max() of the cumulative file stats and the live visible-message
 *  sum. The file side wins whenever compaction / branch navigation shrank the
 *  visible context (counters never visibly reset); the live side wins while
 *  fresh streaming usage has not been persisted yet. Upstream 93633c8 merges
 *  with a load-time delta because its message list is component state; the
 *  local pipeline mutates the cached SessionData in place, so the loaded and
 *  live sums are the same array and a monotone max is the equivalent guard. */
export function mergeSessionStats(fileStats: SessionFileStats | undefined, live: SessionFileStats): SessionFileStats {
  if (!fileStats) return live;
  const max = (a: number, b: number) => Math.max(a, b);
  const tokens = {
    input: max(fileStats.tokens.input, live.tokens.input),
    output: max(fileStats.tokens.output, live.tokens.output),
    cacheRead: max(fileStats.tokens.cacheRead, live.tokens.cacheRead),
    cacheWrite: max(fileStats.tokens.cacheWrite, live.tokens.cacheWrite),
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    userMessages: max(fileStats.userMessages, live.userMessages),
    assistantMessages: max(fileStats.assistantMessages, live.assistantMessages),
    toolCalls: max(fileStats.toolCalls, live.toolCalls),
    toolResults: max(fileStats.toolResults, live.toolResults),
    totalMessages: max(fileStats.totalMessages, live.totalMessages),
    tokens,
    cost: max(fileStats.cost, live.cost),
  };
}
