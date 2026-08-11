/** Learn system timer. Runs IN THE LOOP HOST PROCESS (not the web server), as a
 *  sibling of ImporterScheduler / ExporterScheduler — a non-Loop scheduled task
 *  (decision D1). It is the CALLER of the pure aggregate() core: it reads the
 *  dev Loop's LEARN.jsonl, recomputes the derived calibration/sensitive state,
 *  and overwrites STATE.md's managed derived block.
 *
 *  This is how evolution happens with ZERO engine changes: the orchestrator only
 *  writes qualitative LEARN records during its round; this timer does the
 *  counting (never an LLM — design §7.4 core A). The next round's orient reads
 *  the updated STATE => round N+1 behaves differently (design §12.3). */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverWorkspaces, getWorkspace } from "../../workspaces/service.ts";
import { aggregate, parseLearnRecords } from "./aggregate.ts";
import { mergeStateFile } from "./state.ts";
import { DEV_LOOP_ID } from "../dev-loop/contract.ts";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — evolution need not be instant

export class LearnScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error) => this.log(`[learn] scheduler tick failed: ${error}`));
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.log(`[learn] scheduler started (every ${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const workspaces = (await discoverWorkspaces()).filter(
        (ws) => ws.available && ws.capabilities.includes("loop"),
      );
      for (const ws of workspaces) {
        try {
          await this.runOnce(ws.id);
        } catch (error) {
          this.log(`[learn] ${ws.name} aggregate failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Recompute the derived block for one workspace's dev Loop. Entry point for
   *  the web manual route (forwarded from the host). Returns null when the
   *  workspace has no dev Loop. */
  async runOnce(workspaceId: string): Promise<{ modules: number; sensitiveAuto: number; computedAt: string } | null> {
    const { path: workspacePath, manifest } = await getWorkspace(workspaceId);
    const loopDir = join(workspacePath, "loops", DEV_LOOP_ID);
    let learnContent = "";
    try {
      learnContent = await readFile(join(loopDir, "LEARN.jsonl"), "utf8");
    } catch {
      return null; // no dev-loop for this workspace
    }
    const records = parseLearnRecords(learnContent);
    const derived = aggregate(records);
    const statePath = join(loopDir, "STATE.md");
    const stateMd = await readFile(statePath, "utf8").catch(() => "");
    const merged = mergeStateFile(stateMd, derived);
    if (merged !== stateMd) {
      await writeFile(statePath, merged, "utf8");
    }
    this.log(
      `[learn] ${manifest.name}: ${records.length} records -> ${derived.modules.length} modules, ${derived.sensitiveAuto.length} auto-sensitive`,
    );
    return {
      modules: derived.modules.length,
      sensitiveAuto: derived.sensitiveAuto.length,
      computedAt: derived.computedAt,
    };
  }
}
