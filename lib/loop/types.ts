/** Public domain model for the generic Loop Runtime.

 * The engine is deliberately domain-agnostic. It only:
 *  - triggers (loop.yaml `triggers`),
 *  - hosts the orchestrator session,
 *  - pauses on `LOOP_GATE:` and resumes on a free-text `{message}`,
 *  - completes on `LOOP_VERDICT:` / natural end,
 *  - exposes an independent `abort` (destroy session -> failed),
 *  - writes RUNS.jsonl and hands `run.id` + the orchestrator `sessionId` to it.
 *
 * There is no autonomy level, no infer phase, no gate1, no JSON plan, and no
 * approve/reject. All domain behavior lives in each loop's own LOOP.md. */

export const LOOP_DEFINITION_SCHEMA_VERSION = 1 as const;

export type LoopTriggerSource = "cron" | "manual" | "message" | "webhook";

export type LoopRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface CronTriggerDefinition {
  id: string;
  type: "cron";
  expression: string;
  timezone: string;
  enabled: boolean;
}

export interface ExternalTriggerDefinition {
  id: string;
  type: "manual" | "message" | "webhook";
  enabled: boolean;
}

export type LoopTriggerDefinition = CronTriggerDefinition | ExternalTriggerDefinition;

/** Parsed from `<workspace>/loops/<loopId>/loop.yaml`.
 *
 *  Legacy `autonomy` keys in on-disk loop.yaml files are tolerated (the store
 *  reads them silently without validating) and are NOT surfaced here. */
export interface LoopDefinition {
  schemaVersion: typeof LOOP_DEFINITION_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  workspaceId: string;
  workspacePath: string;
  directory: string;
  instructionsPath: string;
  triggers: LoopTriggerDefinition[];
}

export interface TriggerCommand {
  workspaceId: string;
  loopId: string;
  source: LoopTriggerSource;
  /** Stable upstream id. Replays with the same id are de-duplicated. */
  eventId: string;
  payload?: Record<string, unknown>;
}

export interface TriggerReceipt {
  accepted: boolean;
  duplicate: boolean;
  runId: string;
}

export interface LoopRun {
  id: string;
  workspaceId: string;
  loopId: string;
  eventId: string;
  triggeredBy: LoopTriggerSource;
  status: LoopRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  sessionId?: string;
  /** Free-text payload of the `LOOP_VERDICT:` line (any conclusion, not a fixed
   *  enum). Undefined when the run ended without an explicit verdict. */
  verdict?: string;
  output?: string;
  error?: string;
  /** Best-effort, UI-facing hint about the orchestrator's current activity while
   *  the run is in `running` (e.g. "tool: bash", "subagent: architect"). Bumped on
   *  a heartbeat so a long round does not look frozen; cleared on a terminal
   *  snapshot. Not authoritative — only `status` is. */
  progress?: string;
  /** Set when a selection round emitted `LOOP_SEED: <KEY>` and the engine
   *  successfully seeded an execution session for it. The Loop view uses this
   *  to open the run's execution session directly (design v3 §7). */
  seededSessionId?: string;
  /** Set when a seed was REFUSED by the double-open guard (an execution
   *  session is already live/recent for that work item) — carries the guard's
   *  reason so the run record explains why nothing was seeded. */
  seedRefused?: string;
}


/** The deliberately small interface consumed by every adapter. v3: runs are
 *  thin selection rounds — no gate answering, no run-meta lookup, no
 *  orphan-gate reaping (execution sessions are normal sessions; gates are chat
 *  turns + `loop.gate` milestone stamps — see docs/dev-loop-v3-design.md). */
export interface LoopRuntime {
  listLoops(workspaceId: string): Promise<LoopDefinition[]>;
  trigger(command: TriggerCommand): Promise<TriggerReceipt>;
  getRun(workspaceId: string, runId: string): Promise<LoopRun>;
  /** Destroy the orchestrator session and mark the run failed. Works while
   *  the selection round is running. */
  abortRun(workspaceId: string, runId: string): Promise<LoopRun>;
}

export interface WorkspaceLocation {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceResolver {
  get(workspaceId: string): Promise<WorkspaceLocation>;
  list(): Promise<WorkspaceLocation[]>;
}

/** A coarse activity hint emitted mid-round so the runtime can write a
 *  heartbeat snapshot (a long round otherwise sits in `running` with no status
 *  transition, looking frozen in the UI). */
export interface RoundProgress {
  /** Short, UI-facing description of the latest orchestrator activity. */
  detail: string;
}

/** A round outcome. */
export interface RoundResult {
  output: string;
  /** The orchestrator's `LOOP_VERDICT:` text (any conclusion), if emitted. */
  verdict?: string;
  /** Present when a selection round seeded an execution session (v3): the
   *  work item key and the new session id. The runtime records it on the
   * terminal run snapshot as `seededSessionId`. */
  seed?: { key: string; sessionId: string };
  /** Present when the double-open guard refused the seed (design v3 §5). */
  seedRefused?: string;
}

/** Adapter seam between the domain-agnostic runtime and the orchestrator host
 *  (pi, in-process). v3: the orchestrator runs a single short selection
 *  round and is destroyed on its result or an abort — no cross-gate retention. */
export interface RoundExecutionBackend {
  /** Start the orchestrator session and run its single round. */
  startRound(
    definition: LoopDefinition,
    run: LoopRun,
    /** Called as soon as the orchestrator session exists, before the round
     *  finishes, so the runtime can persist the session id early. */
    onSessionReady?: (sessionId: string) => void,
    /** Throttled mid-round activity hint; the runtime turns each call into a
     *  heartbeat snapshot so a long round does not look frozen. */
    onProgress?: (info: RoundProgress) => void,
  ): Promise<RoundResult>;
  /** Destroy the orchestrator session backing `run`, if any. Must not throw
   *  when there is no live session. Does not prompt. */
  abortRound(run: LoopRun): Promise<void>;
}
