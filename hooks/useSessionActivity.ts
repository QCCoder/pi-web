"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";

const COMPLETED_KEY = "pi-web:completed-unviewed-session-ids";
const LAST_RUNNING_KEY = "pi-web:last-running-session-ids";

function loadIds(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value)
      ? new Set(value.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function saveIds(key: string, ids: Set<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Ignore storage quota and privacy-mode failures.
  }
}

/** SSR 预取种子（方案二）：page.tsx 服务端预取的会话列表 + 运行中集合。
 *  种子让首帧即真数据（无「空列表→填充」跳变）；null = 无种子，退回客户端拉取。 */
export interface SessionActivitySeed {
  sessions: SessionInfo[];
  runningIds: string[];
}

export function useSessionActivity(
  selectedSessionId: string | null,
  refreshKey = 0,
  seed?: SessionActivitySeed | null,
) {
  const [sessions, setSessions] = useState<SessionInfo[]>(() => seed?.sessions ?? []);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set(seed?.runningIds ?? []));
  const [loaded, setLoaded] = useState(() => seed != null);
  // SSR 先空（服务端无 localStorage），挂载后读取持久化值——避免服务端/客户端
  // 首帧不一致的 hydration mismatch（同 ProjectSidebar 折叠态的模式）。此前在
  // useState 初始化器里直接 loadIds：服务端空集 vs 客户端持久化集合，侧栏工作区
  // 的「已完成」点两帧渲染不同，整树被客户端重建（devtools "1 Issue" 的根因）。
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => new Set());
  const [completedHydrated, setCompletedHydrated] = useState(false);
  /** 会话列表版本（服务端磁盘目录缓存代数）：/api/sessions 响应携带，作为
   *  搜索的跨窗口 refreshKey 暴露给视图层。 */
  const [listVersion, setListVersion] = useState<number | null>(null);
  const listVersionRef = useRef<number | null>(null);
  const previousRunningRef = useRef<Set<string>>(loadIds(LAST_RUNNING_KEY));
  const receivedSnapshotRef = useRef(false);

  useEffect(() => {
    setCompletedIds(loadIds(COMPLETED_KEY));
    setCompletedHydrated(true);
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) return;
      const data = await response.json() as { sessions?: SessionInfo[]; runningSessionIds?: string[]; sessionListVersion?: number };
      const nextSessions = data.sessions ?? [];
      setSessions(nextSessions);
      if (typeof data.sessionListVersion === "number") {
        listVersionRef.current = data.sessionListVersion;
        setListVersion(data.sessionListVersion);
      }
      if (!receivedSnapshotRef.current) setRunningIds(new Set(data.runningSessionIds ?? []));
      const existing = new Set(nextSessions.map((session) => session.id));
      setCompletedIds((current) => new Set([...current].filter((id) => existing.has(id))));
    } catch {
      // Activity indicators are best-effort; the owning views render fetch errors.
    } finally {
      setLoaded(true);
    }
  }, []);

  // 跨窗口同步（上游 1cbd96f 的 sessionListVersion 比对轮询）：本窗口看不到
  // 的会话增删（其他窗口/归档/CLI 改动触发服务端 invalidation）靠版本变化
  // 察觉并重拉列表——搜索结果（refreshKey=listVersion）随之自动重跑。
  // 上游语义：只在前台轮询轻量版本端点；发现变化复用已失效缓存，不 force。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void (async () => {
        try {
          const res = await fetch("/api/sessions/version");
          if (!res.ok) return;
          const data = await res.json() as { sessionListVersion?: number };
          if (typeof data.sessionListVersion !== "number") return;
          if (data.sessionListVersion !== listVersionRef.current) await loadSessions();
        } catch {
          // Keep the last known state; the next tick retries.
        }
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadSessions]);

  useEffect(() => {
    // Coalesce bursts of refreshKey bumps (an archive cascade or a work-item
    // mutation can bump several times in one tick) into one list fetch.
    const timer = setTimeout(() => void loadSessions(), 300);
    return () => clearTimeout(timer);
  }, [loadSessions, refreshKey]);

  useEffect(() => {
    const source = new EventSource("/api/agent/running/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; runningSessionIds?: string[] };
        if (data.type !== "running") return;
        receivedSnapshotRef.current = true;
        setRunningIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // EventSource reconnects automatically; retain the last good snapshot.
      }
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    const previous = previousRunningRef.current;
    const completed = [...previous].filter((id) => !runningIds.has(id));
    setCompletedIds((current) => {
      const next = new Set(current);
      runningIds.forEach((id) => next.delete(id));
      completed.forEach((id) => {
        const isVisibleSelection = id === selectedSessionId && document.visibilityState === "visible";
        if (!isVisibleSelection) next.add(id);
      });
      return next;
    });
    if (completed.length > 0) void loadSessions();
    previousRunningRef.current = runningIds;
    saveIds(LAST_RUNNING_KEY, runningIds);
  }, [loadSessions, runningIds, selectedSessionId]);

  useEffect(() => {
    const markVisibleSelectionRead = () => {
      if (!selectedSessionId || document.visibilityState !== "visible") return;
      setCompletedIds((current) => {
        if (!current.has(selectedSessionId)) return current;
        const next = new Set(current);
        next.delete(selectedSessionId);
        return next;
      });
    };
    markVisibleSelectionRead();
    document.addEventListener("visibilitychange", markVisibleSelectionRead);
    return () => document.removeEventListener("visibilitychange", markVisibleSelectionRead);
  }, [selectedSessionId]);

  // 水合恢复完成前不回写：否则挂载首拍会把空集存进去，抹掉持久化的未读记录。
  useEffect(() => {
    if (!completedHydrated) return;
    saveIds(COMPLETED_KEY, completedIds);
  }, [completedIds, completedHydrated]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === COMPLETED_KEY) setCompletedIds(loadIds(COMPLETED_KEY));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  return { sessions, runningIds, completedIds, loaded, listVersion };
}
