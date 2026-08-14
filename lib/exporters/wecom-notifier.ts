/** WeComNotifier — the second Exporter (企业微信群机器人 webhook). Mirrors
 *  FeishuNotifier: same shared `shouldNotify` decision and `renderNotifyBody`
 *  Markdown, just delivered through the WeCom group-bot webhook instead of a
 *  Feishu card. Deterministic, no LLM (design §6).
 *
 *  The webhook URL lives in the unified notify config (lib/notify/config.ts); the
 *  notifier reads it on every event and self-skips (returns `skipped`) when WeCom
 *  is disabled or has no webhook — so failover moves on to the next channel and a
 *  workspace with no WeCom configured behaves exactly as before. */

import { readNotifyConfig } from "../notify/config.ts";
import type { NotifyConfig } from "../notify/config.ts";
import { renderNotifyBody, shouldNotify } from "./notify-rules.ts";
import type { Exporter, ExporterContext, ExporterOutcome, WorkItemEventPayload } from "./types.ts";
import type { WorkItemRecord } from "../work-items/types.ts";
import { WeComClient } from "../wecom/client.ts";
import type { WeComSendResult } from "../wecom/types.ts";

/** Minimal structural type the notifier needs from a WeCom client, so tests can
 *  inject a fake without depending on the concrete class. */
export interface WeComLikeClient {
  sendMarkdown: (content: string) => Promise<WeComSendResult>;
}

export class WeComNotifier implements Exporter {
  readonly kind = "wecom";

  constructor(
    private readonly log: (message: string) => void = () => {},
    private readonly clientFactory: (webhook: string) => WeComLikeClient = (webhook) => new WeComClient(webhook),
    private readonly configReader: (workspaceId: string) => Promise<NotifyConfig> = readNotifyConfig,
  ) {}

  async onWorkItemEvent(context: ExporterContext, event: WorkItemEventPayload, item: WorkItemRecord): Promise<ExporterOutcome> {
    const reason = shouldNotify(event, item);
    if (!reason) return { delivered: false, skipped: true };

    const config = await this.configReader(context.workspaceId);
    const wecom = config.channels.find((c) => c.kind === "wecom");
    if (!wecom?.enabled || !wecom.webhook) {
      this.log(`[exporter:wecom] ${item.key} ${reason}: wecom disabled or no webhook, skipping`);
      return { delivered: false, skipped: true };
    }
    const client = this.clientFactory(wecom.webhook);
    const result = await client.sendMarkdown(renderNotifyBody(reason, item));
    if (!result.ok) {
      this.log(`[exporter:wecom] ${item.key} ${reason}: send failed: ${result.error ?? "unknown"}`);
      return { delivered: false, error: result.error ?? "wecom send failed" };
    }
    this.log(`[exporter:wecom] ${item.key} ${reason}: notified`);
    return { delivered: true };
  }
}
