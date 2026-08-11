/** FeishuNotifier — the first Exporter (design §6). Turns Work Item phase/status
 *  transitions into Feishu interactive cards. Deterministic, no LLM (design §6).
 *
 *  Reads the workspace's Feishu credentials (lib/feishu/config.ts) on every event
 *  and degrades silently when they are absent (e.g. cxin has no Feishu app yet) —
 *  the dispatcher still records progress, the absence just means no card is sent. */

import { FeishuClient } from "../feishu/client.ts";
import { readFeishuConfig } from "../feishu/config.ts";
import { formatPhaseChangeCard, shouldNotify } from "./feishu-format.ts";
import type { Exporter, ExporterContext, WorkItemEventPayload } from "./types.ts";
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

  async onWorkItemEvent(context: ExporterContext, event: WorkItemEventPayload, item: WorkItemRecord): Promise<void> {
    const reason = shouldNotify(event, item);
    if (!reason) return; // silent — only review-ready / complete / blocked notify (§15 noise control)

    const config = await readFeishuConfig(context.workspaceId);
    if (!config || !config.receiveId) {
      // No Feishu app configured (cxin today). Degrade silently; the event is still
      // dispatched and any other Exporter still runs.
      this.log(`[exporter:feishu] ${item.key} ${reason}: no feishu config, skipping`);
      return;
    }
    const card = formatPhaseChangeCard(item, reason);
    const client = this.clientFactory(config);
    const result = await client.sendCard(config.receiveId, card);
    if (!result.ok) {
      this.log(`[exporter:feishu] ${item.key} ${reason}: send failed: ${result.error ?? "unknown"}`);
    } else {
      this.log(`[exporter:feishu] ${item.key} ${reason}: notified (${result.messageId ?? "no id"})`);
    }
  }
}
