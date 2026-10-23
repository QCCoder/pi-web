import type { InvalidWorkItem, WorkItemRecord } from "./types";

/** Module-level per-workspace work-items snapshot cache (spec §6.3): the
 * central WorkItemsPage (T8) and the right-dock quick panel share ONE cache
 * keyed by workspaceId, so a mutation invalidating from either host is seen
 * by both. Pure data layer — no fetch, no timers, no DOM; the react hook
 * (hooks/useWorkItems.ts) owns fetching and polling on top of this store. */
/** trashedItems (M2 T9): .pi/trash/work-items 墓碑清单——回收站范围的列表与
 * 「从回收站恢复」入口数据源（恢复后走 restore-from-trash 路由）。 */
export interface WorkItemsSnapshot {
  items: WorkItemRecord[];
  archivedItems: WorkItemRecord[];
  trashedItems: WorkItemRecord[];
  invalid: InvalidWorkItem[];
  fetchedAt: number;
}

/** Listener receiving the workspace's CURRENT snapshot — the new snapshot on
 * `setSnapshot`, `null` on `clearSnapshot`. */
export type WorkItemsListener = (snapshot: WorkItemsSnapshot | null) => void;

const snapshots = new Map<string, WorkItemsSnapshot>();
const listeners = new Map<string, Set<WorkItemsListener>>();

export function getSnapshot(workspaceId: string): WorkItemsSnapshot | null {
  return snapshots.get(workspaceId) ?? null;
}

export function setSnapshot(workspaceId: string, snapshot: WorkItemsSnapshot): void {
  snapshots.set(workspaceId, snapshot);
  notify(workspaceId, snapshot);
}

export function clearSnapshot(workspaceId: string): void {
  snapshots.delete(workspaceId);
  notify(workspaceId, null);
}

/** Age-gate for (re)fetches: nothing cached yet, or the cached snapshot is at
 * least `maxAgeMs` old. A fresh snapshot (e.g. just written by another host
 * of the same workspace) short-circuits the fetch — 双宿主秒开 without a
 * fetch storm. A future `fetchedAt` (clock skew) counts as fresh. */
export function shouldRefetch(
  snapshot: WorkItemsSnapshot | null,
  now: number,
  maxAgeMs = 5_000,
): boolean {
  if (!snapshot) return true;
  return now - snapshot.fetchedAt >= maxAgeMs;
}

export function subscribeWorkItems(workspaceId: string, listener: WorkItemsListener): () => void {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(workspaceId);
  };
}

function notify(workspaceId: string, snapshot: WorkItemsSnapshot | null): void {
  const set = listeners.get(workspaceId);
  if (!set) return;
  for (const listener of set) listener(snapshot);
}
