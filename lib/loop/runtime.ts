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
  GateCommand,
  LoopRun,
  LoopRuntime,
  RoundExecutionBackend,
  TriggerCommand,
  TriggerReceipt,
  WorkspaceLocation,
  WorkspaceResolver,
} from "./types.ts";

/** Orchestrates lifecycle only; domain work remains in LOOP.md and Pi. */
export class DefaultLoopRuntime implements LoopRuntime {
  private readonly active = new Map<string, Promise<void>>();
  private readonly triggerLocks = new Map<string, Promise<TriggerReceipt>>();

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
    this.active.set(run.id, this.infer(workspace, definition, run));
    return { accepted: true, duplicate: false, runId: run.id };
  }

  async getRun(workspaceId: string, runId: string): Promise<LoopRun> {
    const workspace = await this.workspaces.get(workspaceId);
    const run = (await listRunSnapshots(workspace)).find((candidate) => candidate.id === runId);
    if (!run) throw new LoopNotFoundError(`run not found: ${runId}`);
    return run;
  }

  async answerGate(command: GateCommand): Promise<LoopRun> {
    const workspace = await this.workspaces.get(command.workspaceId);
    const run = await this.getRun(command.workspaceId, command.runId);
    if (run.status !== "waiting_for_confirmation" && run.status !== "waiting_for_gate") {
      throw new LoopConflictError(`run ${run.id} is not waiting for a decision`);
    }
    const definition = await readLoopDefinition(workspace, run.loopId);
    if (command.decision === "reject") {
      await this.execution.reject(run, command.comment);
      const rejected = this.patch(run, { status: "cancelled", finishedAt: new Date().toISOString() });
      await appendRunSnapshot(workspace, rejected);
      return rejected;
    }
    const running = this.patch(run, { status: "running" });
    await appendRunSnapshot(workspace, running);
    this.active.set(run.id, this.execute(workspace, definition, running, command.comment));
    return running;
  }

  private async infer(workspace: WorkspaceLocation, definition: Awaited<ReturnType<typeof readLoopDefinition>>, run: LoopRun) {
    try {
      const inferring = this.patch(run, { status: "inferring" });
      await appendRunSnapshot(workspace, inferring);
      const inferred = await this.execution.infer(definition, inferring);
      await appendRunSnapshot(workspace, this.patch(inferring, {
        status: "waiting_for_confirmation", sessionId: inferred.sessionId, plan: inferred.plan,
      }));
    } catch (error) {
      await this.fail(workspace, run, error);
    } finally {
      this.active.delete(run.id);
    }
  }

  private async execute(workspace: WorkspaceLocation, definition: Awaited<ReturnType<typeof readLoopDefinition>>, run: LoopRun, comment?: string) {
    try {
      const result = await this.execution.execute(definition, run, comment);
      if (result.gateRequest) {
        await appendRunSnapshot(workspace, this.patch(run, {
          status: "waiting_for_gate", output: result.output, gateRequest: result.gateRequest,
        }));
        return;
      }
      await appendRunSnapshot(workspace, this.patch(run, {
        status: "succeeded", output: result.output, verdict: result.verdict, gateRequest: undefined,
        finishedAt: new Date().toISOString(),
      }));
    } catch (error) {
      await this.fail(workspace, run, error);
    } finally {
      this.active.delete(run.id);
    }
  }

  private async fail(workspace: WorkspaceLocation, run: LoopRun, error: unknown) {
    await appendRunSnapshot(workspace, this.patch(run, {
      status: "failed", error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
    }));
  }

  private patch(run: LoopRun, patch: Partial<LoopRun>): LoopRun {
    return { ...run, ...patch, updatedAt: new Date().toISOString() };
  }
}
