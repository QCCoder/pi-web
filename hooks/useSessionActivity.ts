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

export function useSessionActivity(selectedSessionId: string | null, refreshKey = 0) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => loadIds(COMPLETED_KEY));
  const previousRunningRef = useRef<Set<string>>(loadIds(LAST_RUNNING_KEY));
  const receivedSnapshotRef = useRef(false);

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) return;
      const data = await response.json() as { sessions?: SessionInfo[]; runningSessionIds?: string[] };
      const nextSessions = data.sessions ?? [];
      setSessions(nextSessions);
      if (!receivedSnapshotRef.current) setRunningIds(new Set(data.runningSessionIds ?? []));
      const existing = new Set(nextSessions.map((session) => session.id));
      setCompletedIds((current) => new Set([...current].filter((id) => existing.has(id))));
    } catch {
      // Activity indicators are best-effort; the owning views render fetch errors.
    }
  }, []);

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

  useEffect(() => {
    saveIds(COMPLETED_KEY, completedIds);
  }, [completedIds]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === COMPLETED_KEY) setCompletedIds(loadIds(COMPLETED_KEY));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  return { sessions, runningIds, completedIds };
}
