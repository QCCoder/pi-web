/**
 * Deep-link URL protocol for the central WorkItemsPage (M2 T8, spec §6.1):
 * `?workspace=<id>&page=work-items[&item=<key>]`. Deliberately a SEPARATE
 * syntax from the chat tab projection (`view=chat/overview`) — the page is a
 * CenterPage, not a session tab, and must be recognized BEFORE
 * `applyUrlToTabs` runs its tab projection so a chat-tab URL effect can never
 * override the management deep link. Build and parse share this one module;
 * the round-trip is covered by tests.
 */

export function buildWorkItemsPageUrl(workspaceId: string, itemKey?: string): string {
  const params = new URLSearchParams();
  params.set("workspace", workspaceId);
  params.set("page", "work-items");
  if (itemKey) params.set("item", itemKey);
  return `?${params.toString()}`;
}

/** `params.get("page") === "work-items"` → `{ workspaceId, itemKey? }`;
 * anything else (including the legacy `view=` syntax and a page URL missing
 * its workspace) → null so the caller falls through to normal handling. */
export function parseWorkItemsPageParams(
  params: URLSearchParams,
): { workspaceId: string; itemKey?: string } | null {
  if (params.get("page") !== "work-items") return null;
  const workspaceId = params.get("workspace");
  if (!workspaceId) return null;
  const itemKey = params.get("item");
  return itemKey ? { workspaceId, itemKey } : { workspaceId };
}
