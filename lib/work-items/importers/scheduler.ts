/** Importer system job (DaemonJob). Registered into the daemon's job
 *  registry (lib/daemon/jobs.ts) — the daemon core knows only the interface,
 *  this module owns all importer logic. Per design §5 the runner is "a
 *  non-Loop scheduled I/O task": cron/webhook/manual wake it; the web server
 *  holds no timers (instrumentation.ts is untouched).
 *
 *  Every tick, lists workspaces that (a) have the `requirement-sources`
 *  capability and (b) have importer credentials configured, and runs one import
 *  sync per workspace. Errors are swallowed and logged so one failing workspace
 *  never stops the others. */
import type { DaemonJob } from "../../daemon/jobs.ts";
import { discoverWorkspaces } from "../../workspaces/service.ts";
import { readImporterConfig } from "./config.ts";
import { syncImporterForWorkspace } from "./runner.ts";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export class ImporterScheduler implements DaemonJob {
  readonly id = "importer-sync";

  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error) => this.log(`[importer] scheduler tick failed: ${error}`));
    this.timer = setInterval(tick, this.intervalMs);
    // Don't keep the process alive on this timer alone (the host keeps itself up).
    if (this.timer.unref) this.timer.unref();
    this.log(`[importer] scheduler started (every ${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return; // never overlap runs
    this.running = true;
    try {
      const workspaces = (await discoverWorkspaces()).filter(
        (ws) => ws.available && ws.capabilities.includes("requirement-sources"),
      );
      for (const ws of workspaces) {
        const config = await readImporterConfig(ws.id);
        if (!config) continue;
        try {
          const summary = await syncImporterForWorkspace(ws.id);
          this.log(
            `[importer] ${ws.name}: +${summary.created} created, ${summary.synced} synced, ${summary.skipped} skipped, ${summary.errors} errors`,
          );
        } catch (error) {
          this.log(`[importer] ${ws.name} sync failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
