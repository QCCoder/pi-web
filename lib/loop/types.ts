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
  | "waiting_for_gate"
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
  statePath: string;
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
  /** Free-text payload of the last `LOOP_GATE:` line the orchestrator emitted.
   *  Set when the run pauses on a gate; cleared when it resumes. */
  gateRequest?: string;
  /** Free-text payload of the `LOOP_VERDICT:` line (any conclusion, not a fixed
   *  enum). Undefined when the run ended without an explicit verdict. */
  verdict?: string;
  output?: string;
  error?: string;
}

/** A free-text answer to a paused `LOOP_GATE:`. The engine forwards `message`
 *  verbatim as the orchestrator's next prompt — its meaning is defined by each
 *  loop's LOOP.md. */
export interface GateAnswer {
  workspaceId: string;
  runId: string;
  message: string;
}

/** The deliberately small interface consumed by every adapter. */
export interface LoopRuntime {
  listLoops(workspaceId: string): Promise<LoopDefinition[]>;
  trigger(command: TriggerCommand): Promise<TriggerReceipt>;
  getRun(workspaceId: string, runId: string): Promise<LoopRun>;
  answerGate(command: GateAnswer): Promise<LoopRun>;
  /** Destroy the orchestrator session and mark the run failed. Independent of
   *  gate answering; works while the run is running or paused at a gate. */
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

/** A round outcome shared by `startRound` and `resumeRound`. */
export interface RoundResult {
  output: string;
  /** The orchestrator's `LOOP_VERDICT:` text (any conclusion), if emitted. */
  verdict?: string;
  /** The orchestrator's `LOOP_GATE:` payload, if it paused for a human. */
  gateRequest?: string;
}

/** Adapter seam between the domain-agnostic runtime and the orchestrator host
 *  (pi, in-process). One orchestrator session is kept alive across gates;
 *  it is only destroyed on a terminal result or an abort. */
export interface RoundExecutionBackend {
  /** Start the orchestrator session and run its first prompt. The session is
   *  registered and kept alive (for a later `resumeRound`) unless this returns
   *  a terminal result (no `gateRequest`), in which case it is destroyed. */
  startRound(
    definition: LoopDefinition,
    run: LoopRun,
    /** Called as soon as the orchestrator session exists, before the round
     *  finishes, so the runtime can persist the session id early. */
    onSessionReady?: (sessionId: string) => void,
  ): Promise<RoundResult>;
  /** Continue an existing (paused) orchestrator session with a free-text
   *  message — the gate answer, used verbatim as the next prompt. The session
   *  is kept alive unless this returns a terminal result. */
  resumeRound(run: LoopRun, message: string): Promise<RoundResult>;
  /** Destroy the orchestrator session backing `run`, if any. Must not throw
   *  when there is no live session. Does not prompt. */
  abortRound(run: LoopRun): Promise<void>;
}
