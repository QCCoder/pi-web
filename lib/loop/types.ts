/** Loop module types. */

export const LOOP_JOB_SCHEMA_VERSION = 1 as const;

/** How the captured automation output is delivered to Feishu. */
export type LoopProduceFormat = "card" | "text";

export type LoopRunStatus = "success" | "error";

export type LoopRunTrigger = "schedule" | "manual";

/**
 * A scheduled automation job. Serialized to
 * `<workspace>/automations/jobs/<name>.yaml`. The `prompt` field is the
 * natural-language "what to do" — it is the template/prompt sent to the
 * automation session.
 */
export interface LoopJob {
  name: string;
  /** Short human label shown in lists and used as the push card title. */
  description: string;
  /** Natural-language "what to do" — the prompt/template for the automation session. */
  prompt: string;
  /** Daily schedule in `HH:MM` (Asia/Shanghai), e.g. "15:05". */
  schedule: string;
  /** Watchlist file reference under `automations/` (without `.md`); "" or "watchlist" => automations/watchlist.md. */
  watchlist: string;
  /** Feishu receive_id override; "" => the workspace default receive_id. */
  pushTarget: string;
  /** Delivery format for the captured output. */
  produceFormat: LoopProduceFormat;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted by the create/update API (server fills timestamps). */
export interface UpsertLoopJobInput {
  name: string;
  description?: string;
  prompt: string;
  schedule: string;
  watchlist?: string;
  pushTarget?: string;
  produceFormat?: LoopProduceFormat;
  enabled?: boolean;
}

export interface LoopPushResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** One execution record, appended to `automations/runs/<name>.jsonl`. */
export interface LoopRun {
  id: string;
  jobName: string;
  startedAt: string;
  finishedAt: string;
  status: LoopRunStatus;
  /** Automation session id (pi's real session id). */
  sessionId: string;
  /** Captured assistant output (truncated for storage). */
  output: string;
  /** Feishu push result, if a push was attempted. */
  push?: LoopPushResult;
  /** Error message when status === "error". */
  error?: string;
  triggeredBy: LoopRunTrigger;
}
