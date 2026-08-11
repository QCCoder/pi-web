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

export interface Exporter {
  /** Adapter identifier, e.g. "feishu". */
  readonly kind: string;
  /** React to one Work Item event. Must never throw in a way that stops sibling
   *  Exporters — swallow per-event errors and surface them via the return value. */
  onWorkItemEvent(context: ExporterContext, event: WorkItemEventPayload, item: WorkItemRecord): Promise<void>;
}

/** Result of dispatching events across all registered Exporters for one workspace. */
export interface DispatchSummary {
  workspaceId: string;
  /** Id of the last event seen this run (strictly-increasing ULID); persisted as
   *  the watermark so the next run resumes after it. */
  lastEventId: string | null;
  /** Number of events handed to at least one Exporter. */
  dispatched: number;
  /** Per-Exporter error counts (an Exporter failing on one event does not stop others). */
  errors: Record<string, number>;
}
