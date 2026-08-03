import { discoverWorkspaces, getWorkspace } from "../workspaces/service.ts";
import { listJobs, listRuns, readJob } from "./store.ts";
import { runLoopJob } from "./runner.ts";
import { isJobDue } from "./schedule.ts";
import type { LoopJob, LoopRun, LoopRunTrigger } from "./types.ts";

const TICK_MS = 60_000;
const LOOP_CAPABILITY = "loop";
const INITIAL_DELAY_MS = 5_000;

declare global {
  var __piLoopScheduler: LoopScheduler | undefined;
}

type JobKey = `${string}:${string}`;

/**
 * In-process Loop scheduler. Runs inside the pi-web server (the single session
 * owner). One singleton lives on globalThis so it survives Next.js hot-reload.
 * Each tick discovers workspaces with the `loop` capability, checks every
 * enabled job for due-ness (with same-day catch-up), and runs the ones that are
 * due. In-flight jobs are de-duplicated so a slow run is never started twice.
 */
class LoopScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Set<JobKey>();
  private booted = false;

  start(): void {
    if (this.booted) return;
    this.booted = true;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error("[loop] tick failed:", error instanceof Error ? error.message : error);
      });
    }, TICK_MS);
    // Don't keep the process alive solely for the scheduler; the HTTP server
    // keeps it alive while running, and unref lets clean shutdown complete.
    this.timer.unref?.();
    const initial = setTimeout(() => {
      void this.tick().catch((error) => {
        console.error("[loop] initial tick failed:", error instanceof Error ? error.message : error);
      });
    }, INITIAL_DELAY_MS);
    initial.unref?.();
    console.log("[loop] scheduler started (60s tick, Asia/Shanghai daily schedules)");
  }

  private async tick(): Promise<void> {
    const now = new Date();
    let summaries;
    try {
      summaries = await discoverWorkspaces();
    } catch (error) {
      console.error("[loop] discoverWorkspaces failed:", error instanceof Error ? error.message : error);
      return;
    }
    for (const summary of summaries) {
      if (!summary.available || !summary.capabilities.includes(LOOP_CAPABILITY)) continue;
      let jobs: LoopJob[];
      try {
        jobs = await listJobs(summary.path);
      } catch (error) {
        console.error(
          `[loop] listJobs failed for ${summary.id}:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      for (const job of jobs) {
        if (!job.enabled) continue;
        const key = `${summary.id}:${job.name}` as JobKey;
        if (this.running.has(key)) continue;
        let lastRunAt: Date | null = null;
        try {
          const runs = await listRuns(summary.path, job.name, 1);
          if (runs.length > 0) {
            const last = new Date(runs[0].startedAt);
            if (!Number.isNaN(last.getTime())) lastRunAt = last;
          }
        } catch {
          // Treat unreadable history as "never run" so catch-up still fires.
        }
        if (!isJobDue(now, job.schedule, lastRunAt)) continue;
        this.running.add(key);
        void this.runOne(summary.id, summary.path, key, job, "schedule");
      }
    }
  }

  private async runOne(
    workspaceId: string,
    workspacePath: string,
    key: JobKey,
    job: LoopJob,
    triggeredBy: LoopRunTrigger,
  ): Promise<void> {
    try {
      const { manifest } = await getWorkspace(workspaceId);
      console.log(`[loop] running job ${workspaceId}/${job.name} (${triggeredBy})`);
      await runLoopJob(workspacePath, manifest, job, triggeredBy);
    } catch (error) {
      console.error(
        `[loop] run failed for ${workspaceId}/${job.name}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.running.delete(key);
    }
  }

  /** Trigger a job immediately (manual run from the UI). */
  async runJobNow(workspaceId: string, jobName: string): Promise<LoopRun> {
    const { path, manifest } = await getWorkspace(workspaceId);
    const job = await readJob(path, jobName);
    return runLoopJob(path, manifest, job, "manual");
  }
}

/** Get the process-wide Loop scheduler singleton. */
export function getLoopScheduler(): LoopScheduler {
  if (!globalThis.__piLoopScheduler) globalThis.__piLoopScheduler = new LoopScheduler();
  return globalThis.__piLoopScheduler;
}

/** Start the scheduler if it isn't already running. Safe to call repeatedly. */
export function ensureLoopSchedulerStarted(): void {
  getLoopScheduler().start();
}
