"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { LoopConfigTarget } from "./LoopsConfig";
import { LoopRow, type LoopStatus } from "./LoopRow";

const linkButton: CSSProperties = { fontSize: 12, color: "var(--accent)", background: "none", border: "none", padding: 0, cursor: "pointer" };
const emptyHint: CSSProperties = { color: "var(--text-muted)", fontSize: 12 };

/** 中栏 Loops 模块面板（rail 第四模块视图的 body；PanelHeader 由 shell 渲染）。
 *  与总览 Loops 区块共用 LoopRow；本面板是常驻管理入口（配置/新建 → 右栏 loopConfig 视图）。 */
export function LoopsPanel({
  workspace,
  onOpenLoopConfig,
  onOpenFiles,
}: {
  workspace: WorkspaceSummary;
  onOpenLoopConfig: (target: LoopConfigTarget) => void;
  /** loop 名点击 → 跨视图定位：shell 切到工作台并把文件区 reveal 到 loops/<name>。 */
  onOpenFiles: (name: string) => void;
}) {
  const [loops, setLoops] = useState<LoopStatus[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/loops`);
      if (!response.ok) return;
      const data = (await response.json()) as { loops?: LoopStatus[] };
      setLoops(data.loops ?? []);
    } catch { /* offline — keep last */ }
  }, [workspace.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loopAction = useCallback(async (name: string, action: "pause" | "resume" | "stop") => {
    if (action === "stop" && !window.confirm("终止本轮进程？未完成的工作由下轮补跑。")) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(name)}/${action}`,
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
  }, [refresh, workspace.id]);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      {loops.length === 0 ? (
        <div style={{ ...emptyHint, display: "flex", gap: 10, alignItems: "center" }}>
          <span>暂无 loop（文件即声明：loops/&lt;name&gt;/LOOP.md）</span>
          <button onClick={() => onOpenLoopConfig({ kind: "new" })} style={linkButton}>＋ 新建 Loop</button>
        </div>
      ) : (
        <>
          {loops.map((loop) => (
            <LoopRow
              key={loop.name}
              loop={loop}
              busy={busy}
              onConfigure={(name) => onOpenLoopConfig({ kind: "loop", name })}
              onAction={(name, action) => void loopAction(name, action)}
              onNameClick={() => onOpenFiles(loop.name)}
            />
          ))}
          <div>
            <button onClick={() => onOpenLoopConfig({ kind: "new" })} style={linkButton}>＋ 新建 Loop</button>
          </div>
        </>
      )}
    </div>
  );
}
