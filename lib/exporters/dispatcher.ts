/** Exporter event dispatcher (design §6). The deep-module seam that hides
 *  "scan a workspace's Work Item events.jsonl files -> dedup by event id ->
 *  hand each to every registered Exporter" behind one entry. The ExporterScheduler
 *  (host-side non-Loop timer) and the web manual route both call only
 *  `dispatchWorkspaceEvents`.
 *
 *  Idempotency: events are ULIDs (strictly time-ordered); the dispatcher resumes
 *  strictly after the last-seen event id, so re-running never re-dispatches.
 *  Per-Exporter errors are swallowed and counted so one channel failing never
 *  stops another (and never blocks progress). */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { listWorkItems, parseWorkItem } from "../work-items/service.ts";
import type { WorkItemRecord } from "../work-items/types.ts";
import type {
  DispatchMode,
  DispatchSummary,
  Exporter,
  ExporterContext,
  ExporterOutcome,
  WorkItemEventPayload,
} from "./types.ts";

/** A Work Item plus its append-only event timeline. */
export interface WorkItemWithEvents {
  item: WorkItemRecord;
  events: WorkItemEventPayload[];
}

function parseEvents(content: string): WorkItemEventPayload[] {
  const out: WorkItemEventPayload[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!value || typeof value !== "object") continue;
      const event = value as unknown as WorkItemEventPayload;
      if (typeof event.id === "string" && typeof event.type === "string") out.push(event);
    } catch {
      // append-only log tolerates a partial final line
    }
  }
  return out;
}

/** Read one Work Item's events.jsonl given its key, without re-reading README.
 *  Mirrors the directory layout listWorkItems uses (requirements/ REQ-*, bugs/ BUG-*). */
async function readItemEvents(
  workspacePath: string,
  item: WorkItemRecord,
): Promise<WorkItemEventPayload[]> {
  const root = item.type === "requirement" ? "requirements" : "bugs";
  let entries: string[];
  try {
    entries = await readdir(join(workspacePath, root));
  } catch {
    return [];
  }
  const dirName = entries.find((name) => name === item.key || name.startsWith(`${item.key}-`));
  if (!dirName) return [];
  // Validate the dir still holds this item (defensive against a mid-scan rename).
  try {
    const meta = parseWorkItem(parse(await readFile(join(workspacePath, root, dirName, "item.yaml"), "utf8")));
    if (meta.key !== item.key) return [];
  } catch {
    return [];
  }
  try {
    const content = await readFile(join(workspacePath, root, dirName, "events.jsonl"), "utf8");
    return parseEvents(content);
  } catch {
    return [];
  }
}

/** Read all (item, events) pairs for a workspace. Invalid items are skipped. */
export async function readWorkspaceWorkItemEvents(
  workspacePath: string,
): Promise<WorkItemWithEvents[]> {
  const { items } = await listWorkItems(workspacePath);
  const out: WorkItemWithEvents[] = [];
  for (const item of items) {
    const events = await readItemEvents(workspacePath, item);
    out.push({ item, events });
  }
  return out;
}

/** Pure selection: flatten all events, keep only those strictly after the
 *  watermark id, dedup by event id, sort by id (ULID => chronological). */
export function selectEventsSince(
  snapshots: readonly WorkItemWithEvents[],
  sinceEventId: string | null,
): Array<{ event: WorkItemEventPayload; item: WorkItemRecord }> {
  const seen = new Set<string>();
  const selected: Array<{ event: WorkItemEventPayload; item: WorkItemRecord }> = [];
  for (const { item, events } of snapshots) {
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (sinceEventId !== null && event.id <= sinceEventId) continue;
      selected.push({ event, item });
    }
  }
  selected.sort((a, b) => a.event.id.localeCompare(b.event.id));
  return selected;
}

/** Drive all registered Exporters over new Work Item events for one workspace.
 *
 *  Watermark contract: an event is advanced past only when it is *settled* —
 *  some channel delivered it, or every channel intentionally skipped it. If some
 *  channel errored and nothing delivered (and not all skipped), the event is
 *  *held*: the watermark stops at the previous event (head-of-line block) so the
 *  event retries on the next tick. This never re-sends an already-delivered event
 *  (we stop before it) and never silently drops a notification on a transient
 *  outage. `exporters` must already be ordered by priority for `failover` mode;
 *  the scheduler does that. Inject `snapshots` to test without filesystem I/O. */
export async function dispatchWorkspaceEvents(
  context: ExporterContext,
  exporters: readonly Exporter[],
  snapshots: readonly WorkItemWithEvents[],
  sinceEventId: string | null,
  mode: DispatchMode = "all",
): Promise<DispatchSummary> {
  const errors: Record<string, number> = {};
  const counts = { delivered: 0, skipped: 0, retried: 0 };
  if (exporters.length === 0) {
    // Nothing wired: leave the watermark where it was (a channel added later
    // resumes from the stored watermark; older events were never actionable).
    return { workspaceId: context.workspaceId, lastEventId: sinceEventId, ...counts, errors };
  }
  const selected = selectEventsSince(snapshots, sinceEventId);
  let lastEventId = sinceEventId;
  for (const { event, item } of selected) {
    const settled = await dispatchOneEvent(context, exporters, event, item, mode, errors);
    if (settled.delivered) {
      counts.delivered += 1;
      lastEventId = event.id;
    } else if (settled.allSkipped) {
      counts.skipped += 1;
      lastEventId = event.id;
    } else {
      // Held for retry: stop here so this event (and later ones) retry next tick.
      counts.retried += 1;
      break;
    }
  }
  return { workspaceId: context.workspaceId, lastEventId, ...counts, errors };
}

/** Run one event through the exporters. Returns whether it settled as delivered
 *  or all-skipped; mutates `errors` with per-kind error counts. In `failover`
 *  mode the first delivery short-circuits the remaining (lower-priority) channels. */
async function dispatchOneEvent(
  context: ExporterContext,
  exporters: readonly Exporter[],
  event: WorkItemEventPayload,
  item: WorkItemRecord,
  mode: DispatchMode,
  errors: Record<string, number>,
): Promise<{ delivered: boolean; allSkipped: boolean }> {
  let delivered = false;
  let allSkipped = exporters.length > 0;
  for (const exporter of exporters) {
    let outcome: ExporterOutcome;
    try {
      outcome = await exporter.onWorkItemEvent(context, event, item);
    } catch (error) {
      outcome = { delivered: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.error) {
      errors[exporter.kind] = (errors[exporter.kind] ?? 0) + 1;
    }
    if (outcome.delivered) delivered = true;
    if (!outcome.skipped) allSkipped = false; // delivered or errored => not a skip
    if (mode === "failover" && outcome.delivered) break; // first delivery wins
  }
  return { delivered, allSkipped };
}
