/** Pure formatting helpers for the Feishu Exporter (design §6). Splitting the
 *  rendering from the Feishu I/O keeps it trivially testable and lets a future
 *  card redesign change one pure function. "Deterministic, no LLM" (design §6). */

import type { WorkItemRecord } from "../work-items/types.ts";
import type { WorkItemEventPayload } from "./types.ts";

/** The dev-loop Work Item phases/states that warrant a human notification
 *  (design §7.3 / §12.2). Everything else is silent to avoid PR noise (§15). */
export type NotifyReason =
  | "review-ready" // phase -> verification (branch pushed, awaiting gate2)
  | "complete" // phase -> complete (merged)
  | "blocked"; // status -> blocked (checker red / rejected / parked)

/** Feishu card templates mapped to a notify reason. */
export const REASON_TEMPLATE: Record<NotifyReason, string> = {
  "review-ready": "blue",
  complete: "green",
  blocked: "red",
};

/** Decide whether an event should notify, and why. Only phase transitions into
 *  the review/complete states, or a status transition into `blocked`, qualify.
 *  Returns null for everything else (so non-relevant events stay silent). */
export function shouldNotify(
  event: WorkItemEventPayload,
  item: WorkItemRecord,
): NotifyReason | null {
  if (event.type !== "work_item.updated") return null;
  const changes = event.data?.changes;
  if (!changes || typeof changes !== "object") return null;
  const phaseChange = (changes as Record<string, unknown>).phase as
    | { from?: unknown; to?: unknown }
    | undefined;
  if (phaseChange && phaseChange.to === "verification") return "review-ready";
  if (phaseChange && phaseChange.to === "complete") return "complete";
  const statusChange = (changes as Record<string, unknown>).status as
    | { from?: unknown; to?: unknown }
    | undefined;
  if (statusChange && statusChange.to === "blocked") return "blocked";
  // If the event itself marks the item blocked/complete (e.g. a milestone the
  // Loop appended without a revision-bumping update), fall back to current state.
  if (!phaseChange && !statusChange) {
    if (item.status === "blocked") return "blocked";
    if (item.phase === "complete") return "complete";
  }
  return null;
}

/** Render a Feishu interactive-card body for one notify reason. Pure — produces
 *  the object shape FeishuClient.sendCard expects. */
export function formatPhaseChangeCard(
  item: WorkItemRecord,
  reason: NotifyReason,
): { title: string; markdown: string; template: string } {
  const key = item.key;
  const title = item.title;
  const template = REASON_TEMPLATE[reason];
  const lines: string[] = [];
  if (reason === "review-ready") {
    lines.push(`**${key} 已就绪评审**`);
    lines.push("");
    lines.push(`研发 Loop 已完成实现并通过 checker，分支已推送，等待人工评审合并。`);
  } else if (reason === "complete") {
    lines.push(`**${key} 已完成**`);
    lines.push("");
    lines.push(`人工已合并，工作项进入完成态。`);
  } else {
    lines.push(`**${key} 受阻**`);
    lines.push("");
    lines.push(`研发 Loop 本轮受阻（checker 失败 / 被打回 / 超时泊车），需人工介入。`);
  }
  lines.push("");
  lines.push(`- 标题：${title}`);
  lines.push(`- 类型：${item.type === "bug" ? "Bug" : "需求"}`);
  lines.push(`- 优先级：${item.priority}`);
  lines.push(`- 仓库：${item.repositories.length > 0 ? item.repositories.join(", ") : "（未声明）"}`);
  if (item.external) {
    lines.push(`- 来源：${item.external.source}#${item.external.sourceId}`);
  }
  return { title: `研发 Loop · ${key}`, markdown: lines.join("\n"), template };
}
