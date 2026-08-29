/** UI-safe display labels for importer sources. Kept in a dedicated module
 *  with ZERO imports so client components (WorkspaceManager) can use it
 *  without pulling node-only code (chandao-importer/config use fs) into the
 *  browser bundle. */
export const SOURCE_LABELS: Record<string, string> = {
  chandao: "禅道",
};

/** Human label for an external source id; falls back to the raw id so an
 *  unknown future source still renders. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
