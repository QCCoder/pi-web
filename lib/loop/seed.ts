import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getRpcSession, startRpcSession } from "../daemon/rpc-manager.ts";
import type { AgentSessionWrapper } from "../daemon/rpc-manager.ts";
import { creationTimeoutSignal } from "../abort-race";
import { resolveSessionPath } from "../session-reader.ts";
import { readWorkItem, recordWorkItemMilestone, updateWorkItem } from "../work-items/service.ts";

/**
 * dev-loop v3 seeding (docs/dev-loop-v3-design.md §5).
 *
 * The loop round is a thin SELECTION round: it picks a work item and emits
 * `LOOP_SEED: <KEY>`. This module turns that marker into a deterministic,
 * engine-owned "seed": a normal execution session running the loop's skill
 * contract, linked to the work item, guarded against double-open. Everything
 * here is deterministic I/O — never delegated to an LLM.
 *
 * Convention: the skill invoked is named after the loop id (`dev-loop` ->
 * `/skill:dev-loop`), so any loop whose contract lives in
 * `<workspace>/.agents/skills/<loopId>/SKILL.md` is seedable without further
 * configuration.
 */

/** How long an idle (non-live) stamped session still counts as "the active
 *  execution" — matches the zombie threshold the selection round reports on
 *  (decision 1: remind, don't restart). */
export const SEED_INACTIVITY_MS = 2 * 60 * 60 * 1000;
/** Upper bound on execution-session creation. Creation normally takes
 *  seconds; a hang here (stuck network call inside session services/model
 *  resolution) used to pin the seeding request — and any late-materializing
 *  session would have run the contract as an unowned zombie. */
const SESSION_START_TIMEOUT_MS = 5 * 60 * 1000;

/** Extract the work-item key from a selection round's output. The thin
 *  LOOP.md promises the marker on its own final line; tolerate casing and
 *  spacing so a slightly misbehaving round still seeds. */
export function parseLoopSeed(output: string): string | undefined {
  const match = output.match(/LOOP_SEED\s*:\s*((?:REQ|BUG)-\d+)/i);
  return match?.[1]?.toUpperCase();
}

/** The opening prompt of an execution session. `/skill:` is expanded by the
 *  daemon's AgentSession before the first turn — the contract is mechanically
 *  in context, never betting on model compliance. */
export function buildSeedPrompt(skillId: string, key: string, mode: "execute" | "adopt"): string {
  return `/skill:${skillId} ${mode === "adopt" ? "收养" : "执行"} ${key}`;
}

export interface SeedGuardInput {
  /** Session id from the most recent `loop.active_session` stamp, if any. */
  stampedSessionId?: string;
  phase: string;
  status: string;
  /** Is the stamped session's wrapper still alive in this process? */
  wrapperAlive: boolean;
  /** mtime of the stamped session's `.jsonl`; undefined when the file is gone
   *  (archived/removed). */
  lastActivityMs?: number;
  nowMs?: number;
}

export interface SeedGuardVerdict {
  allowed: boolean;
  reason: string;
}

/** Double-open guard (design decision 2): the authoritative combination of
 *  stamp + liveness + item terminality. A stale stamp is always harmless —
 *  no background cleanup exists or is needed:
 *    no stamp                          -> allow
 *    item terminal                     -> allow (stale stamp overridden)
 *    wrapper alive                     -> block (a run is live)
 *    idle but recently active          -> block (gate-paused or human-driven)
 *    idle and quiet / file gone        -> allow (zombie -> adoption)          */
export function evaluateSeedGuard(input: SeedGuardInput): SeedGuardVerdict {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.stampedSessionId) {
    return { allowed: true, reason: "no active-session stamp" };
  }
  if (input.phase === "complete" || input.status === "done" || input.status === "cancelled") {
    return { allowed: true, reason: "work item is terminal — stale stamp overridden" };
  }
  if (input.wrapperAlive) {
    return { allowed: false, reason: "an execution session is still live for this work item" };
  }
  if (input.lastActivityMs !== undefined && nowMs - input.lastActivityMs <= SEED_INACTIVITY_MS) {
    return {
      allowed: false,
      reason: "the last execution session was active recently (idle at a gate, or human-driven)",
    };
  }
  return { allowed: true, reason: "stamped session is inactive — zombie, adoption allowed" };
}

export interface SeedExecutionInput {
  workspaceId: string;
  workspacePath: string;
  /** Loop id — doubles as the skill name (see convention above). */
  skillId: string;
  key: string;
  mode?: "execute" | "adopt";
}

export interface SeedExecutionResult {
  seeded: boolean;
  /** The new execution session id (present when seeded). */
  sessionId?: string;
  reason: string;
}

/** Read the most recent `loop.active_session` stamp from a work item's
 *  events.jsonl. Engine-written only; never resurrected from anything else. */
function stampedSessionIdFrom(events: Array<{ type: string; data?: Record<string, unknown> }>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "loop.active_session") continue;
    const sessionId = event.data?.sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
  }
  return undefined;
}

/** Seed (or refuse to seed) an execution session for a work item. Used by
 *  both entry points — the loop engine after a selection round and the
 *  work-item "按合同执行" button — so they share one guard, one prompt shape
 *  and one bookkeeping path. Throws WorkItemNotFoundError for unknown keys
 *  (callers map to 404); guard refusals are a normal `seeded: false` result. */
export async function seedExecutionSession(input: SeedExecutionInput): Promise<SeedExecutionResult> {
  const mode = input.mode ?? "execute";
  const detail = await readWorkItem(input.workspacePath, input.key);
  const stampedSessionId = stampedSessionIdFrom(detail.events);
  let wrapperAlive = false;
  let lastActivityMs: number | undefined;
  if (stampedSessionId) {
    wrapperAlive = getRpcSession(stampedSessionId)?.isAlive() ?? false;
    const sessionFile = await resolveSessionPath(stampedSessionId);
    if (sessionFile) lastActivityMs = statSync(sessionFile).mtimeMs;
  }
  const verdict = evaluateSeedGuard({
    stampedSessionId,
    phase: detail.item.phase,
    status: detail.item.status,
    wrapperAlive,
    lastActivityMs,
  });
  if (!verdict.allowed) return { seeded: false, reason: verdict.reason };

  // Loop roles need no injection anymore: the seeded execution session's cwd
  // IS the workspace root, and the community subagent package discovers
  // workspace roles from `<cwd>/.pi/agents/pi-subagent/` on its own.
  // One-time key so two concurrent seeds never coalesce onto one session.
  // Creation is bounded: on hang/abort nothing is stamped and a session that
  // materializes late is destroyed by startRpcSession (no zombie contract run).
  const { signal: startSignal, dispose: disposeStartTimer } = creationTimeoutSignal(
    SESSION_START_TIMEOUT_MS,
    "execution session creation timed out",
  );
  let session: AgentSessionWrapper;
  let realSessionId: string;
  try {
    ({ session, realSessionId } = await startRpcSession(
      `__seed__${randomUUID()}`,
      "",
      input.workspacePath,
      undefined,
      { signal: startSignal },
    ));
  } finally {
    disposeStartTimer();
  }
  // Deterministic title: the first message is the expanded skill contract —
  // huge and useless as a tab label.
  session.inner.setSessionName(`${input.key} ${detail.item.title}`);
  // `send` resolves once the prompt is accepted; the contract run itself
  // continues asynchronously. If this rejects, nothing was stamped — the
  // orphan session is harmless and the caller sees the error.
  await session.send({ type: "prompt", message: buildSeedPrompt(input.skillId, input.key, mode) });

  await updateWorkItem(input.workspaceId, input.key, {
    conversations: Array.from(new Set([...detail.item.conversations, realSessionId])),
    expectedRevision: detail.item.revision,
  });
  await recordWorkItemMilestone(input.workspaceId, input.key, {
    type: "loop.started",
    conversationId: realSessionId,
    data: { mode, skillId: input.skillId },
  });
  await recordWorkItemMilestone(input.workspaceId, input.key, {
    type: "loop.active_session",
    conversationId: realSessionId,
    data: { sessionId: realSessionId },
  });
  return { seeded: true, sessionId: realSessionId, reason: verdict.reason };
}
