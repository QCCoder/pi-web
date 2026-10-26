import type { DeliveryAction } from "./delivery-types";
import type { WorkItemPhase, WorkItemRecord } from "./types";

/** Client-safe legal-action planning (M2 T9). `legalDeliveryActions` moved
 *  here from delivery.ts — the detail-page action bar (a client component)
 *  must not import delivery.ts (it pulls node:fs / the workspace service into
 *  the browser bundle); this module keeps TYPE-ONLY imports so it is safe on
 *  both sides. delivery.ts re-exports it so server consumers and tests are
 *  unchanged. */

/** 任一澄清条目未答（answer 缺席）——ask-a-human（final-arch step-2）的持久
 *  产物在等人工答复；判定只看 answer 在场与否，历史已答条目不拦（与池谓词
 *  awaiting-answer 的共用检查同一口径，pool.ts sharedReasons）。 */
function hasUnansweredClarification(item: WorkItemRecord): boolean {
  return item.delivery?.clarifications?.some((entry) => entry.answer === undefined) ?? false;
}

/** Legal actions for the detail page action bar (spec §7.2). Unmanaged and
 *  cancelled items expose none. */
export function legalDeliveryActions(item: WorkItemRecord): DeliveryAction[] {
  if (item.delivery?.protocolVersion !== 1) return [];
  if (item.status === "cancelled") return [];
  // answer-clarification（final-arch step-2 T4）：有未答条目即可答——blocked
  // 也合法（人可能先 block 了项再答复；答复本身永不解阻，不会悄悄把状态拉回
  // in_progress）；released 基线冻结排除（与流转侧 RELEASED_ALLOWED_ACTIONS
  // 不含它同一裁定）。
  const answerAction: DeliveryAction[] =
    item.phase !== "released" && hasUnansweredClarification(item) ? ["answer-clarification"] : [];
  if (item.status === "blocked") return ["unblock", "cancel", ...answerAction];
  const phaseActions: Partial<Record<WorkItemPhase, DeliveryAction[]>> = {
    intake: ["start-design"],
    design: ["confirm-design"],
    ready_for_implementation: ["start-development", "rework"],
    implementation: ["submit-verification", "rework"],
    verification: ["record-verification", "rework"],
    release_ready: ["prepare-release", "record-release", "rework"],
    // released: frozen baseline — only display actions below stay legal
  };
  return [...(phaseActions[item.phase] ?? []), "block", "cancel", ...answerAction];
}

/** Action-bar projection: legalDeliveryActions EXCEPT cancel on a released
 *  baseline (T2 review CARRIED RULING) — legalDeliveryActions returns
 *  block+cancel there via the freeze exemption, but cancel-on-released
 *  produces a released+cancelled chimera state, so the bar drops cancel and
 *  keeps block/unblock as display flags. answer-clarification（final-arch
 *  step-2 T4）也永不进动作条——答复由详情页的专属面板触发（问题全文在动作条
 *  无处展示），把它从任何投影里滤掉。 */
export function legalActionBarActions(item: WorkItemRecord): DeliveryAction[] {
  const bar = legalDeliveryActions(item).filter((action) => action !== "answer-clarification");
  if (item.phase === "released") {
    return bar.filter((action) => action !== "cancel");
  }
  return bar;
}
