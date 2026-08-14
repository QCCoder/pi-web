/** Exporter SPI (design §6). An Exporter is an *outbound* adapter that reacts to
 *  Work Item lifecycle events. The dev Loop is channel-blind: it only writes Work
 *  Item phase/event changes; an Exporter subscribes to the Work Item's append-only
 *  `events.jsonl` and turns those events into notifications / writebacks.
 *
 *  The SPI is a deep-module seam (mirrors the Importer SPI in lib/importers/types.ts):
 *  `onWorkItemEvent` hides "Work Item event -> any third-party channel" behind one
 *  method. Feishu is the first implementation (FeishuNotifier); a future
 *  ChandaoWriteback / EmailNotifier implement the same interface. The dispatcher
 *  (lib/exporters/dispatcher.ts) depends only on this interface, never on Feishu.
 *
 *  Design invariant: the dev Loop NEVER calls a channel directly — notifications
 *  are 100% event-driven (§6 "触发即消息"). */

import type { WorkItemRecord } from "../work-items/types.ts";

/** A single Work Item event (mirrors the append-only events.jsonl line shape;
 *  see lib/work-items/service.ts `appendEvent`). */
export interface WorkItemEventPayload {
  id: string;
  at: string;
  type: string;
  actor: string;
  conversationId?: string;
  data?: Record<string, unknown>;
}

/** Context passed to an Exporter so it can resolve credentials / targets without
 *  the dispatcher knowing about any specific channel. */
export interface ExporterContext {
  workspaceId: string;
}

/** What one Exporter did with a single event. The dispatcher uses this to decide
 *  delivery semantics: in `failover` mode it stops at the first `delivered`
 *  channel; the watermark advances when *something* delivered or *everything*
 *  intentionally skipped, so a channel outage can be retried without stalling and
 *  without double-sending (see dispatcher.ts). */
export interface ExporterOutcome {
  /** true iff the channel actually pushed a notification for this event. */
  delivered: boolean;
  /** true iff the channel intentionally did nothing — the event was not
   *  notifiable, or the channel is not configured. Distinct from a failure: an
   *  event every channel `skipped` is advanced past (it is simply not actionable). */
  skipped?: boolean;
  /** present iff the channel tried and failed (send error, bad creds at send
   *  time, ...). The dispatcher counts these and may retry on the next tick. */
  error?: string;
}

export interface Exporter {
  /** Adapter identifier, e.g. "feishu". */
  readonly kind: string;
  /** React to one Work Item event. Return the outcome so the dispatcher can drive
   *  failover / watermark correctly. An unexpected throw is still tolerated by the
   *  dispatcher (treated as a non-delivered error) and must never stop sibling
   *  Exporters. */
  onWorkItemEvent(context: ExporterContext, event: WorkItemEventPayload, item: WorkItemRecord): Promise<ExporterOutcome>;
}

/** How the dispatcher fans events out across exporters. `all` (fan-out, the
 *  original behavior) hands every event to every exporter. `failover` tries the
 *  exporters in the given (priority) order and stops at the first one that
 *  delivers — so a backup channel only fires when the higher-priority one does
 *  not deliver, avoiding duplicate pings. Structurally identical to
 *  lib/notify/config.ts `NotifyMode`; the scheduler maps one to the other. */
export type DispatchMode = "all" | "failover";

/** Result of dispatching events across all registered Exporters for one workspace. */
export interface DispatchSummary {
  workspaceId: string;
  /** Id of the last event the dispatcher advanced past this run. Persisted as the
   *  watermark so the next run resumes strictly after it. Events are only advanced
   *  past when they are *settled* (delivered by some channel, or intentionally
   *  skipped by all); a held-for-retry event head-of-line-blocks the watermark so
   *  it is retried next tick without being lost and without re-sending anything
   *  that already went out. */
  lastEventId: string | null;
  /** Events where at least one channel delivered a notification. */
  delivered: number;
  /** Events every channel intentionally skipped (not actionable / unconfigured).
   *  These are advanced past — they are not failures. */
  skipped: number;
  /** Events held for retry: some channel errored, nothing delivered, not all
   *  skipped. The watermark stops here; the event (and later ones) retry next tick. */
  retried: number;
  /** Per-Exporter error counts (an Exporter failing on one event does not stop others). */
  errors: Record<string, number>;
}
