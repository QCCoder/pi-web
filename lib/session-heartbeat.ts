/**
 * Session heartbeat stall classification (pure).
 *
 * The daemon's heartbeat monitor asks one question every tick: for each
 * RUNNING session wrapper, how long since its last activity (any agent event —
 * streaming deltas, tool-execution partials, message boundaries — or an
 * inbound command)? A healthy turn is never silent for long: the model streams
 * deltas continuously and tools emit partials as they progress. A run that
 * claims `running` but has been silent for tens of minutes is hung (stuck
 * network call, an extension awaiting forever, a tool ignoring its abort
 * signal) — exactly the REQ-0026 class where a session sat "running" for 4
 * hours with zero writes and nothing noticed.
 *
 * Two tiers:
 *  - `warn`  — 5 min silent: surfaced via state/running payloads ("疑似无响应
 *              N 分钟"), no action. Gives a watching human the "don't wait, it's
 *              stuck" signal before any automatic action. Well above the worst
 *              legit first-token delay (large-context thinking models ≈ 2-3 min).
 *  - `kill`  — 20 min silent: auto-interrupt (wrapper.destroy(): aborts the
 *              in-flight prompt, drops the registry entry, closes the SSE). The
 *              turn is unrecoverable by construction at this point; interrupting
 *              lets the human simply resend. The margin exists for QUIET BUILDS:
 *              pi's bash tool only emits partials when there IS output, so a
 *              legit `npm install` / `mvn` build is genuinely eventless for its
 *              whole duration — the threshold must outlive the longest normal
 *              build (and a subagent parent is likewise silent while its child
 *              builds). Bias is still toward the rare false kill being
 *              recoverable (resend) over the certain zombie being permanent
 *              (manual daemon restart) — REQ-0026 sat 4 hours before anyone
 *              noticed; 20 min bounds that class.
 *
 * NOT covered here: hangs during session CREATION (wrapper not in the registry
 * yet) — those are bounded by StartSessionOptions.signal / raceAbort
 * (lib/abort-race.ts). Gate-paused sessions are NOT `running` and are never
 * monitored (a human-wait can last arbitrarily long); sessions blocked on a
 * pending extension UI request (confirm/select/…) are exempted by the monitor
 * for the same reason (see AgentSessionWrapper.hasPendingUiRequests).
 *
 * Thresholds are env-overridable for ops tuning:
 *   PI_SESSION_STALL_WARN_MS (default 5 min)
 *   PI_SESSION_STALL_KILL_MS (default 20 min)
 */

function envMs(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export const STALL_WARN_MS = envMs("PI_SESSION_STALL_WARN_MS") ?? 5 * 60 * 1000;
export const STALL_KILL_MS = envMs("PI_SESSION_STALL_KILL_MS") ?? 20 * 60 * 1000;

/** Monitor tick cadence (daemon-side, unref'd interval — never keeps the
 *  process alive, and never runs in the web process; see rpc-manager header). */
export const HEARTBEAT_TICK_MS = 60 * 1000;

export type StallLevel = "none" | "warn" | "kill";

/** Classify a running session by its idle time (ms since last activity). */
export function classifyStall(idleMs: number, warnMs = STALL_WARN_MS, killMs = STALL_KILL_MS): StallLevel {
  if (idleMs >= killMs) return "kill";
  if (idleMs >= warnMs) return "warn";
  return "none";
}

export interface StalledSessionInfo {
  id: string;
  /** ms since the session's last observed activity. */
  idleMs: number;
  level: StallLevel;
}

/** Build the stalled snapshot for a set of running sessions
 *  (`[{ id, idleMs }]`, already classified, sorted longest-idle first).
 *  Non-stalled sessions are omitted. */
export function buildStalledSnapshot(
  running: Array<{ id: string; idleMs: number }>,
  warnMs = STALL_WARN_MS,
  killMs = STALL_KILL_MS,
): StalledSessionInfo[] {
  return running
    .map((s) => ({ ...s, level: classifyStall(s.idleMs, warnMs, killMs) }))
    .filter((s) => s.level !== "none")
    .sort((a, b) => b.idleMs - a.idleMs);
}

/** Human-readable reason attached to the synthetic prompt_error emitted just
 *  before an auto-interrupt, so a live viewer sees WHY the run stopped. */
export function stallInterruptMessage(idleMs: number): string {
  const minutes = Math.round(idleMs / 60_000);
  return `会话疑似卡死（运行中 ${minutes} 分钟无任何心跳事件），已自动中断。重发消息即可从中断处续跑。`;
}
