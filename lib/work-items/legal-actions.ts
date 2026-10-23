import type { DeliveryAction } from "./delivery-types";
import type { WorkItemPhase, WorkItemRecord } from "./types";

/** Client-safe legal-action planning (M2 T9). `legalDeliveryActions` moved
 *  here from delivery.ts — the detail-page action bar (a client component)
 *  must not import delivery.ts (it pulls node:fs / the workspace service into
 *  the browser bundle); this module keeps TYPE-ONLY imports so it is safe on
 *  both sides. delivery.ts re-exports it so server consumers and tests are
 *  unchanged. */

/** Legal actions for the detail page action bar (spec §7.2). Unmanaged and
 *  cancelled items expose none. */
export function legalDeliveryActions(item: WorkItemRecord): DeliveryAction[] {
  if (item.delivery?.protocolVersion !== 1) return [];
  if (item.status === "cancelled") return [];
  if (item.status === "blocked") return ["unblock", "cancel"];
  const phaseActions: Partial<Record<WorkItemPhase, DeliveryAction[]>> = {
    intake: ["start-design"],
    design: ["confirm-design"],
    ready_for_implementation: ["start-development", "rework"],
    implementation: ["submit-verification", "rework"],
    verification: ["record-verification", "rework"],
    release_ready: ["prepare-release", "record-release", "rework"],
    // released: frozen baseline — only display actions below stay legal
  };
  return [...(phaseActions[item.phase] ?? []), "block", "cancel"];
}

/** Action-bar projection: legalDeliveryActions EXCEPT cancel on a released
 *  baseline (T2 review CARRIED RULING) — legalDeliveryActions returns
 *  block+cancel there via the freeze exemption, but cancel-on-released
 *  produces a released+cancelled chimera state, so the bar drops cancel and
 *  keeps block/unblock as display flags. */
export function legalActionBarActions(item: WorkItemRecord): DeliveryAction[] {
  if (item.phase === "released") {
    return legalDeliveryActions(item).filter((action) => action !== "cancel");
  }
  return legalDeliveryActions(item);
}
