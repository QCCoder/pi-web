import { createUlid } from "../workspaces/id.ts";
import {
  appendRunSnapshot,
  listLoopDefinitions,
  listRunSnapshots,
  LoopConflictError,
  LoopNotFoundError,
  readLoopDefinition,
} from "./store.ts";
import type {
  LoopRun,
  LoopRuntime,
  RoundExecutionBackend,
  RoundResult,
  TriggerCommand,
  TriggerReceipt,
  WorkspaceLocation,
  WorkspaceResolver,
} from "./types.ts";

/** Orchestrates lifecycle only; domain work remains in LOOP.md and the
 *  orchestrator session.
 *
 *  Lifecycle: `queued → running → succeeded | failed`. A run is a thin
 *  SELECTION round driven entirely by `startRound` (on trigger), plus an
 *  independent `abortRun` that destroys the in-flight session and marks the run
 *  failed. A round that ends with `LOOP_SEED: <KEY>` additionally seeds a
 *  normal execution session (see seed.ts) — recorded as `seededSessionId`.
 *
 *  Concurrency guard for abort: `abortRun` adds the run id to `aborted` BEFORE
 *  destroying the session, then writes the failed snapshot. The in-flight
 *  `start`/`resume` whose session was just destroyed will reject; its catch
 *  checks `aborted.has(runId)` first and returns without overwriting the abort's
 *  failed snapshot. (Order matters: abort must win.) */
export class DefaultLoopRuntime implements LoopRuntime {
  private readonly active = new Map<string, Promise<void>>();
  private readonly aborted = new Set<string>();
  private readonly triggerLocks = new Map<string, Promise<TriggerReceipt>>();
  /** Per-run serializer for RUNS.jsonl appends. A fire-and-forget heartbeat
   *  emitted during a long round must not overtake the terminal snapshot
   *  written after the round resolves — `listRunSnapshots` keeps the last line
   *  per id, so write order IS the visible run state. */
  private readonly snapshotChains = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaces: WorkspaceResolver,
    private readonly execution: RoundExecutionBackend,
  ) {}

  async listLoops(workspaceId: string) {
    return listLoopDefinitions(await this.workspaces.get(workspaceId));
  }

  async trigger(command: TriggerCommand): Promise<TriggerReceipt> {
    const key = `${command.workspaceId}:${command.loopId}:${command.eventId}`;
    const inflight = this.triggerLocks.get(key);
    if (inflight) return inflight;
    const operation = this.acceptTrigger(command).finally(() => this.triggerLocks.delete(key));
    this.triggerLocks.set(key, operation);
    return operation;
  }

  private async acceptTrigger(command: TriggerCommand): Promise<TriggerReceipt> {
    const workspace = await this.workspaces.get(command.workspaceId);
    const definition = await readLoopDefinition(workspace, command.loopId);
    if (!definition.enabled) throw new LoopConflictError(`loop is disabled: ${definition.id}`);
    const isManual = command.source === "manual";
    if (!isManual && !definition.triggers.some((trigger) => trigger.type === command.source && trigger.enabled)) {
      throw new LoopConflictError(`trigger source ${command.source} is not enabled for ${definition.id}`);
    }
    const existing = (await listRunSnapshots(workspace, definition.id))
      .find((run) => run.eventId === command.eventId);
    if (existing) return { accepted: false, duplicate: true, runId: existing.id };

    const now = new Date().toISOString();
    const run: LoopRun = {
      id: createUlid(), workspaceId: workspace.id, loopId: definition.id,
      eventId: command.eventId, triggeredBy: command.source,
      status: "queued", startedAt: now, updatedAt: now,
    };
    await appendRunSnapshot(workspace, run);
    this.active.set(run.id, this.start(workspace, definition, run));
    return { accepted: true, duplicate: false, runId: run.id };
  }

  async getRun(workspaceId: string, runId: string): Promise<LoopRun> {
    const workspace = await this.workspaces.get(workspaceId);
    const run = (await listRunSnapshots(workspace)).find((candidate) => candidate.id === runId);
    if (!run) throw new LoopNotFoundError(`run not found: ${runId}`);
    return run;
  }

  async abortRun(workspaceId: string, runId: string): Promise<LoopRun> {
    const workspace = await this.workspaces.get(workspaceId);
    const run = await this.getRun(workspaceId, runId);
    if (run.status !== "running" && run.status !== "queued") {
      throw new LoopConflictError(`run ${run.id} cannot be aborted in status ${run.status}`);
    }
    // Guard FIRST: any in-flight start/resume whose session we destroy below must
    // see this and skip writing its own failed snapshot.
    this.aborted.add(run.id);
    await this.execution.abortRound(run);
    const aborted = this.patch(run, {
      status: "failed", error: "aborted", finishedAt: new Date().toISOString(),
    });
    await appendRunSnapshot(workspace, aborted);
    return aborted;
  }

  /** Start the orchestrator session and run its first prompt (replaces infer). */
  private async start(
    workspace: WorkspaceLocation,
    definition: Awaited<ReturnType<typeof readLoopDefinition>>,
    run: LoopRun,
  ): Promise<void> {
    try {
      let current = this.patch(run, { status: "running" });
      await appendRunSnapshot(workspace, current);
      const result = await this.execution.startRound(definition, current, async (sessionId) => {
        // Record the orchestrator session id as soon as it exists so the UI can
        // open it live instead of waiting for the whole round to finish. Keep
        // `current` in sync so the terminal snapshot (settle) carries it too.
        current = this.patch(current, { sessionId });
        await appendRunSnapshot(workspace, current);
      }, (info) => {
        // Heartbeat: a long round (subagent trace, slow model) sits in
        // `running` with no status transition for many minutes. Bump updatedAt +
        // progress so the run card reflects activity instead of looking frozen.
        this.heartbeat(workspace, current, info.detail);
      });
      // Abort may have destroyed the session and written a failed snapshot
      // while startRound was finishing; do not overwrite it with settle.
      if (this.aborted.has(run.id)) return;
      await this.settle(workspace, current, result);
    } catch (error) {
      // Abort wins: if this run was aborted, its failed snapshot is already
      // written — do not overwrite it.
      if (this.aborted.has(run.id)) return;
      await this.fail(workspace, run, error);
    } finally {
      this.active.delete(run.id);
      this.aborted.delete(run.id);
    }
  }

  /** Apply a round result: mark succeeded (terminal). */
  private async settle(workspace: WorkspaceLocation, run: LoopRun, result: RoundResult): Promise<void> {
    await this.writeSnapshot(workspace, this.patch(run, {
      status: "succeeded", output: result.output, verdict: result.verdict,
      progress: undefined, finishedAt: new Date().toISOString(),
      ...(result.seed ? { seededSessionId: result.seed.sessionId } : {}),
    }));
  }

  private async fail(workspace: WorkspaceLocation, run: LoopRun, error: unknown) {
    await this.writeSnapshot(workspace, this.patch(run, {
      status: "failed", error: error instanceof Error ? error.message : String(error),
      progress: undefined, finishedAt: new Date().toISOString(),
    }));
  }

  /** Serialize RUNS.jsonl appends per run (see `snapshotChains`). */
  private writeSnapshot(workspace: WorkspaceLocation, run: LoopRun): Promise<void> {
    const prev = this.snapshotChains.get(run.id) ?? Promise.resolve();
    const next = prev.then(
      () => appendRunSnapshot(workspace, run),
      () => appendRunSnapshot(workspace, run),
    );
    this.snapshotChains.set(run.id, next.catch(() => {}));
    return next;
  }

  /** Append a heartbeat snapshot (bumped updatedAt + progress) without a status
   *  change. Fire-and-forget; serialized via `writeSnapshot` so it cannot
   *  overtake the terminal snapshot. */
  private heartbeat(workspace: WorkspaceLocation, run: LoopRun, detail: string): void {
    void this.writeSnapshot(workspace, this.patch(run, { progress: detail }));
  }

  private patch(run: LoopRun, patch: Partial<LoopRun>): LoopRun {
    return { ...run, ...patch, updatedAt: new Date().toISOString() };
  }
}
