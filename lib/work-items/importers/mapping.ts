/** Pure mapping + dedup helpers for the Importer runner (design §10). No I/O.
 *
 *  - `mapSourceKindToWorkItemType`: Chandao bug → work-item bug (BUG-####),
 *    Chandao task → work-item requirement (REQ-####). No new work-item type is
 *    introduced (design §10: avoid touching the KEY counter / git rules / UI).
 *  - `buildExternalIndex`: builds a `source:sourceId → item` map from existing
 *    work items so the runner can dedup in O(1). */
import type { WorkItemRecord } from "../types.ts";
import type { SourceItemKind } from "./types.ts";

export function mapSourceKindToWorkItemType(kind: SourceItemKind): "bug" | "requirement" {
  return kind === "bug" ? "bug" : "requirement";
}

export function externalKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/** Index work items that carry an external ref, keyed by `source:sourceId`.
 *  Items without an external ref are skipped (manually created). If duplicates
 *  exist (shouldn't, but defensive), the last wins. */
export function buildExternalIndex(
  items: readonly WorkItemRecord[],
): Map<string, WorkItemRecord> {
  const index = new Map<string, WorkItemRecord>();
  for (const item of items) {
    if (!item.external) continue;
    index.set(externalKey(item.external.source, item.external.sourceId), item);
  }
  return index;
}
