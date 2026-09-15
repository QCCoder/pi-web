"use client";

import { useCallback, useEffect, useState } from "react";
import { type LoopStatus } from "@/components/LoopRow";

/** Shared kit-loop status plumbing for the two right-dock-era consumers:
 *  the desktop right dock's Loops tab (LoopsDockPanel) and WorkspaceOverview
 *  (mobile full block + desktop summary row). One fetch (GET
 *  /api/workspaces/:id/loops) + one action surface (pause/resume/stop POST),
 *  keyed by `refreshKey` so shell-side loop changes (create/delete/save)
 *  re-fetch everywhere. */
export function useKitLoops(workspaceId: string, refreshKey?: number) {
  const [loops, setLoops] = useState<LoopStatus[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/loops`);
      if (!response.ok) return;
      const data = (await response.json()) as { loops?: LoopStatus[] };
      setLoops(data.loops ?? []);
    } catch {
      // offline / daemon down — keep the last snapshot
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const runAction = useCallback(
    async (name: string, action: "pause" | "resume" | "stop") => {
      if (action === "stop" && !window.confirm("终止本轮进程？未完成的工作由下轮补跑。")) return;
      setBusy(true);
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/loops/${encodeURIComponent(name)}/${action}`,
          { method: "POST" },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          window.alert(body.error || `操作失败（HTTP ${response.status}）`);
        }
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, workspaceId],
  );

  return { loops, busy, refresh, runAction };
}
