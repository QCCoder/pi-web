/** UI-safe display labels for external-source provenance on work items
 *  (the `external.source` field). Kept in a dedicated module with ZERO
 *  imports so client components (WorkspaceManager) can use it without
 *  pulling node-only code into the browser bundle. Source adapters now
 *  live in workspace scripts (e.g. cxin scripts/chandao-sync.py); this map
 *  stays so provenance keeps rendering regardless of writer. */
export const SOURCE_LABELS: Record<string, string> = {
  chandao: "禅道",
};

/** Human label for an external source id; falls back to the raw id so an
 *  unknown future source still renders. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
