"use client";

import { useCallback, useEffect, useState } from "react";
import {
  clearSnapshot,
  getSnapshot,
  setSnapshot,
  shouldRefetch,
  subscribeWorkItems,
  type WorkItemsSnapshot,
} from "@/lib/work-items/store";
import type { InvalidWorkItem, WorkItemRecord } from "@/lib/work-items/types";

export const DEFAULT_WORK_ITEMS_POLL_MS = 5_000;

/** Floor for injected poll intervals (tests) — a 0/negative option would
 * hammer the API endpoint on every timer tick. */
const MIN_WORK_ITEMS_POLL_MS = 50;

export interface UseWorkItemsResult {
  snapshot: WorkItemsSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** mutation 成功后清快照 → 立即重取；所有宿主（中央页 + 快捷面板）经
   *  store 订阅同步看到清空与新数据。 */
  invalidate(): void;
}

type WorkItemsPayload = {
  items?: WorkItemRecord[];
  archivedItems?: WorkItemRecord[];
  invalid?: InvalidWorkItem[];
};

type FetchResult = { snapshot: WorkItemsSnapshot } | { error: string };

async function fetchWorkItemsSnapshot(workspaceId: string): Promise<FetchResult> {
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-items`);
    if (!response.ok) return { error: `加载工作项失败（HTTP ${response.status}）` };
    const data = (await response.json()) as WorkItemsPayload;
    return {
      snapshot: {
        items: data.items ?? [],
        archivedItems: data.archivedItems ?? [],
        invalid: data.invalid ?? [],
        fetchedAt: Date.now(),
      },
    };
  } catch {
    return { error: "加载工作项失败（网络错误）" };
  }
}

/** ONE poller per workspaceId regardless of how many hosts are mounted
 *  (spec §6.3 同一工作区不启动两个轮询器). `refCount` = mounted hosts;
 *  the interval + global listeners live while it is > 0. The first host's
 *  pollMs wins for the workspace's cadence — subsequent hosts only bump the
 *  count (pollMs is a test seam, not a per-host product setting). */
interface PollerEntry {
  refCount: number;
  pollMs: number;
  timer: ReturnType<typeof setInterval> | null;
  /** single-flight per workspace: concurrent gated/forced revalidations
   *  (mount + poll tick + focus) share one request. Resolves to an error
   *  message or null; never rejects. */
  inflight: Promise<string | null> | null;
}

const pollers = new Map<string, PollerEntry>();
let globalListenerRefCount = 0;

function clampPollMs(pollMs: number): number {
  return Math.max(MIN_WORK_ITEMS_POLL_MS, Math.min(pollMs, 3_600_000));
}

/** Gated by shouldRefetch unless `force` (explicit refresh / post-mutation):
 * a snapshot another host fetched moments ago short-circuits the request. */
function revalidate(entry: PollerEntry, workspaceId: string, force: boolean): Promise<string | null> {
  if (!force && !shouldRefetch(getSnapshot(workspaceId), Date.now(), entry.pollMs)) {
    return Promise.resolve(null);
  }
  if (entry.inflight) return entry.inflight;
  const promise = (async () => {
    const result = await fetchWorkItemsSnapshot(workspaceId);
    if ("snapshot" in result) {
      setSnapshot(workspaceId, result.snapshot);
      return null;
    }
    return result.error;
  })().finally(() => {
    entry.inflight = null;
  });
  entry.inflight = promise;
  return promise;
}

function stopTimer(entry: PollerEntry): void {
  if (entry.timer !== null) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

function startTimer(entry: PollerEntry, workspaceId: string): void {
  if (entry.timer !== null) return;
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  entry.timer = setInterval(() => {
    void revalidate(entry, workspaceId, false);
  }, entry.pollMs);
}

/** 后台页面停止轮询；回到可见 = 立即校验一次 + 恢复轮询；聚焦 = 校验一次。 */
function handleVisibilityChange(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") {
    for (const [workspaceId, entry] of pollers) {
      startTimer(entry, workspaceId);
      void revalidate(entry, workspaceId, false);
    }
  } else {
    for (const entry of pollers.values()) stopTimer(entry);
  }
}

function handleWindowFocus(): void {
  for (const [workspaceId, entry] of pollers) {
    void revalidate(entry, workspaceId, false);
  }
}

/** One global listener pair for the whole module, installed while at least
 *  one workspace poller exists. */
function acquireGlobalListeners(): void {
  globalListenerRefCount += 1;
  if (globalListenerRefCount > 1) return;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);
}

function releaseGlobalListeners(): void {
  globalListenerRefCount = Math.max(0, globalListenerRefCount - 1);
  if (globalListenerRefCount > 0) return;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("focus", handleWindowFocus);
}

function ensurePoller(workspaceId: string, pollMs: number): PollerEntry {
  let entry = pollers.get(workspaceId);
  if (!entry) {
    entry = { refCount: 0, pollMs: clampPollMs(pollMs), timer: null, inflight: null };
    pollers.set(workspaceId, entry);
  }
  if (entry.refCount === 0) acquireGlobalListeners();
  entry.refCount += 1;
  startTimer(entry, workspaceId);
  return entry;
}

function releasePoller(workspaceId: string): void {
  const entry = pollers.get(workspaceId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  stopTimer(entry);
  pollers.delete(workspaceId);
  releaseGlobalListeners();
}

export function useWorkItems(
  workspaceId: string | null,
  options?: { pollMs?: number },
): UseWorkItemsResult {
  const pollMs = clampPollMs(options?.pollMs ?? DEFAULT_WORK_ITEMS_POLL_MS);
  const [snapshot, setSnapshotState] = useState<WorkItemsSnapshot | null>(() =>
    workspaceId ? getSnapshot(workspaceId) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared-store subscription: the module poller and other hosts' refreshes
  // write snapshots; every host re-renders off the same notification.
  useEffect(() => {
    if (!workspaceId) {
      setSnapshotState(null);
      setLoading(false);
      setError(null);
      return;
    }
    // Catch up in case the store changed between render and this effect.
    setSnapshotState(getSnapshot(workspaceId));
    return subscribeWorkItems(workspaceId, (next) => setSnapshotState(next));
  }, [workspaceId]);

  // Mount / workspace switch: join the workspace's poller (refcounted) and
  // fetch only when no fresh snapshot exists (双宿主第二处秒开).
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const entry = ensurePoller(workspaceId, pollMs);
    if (shouldRefetch(getSnapshot(workspaceId), Date.now(), pollMs)) {
      // Stale-but-present snapshots refresh in the background — keep showing
      // the old list instead of flashing a loading state.
      if (!getSnapshot(workspaceId)) setLoading(true);
      revalidate(entry, workspaceId, true)
        .then((err) => {
          if (cancelled) return;
          setError(err);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
      releasePoller(workspaceId);
    };
  }, [workspaceId, pollMs]);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const entry = pollers.get(workspaceId);
    // The mount effect owns the poller for as long as this host is mounted;
    // the ad-hoc entry only covers degenerate pre-effect calls.
    const err = await revalidate(entry ?? { refCount: 0, pollMs, timer: null, inflight: null }, workspaceId, true);
    setError(err);
  }, [workspaceId, pollMs]);

  const invalidate = useCallback(() => {
    if (!workspaceId) return;
    clearSnapshot(workspaceId);
    const entry = pollers.get(workspaceId);
    if (entry) {
      revalidate(entry, workspaceId, true)
        .then((err) => setError(err))
        .catch(() => undefined);
    }
    // No entry (unmounted race): the cleared store is enough — the next mount
    // sees shouldRefetch(null-snapshot) and fetches.
  }, [workspaceId]);

  return { snapshot, loading, error, refresh, invalidate };
}
