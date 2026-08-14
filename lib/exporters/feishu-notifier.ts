/** FeishuNotifier — the first Exporter (design §6). Turns Work Item phase/status
 *  transitions into Feishu interactive cards. Deterministic, no LLM (design §6).
 *
 *  Reads the workspace's Feishu credentials (lib/feishu/config.ts) on every event
 *  and degrades silently when they are absent (e.g. cxin has no Feishu app yet):
 *  it returns `skipped`, which the dispatcher treats as "nothing to retry here".
 *  A send failure returns `delivered:false, error` so failover can fall back to
 *  the next channel and the watermark can retry on the next tick. */

import { FeishuClient } from "../feishu/client.ts";
import { readFeishuConfig } from "../feishu/config.ts";
import { formatPhaseChangeCard } from "./feishu-format.ts";
import { shouldNotify } from "./notify-rules.ts";
import type { Exporter, ExporterContext, ExporterOutcome, WorkItemEventPayload } from "./types.ts";
import type { WorkItemRecord } from "../work-items/types.ts";

export class FeishuNotifier implements Exporter {
  readonly kind = "feishu";

  constructor(
    private readonly log: (message: string) => void = () => {},
    private readonly clientFactory: (config: {
      appId: string;
      appSecret: string;
      receiveIdType: "open_id" | "user_id" | "chat_id" | "email";
      receiveId: string;
    }) => FeishuClient = (config) => new FeishuClient(config),
  ) {}

  async onWorkItemEvent(context: ExporterContext, event: WorkItemEventPayload, item: WorkItemRecord): Promise<ExporterOutcome> {
    const reason = shouldNotify(event, item);
    if (!reason) return { delivered: false, skipped: true }; // only review-ready / complete / blocked notify (§15)

    const config = await readFeishuConfig(context.workspaceId);
    if (!config || !config.receiveId) {
      // No Feishu app configured (cxin today). Skip — the event may still be
      // delivered by another channel (failover), or advanced past if all skip.
      this.log(`[exporter:feishu] ${item.key} ${reason}: no feishu config, skipping`);
      return { delivered: false, skipped: true };
    }
    const card = formatPhaseChangeCard(item, reason);
    const client = this.clientFactory(config);
    const result = await client.sendCard(config.receiveId, card);
    if (!result.ok) {
      this.log(`[exporter:feishu] ${item.key} ${reason}: send failed: ${result.error ?? "unknown"}`);
      return { delivered: false, error: result.error ?? "feishu send failed" };
    }
    this.log(`[exporter:feishu] ${item.key} ${reason}: notified (${result.messageId ?? "no id"})`);
    return { delivered: true };
  }
}
