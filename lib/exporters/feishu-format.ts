/** Feishu-specific card rendering for the Feishu Exporter (design §6). The
 *  channel-agnostic decision (`shouldNotify`) and Markdown body
 *  (`renderNotifyBody`) live in `notify-rules.ts`; this module only wraps that
 *  body into a Feishu interactive-card shape (title + colored header template).
 *  "Deterministic, no LLM" (design §6). */

import type { WorkItemRecord } from "../work-items/types.ts";
import { NotifyReason, renderNotifyBody } from "./notify-rules.ts";

// Re-exported so existing import sites keep working; the canonical home is
// notify-rules.ts now.
export { shouldNotify } from "./notify-rules.ts";
export type { NotifyReason } from "./notify-rules.ts";

/** Feishu card header templates (colors) mapped to a notify reason. */
export const REASON_TEMPLATE: Record<NotifyReason, string> = {
  "review-ready": "blue",
  complete: "green",
  blocked: "red",
};

/** Render a Feishu interactive-card body for one notify reason. Pure — produces
 *  the object shape FeishuClient.sendCard expects. */
export function formatPhaseChangeCard(
  item: WorkItemRecord,
  reason: NotifyReason,
): { title: string; markdown: string; template: string } {
  return {
    title: `研发 Loop · ${item.key}`,
    markdown: renderNotifyBody(reason, item),
    template: REASON_TEMPLATE[reason],
  };
}
