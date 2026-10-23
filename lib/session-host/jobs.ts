/** Host background-job registry.
 *
 *  A HostJob is any long-lived background task the host process runs on
 *  behalf of a domain (loop trigger cron, future exporters /
 *  webhooks / cleanups). The host core knows ONLY this interface — it never
 *  imports domain logic, and domains never touch the host's server
 *  lifecycle. Registration is static composition (compile-time): no runtime
 *  discovery, no plugin loading — a bad job must fail at startup/tests, not
 *  take the session-owning host down at 3am.
 *
 *  Deliberately minimal (rule of three not yet met): no cron DSL, no
 *  persistence, no run history. When a 4th/5th job arrives with real needs,
 *  grow this — not the call sites. */
export interface HostJob {
  /** Stable identifier used in logs and shutdown messages. */
  id: string;
  start(): void;
  stop(): void;
}

export class HostJobRegistry {
  private readonly jobs: HostJob[] = [];

  register(job: HostJob): void {
    this.jobs.push(job);
  }

  startAll(): void {
    for (const job of this.jobs) {
      try {
        job.start();
      } catch (error) {
        console.error(`[pi-host] job ${job.id} failed to start:`, error);
      }
    }
  }

  stopAll(): void {
    for (const job of this.jobs) {
      try {
        job.stop();
      } catch (error) {
        console.error(`[pi-host] job ${job.id} failed to stop:`, error);
      }
    }
  }

  list(): readonly HostJob[] {
    return this.jobs;
  }
}
