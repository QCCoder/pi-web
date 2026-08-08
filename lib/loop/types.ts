/** Public domain model for the generic Loop Runtime. */

export const LOOP_DEFINITION_SCHEMA_VERSION = 1 as const;

export type LoopTriggerSource = "cron" | "manual" | "message" | "webhook";
export type LoopRunStatus =
  | "queued"
  | "inferring"
  | "waiting_for_confirmation"
  | "running"
  | "waiting_for_gate"
  | "succeeded"
  | "failed"
  | "cancelled";
export type MonitorVerdict = "changed" | "unchanged" | "unknown";
export type AutonomyLevel = "L1" | "L2" | "L3";

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

/** Parsed from `<workspace>/loops/<loopId>/loop.yaml`. */
export interface LoopDefinition {
  schemaVersion: typeof LOOP_DEFINITION_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  autonomy: AutonomyLevel;
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

export interface InferredLoopPlan {
  summary: string;
  steps: Array<{
    id: string;
    maker: string;
    verifier: string;
    gate?: string;
  }>;
  improve: string;
  fingerprint: string;
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
  plan?: InferredLoopPlan;
  gateRequest?: string;
  verdict?: MonitorVerdict;
  output?: string;
  error?: string;
}

export interface GateCommand {
  workspaceId: string;
  runId: string;
  decision: "approve" | "reject";
  comment?: string;
}

/** The deliberately small interface consumed by every adapter. */
export interface LoopRuntime {
  listLoops(workspaceId: string): Promise<LoopDefinition[]>;
  trigger(command: TriggerCommand): Promise<TriggerReceipt>;
  getRun(workspaceId: string, runId: string): Promise<LoopRun>;
  answerGate(command: GateCommand): Promise<LoopRun>;
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

export interface RoundExecutionBackend {
  infer(
    definition: LoopDefinition,
    run: LoopRun,
    /** Called as soon as the orchestrator session exists, before inference finishes. */
    onSessionReady?: (sessionId: string) => void,
  ): Promise<{
    sessionId: string;
    plan: InferredLoopPlan;
  }>;
  execute(definition: LoopDefinition, run: LoopRun, comment?: string): Promise<{
    output: string;
    verdict?: MonitorVerdict;
    gateRequest?: string;
  }>;
  reject(run: LoopRun, comment?: string): Promise<void>;
}
