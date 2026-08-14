/** Exporter system timer. Runs IN THE LOOP HOST PROCESS (not the web server),
 *  as a sibling to ImporterScheduler — a non-Loop scheduled I/O
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
import { orderedEnabledChannels, readNotifyConfig } from "../notify/config.ts";
import type { NotifyChannelKind, NotifyConfig } from "../notify/config.ts";
import { FeishuNotifier } from "./feishu-notifier.ts";
import { WeComNotifier } from "./wecom-notifier.ts";
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

/** Build the ordered Exporter set for one workspace from its notify config.
 *  `orderedEnabledChannels` already sorts enabled channels by priority, so the
 *  returned array is in failover-try order. Each Notifier self-skips when its own
 *  credentials are missing, so a channel can be enabled here yet still no-op. */
function buildExporters(config: NotifyConfig, log: (m: string) => void): Exporter[] {
  const factories: Record<NotifyChannelKind, () => Exporter> = {
    feishu: () => new FeishuNotifier(log),
    wecom: () => new WeComNotifier(log),
  };
  return orderedEnabledChannels(config).map((ch) => factories[ch.kind]());
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
    const notifyConfig = await readNotifyConfig(manifest.id);
    const exporters = buildExporters(notifyConfig, this.log);
    const snapshots = await readWorkspaceWorkItemEvents(workspacePath);
    const since = await readWatermark(workspacePath);
    const summary = await dispatchWorkspaceEvents(
      { workspaceId: manifest.id },
      exporters,
      snapshots,
      since,
      notifyConfig.mode,
    );
    await writeWatermark(workspacePath, summary.lastEventId);
    if (summary.delivered > 0 || summary.retried > 0 || Object.keys(summary.errors).length > 0) {
      const parts = [`delivered ${summary.delivered}`];
      if (summary.skipped > 0) parts.push(`skipped ${summary.skipped}`);
      if (summary.retried > 0) parts.push(`held ${summary.retried} for retry`);
      if (Object.keys(summary.errors).length > 0) parts.push(`errors ${JSON.stringify(summary.errors)}`);
      this.log(`[exporter] ${name}: ${parts.join(", ")}`);
    }
    return summary;
  }
}
