import { cronMatches } from "../daemon/cron.ts";
import type { LoopRuntime, WorkspaceResolver } from "./types.ts";

export { cronMatches };

const TICK_MS = 30_000;

/** Timer ownership lives here, in the independent Host—not in a Pi extension. */
export class LoopHostScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly emittedSlots = new Set<string>();

  constructor(private readonly runtime: LoopRuntime, private readonly workspaces: WorkspaceResolver) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error) => console.error("[loop] scheduler tick failed:", error));
    tick();
    this.timer = setInterval(tick, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()): Promise<void> {
    const minute = now.toISOString().slice(0, 16);
    for (const workspace of await this.workspaces.list()) {
      for (const loop of await this.runtime.listLoops(workspace.id)) {
        if (!loop.enabled) continue;
        for (const trigger of loop.triggers) {
          if (trigger.type !== "cron" || !trigger.enabled) continue;
          let matches = false;
          try {
            matches = cronMatches(trigger.expression, trigger.timezone, now);
          } catch (error) {
            console.error(`[loop] invalid cron trigger ${workspace.id}/${loop.id}/${trigger.id}:`, error);
          }
          if (!matches) continue;
          const eventId = `cron:${trigger.id}:${minute}`;
          const slot = `${workspace.id}:${loop.id}:${eventId}`;
          if (this.emittedSlots.has(slot)) continue;
          this.emittedSlots.add(slot);
          await this.runtime.trigger({ workspaceId: workspace.id, loopId: loop.id, source: "cron", eventId })
            .catch((error) => console.error(`[loop] cron trigger failed for ${workspace.id}/${loop.id}:`, error));
        }
      }
    }
    if (this.emittedSlots.size > 10_000) this.emittedSlots.clear();
  }
}
