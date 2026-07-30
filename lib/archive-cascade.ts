// Bridge between Work Item archive state and Session archive state.
//
// When a Work Item (requirement/bug) is archived, the sessions that discussed
// it should be tucked away too — but ONLY when no other still-active Work Item
// references them (smart cascade). Restoring a Work Item brings its sessions
// back (symmetric). These functions sit above both services so neither has to
// depend on the other.
import { listWorkItems } from "./work-items/service";
import type { WorkItemRecord } from "./work-items/types";
import { restoreSession, archiveSession, SessionArchiveError } from "./session-archive";

/**
 * Session ids from `item.conversations` that are NOT referenced by any
 * non-archived Work Item. These are safe to archive (their only owners are
 * archived). Call AFTER the item has been marked archived so it no longer
 * counts as an active owner.
 */
export async function computeOrphanedSessionIds(
  candidateIds: string[],
  workspacePath: string,
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const { items } = await listWorkItems(workspacePath);
  const activeReferenced = new Set<string>();
  for (const other of items) {
    if (other.archivedAt) continue;
    for (const conversationId of other.conversations) activeReferenced.add(conversationId);
  }
  return candidateIds.filter((id) => !activeReferenced.has(id));
}

/** Archive the orphaned sessions of a just-archived Work Item. Best-effort:
 *  sessions that fail to archive (missing file, etc.) are skipped. */
export async function cascadeArchiveWorkItemSessions(
  item: WorkItemRecord,
  workspacePath: string,
): Promise<{ archived: string[]; skipped: string[] }> {
  const orphaned = await computeOrphanedSessionIds(item.conversations, workspacePath);
  const archived: string[] = [];
  const skipped: string[] = [];
  for (const id of orphaned) {
    try {
      await archiveSession(id);
      archived.push(id);
    } catch {
      skipped.push(id);
    }
  }
  return { archived, skipped };
}

/** Restore every archived session referenced by a just-restored Work Item.
 *  Sessions that are not currently archived (or missing) are skipped silently. */
export async function cascadeRestoreWorkItemSessions(
  item: WorkItemRecord,
): Promise<{ restored: string[]; skipped: string[] }> {
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const id of item.conversations) {
    try {
      await restoreSession(id);
      restored.push(id);
    } catch (error) {
      // Not archived or missing — that's fine, leave it as-is.
      if (error instanceof SessionArchiveError) skipped.push(id);
      else skipped.push(id);
    }
  }
  return { restored, skipped };
}
