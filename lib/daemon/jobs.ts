/** Daemon background-job registry.
 *
 *  A DaemonJob is any long-lived background task the daemon process hosts on
 *  behalf of a domain (loop trigger cron, importer sync, future exporters /
 *  webhooks / cleanups). The daemon core knows ONLY this interface — it never
 *  imports domain logic, and domains never touch the daemon's server
 *  lifecycle. Registration is static composition (compile-time): no runtime
 *  discovery, no plugin loading — a bad job must fail at startup/tests, not
 *  take the session-owning daemon down at 3am.
 *
 *  Deliberately minimal (rule of three not yet met): no cron DSL, no
 *  persistence, no run history. When a 4th/5th job arrives with real needs,
 *  grow this — not the call sites. */
export interface DaemonJob {
  /** Stable identifier used in logs and shutdown messages. */
  id: string;
  start(): void;
  stop(): void;
}

export class DaemonJobRegistry {
  private readonly jobs: DaemonJob[] = [];

  register(job: DaemonJob): void {
    this.jobs.push(job);
  }

  startAll(): void {
    for (const job of this.jobs) {
      try {
        job.start();
      } catch (error) {
        console.error(`[pi-daemon] job ${job.id} failed to start:`, error);
      }
    }
  }

  stopAll(): void {
    for (const job of this.jobs) {
      try {
        job.stop();
      } catch (error) {
        console.error(`[pi-daemon] job ${job.id} failed to stop:`, error);
      }
    }
  }

  list(): readonly DaemonJob[] {
    return this.jobs;
  }
}
