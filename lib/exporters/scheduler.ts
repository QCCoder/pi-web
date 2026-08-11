/** Exporter system timer. Runs IN THE LOOP HOST PROCESS (not the web server),
 *  as a sibling to ImporterScheduler / LearnScheduler — a non-Loop scheduled I/O
 *  task (design §6). Per design "the dev Loop never calls a channel directly;
 *  notifications are 100% event-driven": this timer is what turns Work Item
 *  events into Exporter calls.
 *
 *  Every tick, lists workspaces that have the `work-items` capability, reads their
 *  Work Item event timelines, and dispatches new events (since the persisted
 *  watermark) to the registered Exporters (FeishuNotifier today). Per-workspace
 *  errors are swallowed so one workspace never stops the others. */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { discoverWorkspaces, getWorkspace } from "../workspaces/service.ts";
import { FeishuNotifier } from "./feishu-notifier.ts";
import { dispatchWorkspaceEvents, readWorkspaceWorkItemEvents } from "./dispatcher.ts";
import type { Exporter } from "./types.ts";

const DEFAULT_INTERVAL_MS = 60 * 1000; // 1 minute — notifications need not be sub-second

function watermarkPath(workspacePath: string): string {
  return join(workspacePath, ".pi", "cache", "exporter-watermark.json");
}

async function readWatermark(workspacePath: string): Promise<string | null> {
  try {
    const raw = await readFile(watermarkPath(workspacePath), "utf8");
    const value = JSON.parse(raw) as { lastEventId?: string };
    return typeof value.lastEventId === "string" && value.lastEventId ? value.lastEventId : null;
  } catch {
    return null;
  }
}

async function writeWatermark(workspacePath: string, lastEventId: string | null): Promise<void> {
  if (!lastEventId) return;
  const path = watermarkPath(workspacePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ lastEventId }, null, 2), "utf8");
}

/** Build the Exporter set for one workspace. FeishuNotifier self-skips when no
 *  Feishu app is configured, so it is always registered; future Exporters hook in here. */
function exportersFor(log: (m: string) => void): Exporter[] {
  return [new FeishuNotifier(log)];
}

export class ExporterScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error) => this.log(`[exporter] scheduler tick failed: ${error}`));
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.log(`[exporter] scheduler started (every ${Math.round(this.intervalMs / 1000)}s)`);
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
        (ws) => ws.available && ws.capabilities.includes("work-items"),
      );
      for (const ws of workspaces) {
        try {
          await this.runOnce(ws.id);
        } catch (error) {
          this.log(`[exporter] ${ws.name} dispatch failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Dispatch new events for one workspace and persist the watermark. Also the
   *  entry point the web manual route uses (forwarded from the host). */
  async runOnce(workspaceId: string) {
    const { path: workspacePath, manifest } = await getWorkspace(workspaceId);
    const name = manifest.name;
    const snapshots = await readWorkspaceWorkItemEvents(workspacePath);
    const since = await readWatermark(workspacePath);
    const summary = await dispatchWorkspaceEvents(
      { workspaceId },
      exportersFor(this.log),
      snapshots,
      since,
    );
    await writeWatermark(workspacePath, summary.lastEventId);
    if (summary.dispatched > 0 || Object.keys(summary.errors).length > 0) {
      this.log(`[exporter] ${name}: dispatched ${summary.dispatched} events${Object.keys(summary.errors).length > 0 ? ` (errors: ${JSON.stringify(summary.errors)})` : ""}`);
    }
    return summary;
  }
}
