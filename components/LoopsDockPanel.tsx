"use client";

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { LoopRow } from "./LoopRow";
import { LoopsConfig, type LoopConfigTarget } from "./LoopsConfig";
import { PanelHeader } from "./PanelHeader";
import { useKitLoops } from "@/hooks/useKitLoops";

/**
 * The right dock's Loops tab body (right-dock design S1): loop 列表（状态/
 * 暂停恢复/停止/运行）+ 点开内联 LoopsConfig（推进航：列表 → 配置 → ‹ 返回，
 * LoopsConfig 的宿主从"中心区顶替（loopConfig 状态，已退役）"迁到这里）。
 *
 * 挂载语义（design 决策 #6）：DesktopShell 以 key={workspace.id} 挂载本组件
 * ——同工作区切会话 tab 时不卸载（display:none 存活，正在看的配置状态保留），
 * 换工作区才整体重置。常驻渲染（无 capability 门控）：无 loop 显示空态 +
 * 「新建」入口，平移总览 Loops 区块的常驻语义。
 */
interface Props {
  workspace: WorkspaceSummary;
  /** shell 的 loop 变更信号（创建/删除/保存后 bump → 重新拉取）。 */
  refreshKey?: number;
  /** LoopsConfig 写操作成功后回调（shell bump loopsRefreshKey，总览摘要行联动）。 */
  onChanged?: () => void;
  /** 「运行」——手动起一轮并打开轮会话 tab（useAppShellState.handleRunLoopDirect）。 */
  onRunLoop: (name: string) => void;
  /** 列表视图顶部的宿主头（如移动端工作区 tab「Loops」子页的 ‹返回
   *  PanelHeader；配置视图自带 PanelHeader，不用它）。桌面不传。 */
  listHeader?: ReactNode;
}

export function LoopsDockPanel({ workspace, refreshKey, onChanged, onRunLoop, listHeader }: Props) {
  const [configTarget, setConfigTarget] = useState<LoopConfigTarget | null>(null);
  const [recoveringName, setRecoveringName] = useState<string | null>(null);
  const [recoverNote, setRecoverNote] = useState<{ text: string; error?: boolean } | null>(null);
  const { loops, interruptions, busy, refresh, runAction } = useKitLoops(workspace.id, refreshKey);

  /** 「重新检查并恢复」（spec §5.4）：POST recover → 成功与 409（探测到残留
   *  进程）都内联展示结果 → 重拉列表（成功时徽章随记录解除消失）。 */
  const handleRecover = useCallback(
    async (name: string) => {
      setRecoveringName(name);
      setRecoverNote(null);
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(name)}/recover`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        const body = (await response.json().catch(() => ({}))) as { error?: string; resolved?: number };
        if (response.ok) {
          setRecoverNote({ text: `已恢复：解除 ${typeof body.resolved === "number" ? body.resolved : 0} 条中断记录` });
        } else {
          setRecoverNote({ text: body.error || `恢复失败（HTTP ${response.status}）`, error: true });
        }
        await refresh();
      } catch (error) {
        setRecoverNote({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setRecoveringName(null);
      }
    },
    [refresh, workspace.id],
  );

  if (configTarget) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PanelHeader
          title={configTarget.kind === "new" ? "新建 Loop" : configTarget.name}
          meta="Loop 配置"
          onBack={() => setConfigTarget(null)}
          backLabel="Loops"
        />
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <LoopsConfig
            workspace={workspace}
            target={configTarget}
            onClose={() => setConfigTarget(null)}
            onOpenLoop={(name) => setConfigTarget({ kind: "loop", name })}
            onChanged={() => {
              onChanged?.();
              void refresh();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {listHeader}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" }}>
      {recoverNote && (
        <div style={{ color: recoverNote.error ? "#b91c1c" : "var(--text-muted)", fontSize: 12, padding: "6px 0" }}>
          {recoverNote.text}
        </div>
      )}
      {loops.length === 0 ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--text-muted)", fontSize: 12 }}>
          <span>暂无 loop（文件即声明：.pi/loops/&lt;name&gt;/LOOP.md）</span>
          <button
            onClick={() => setConfigTarget({ kind: "new" })}
            style={{ border: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 500 }}
          >
            ＋ 新建 Loop
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {loops.map((loop) => {
            // 记录的 loopName 与 collectStatus 的 name 同为声明名（declaration.loopName）
            const interrupted = interruptions.find((record) => record.loopName === loop.name);
            return (
              <LoopRow
                key={loop.name}
                loop={loop}
                busy={busy}
                onConfigure={(name) => setConfigTarget({ kind: "loop", name })}
                onAction={(name, action) => void runAction(name, action)}
                onRun={() => onRunLoop(loop.name)}
                interrupted={interrupted ? { runId: interrupted.runId, stoppedAt: interrupted.stoppedAt } : undefined}
                onRecover={interrupted ? () => void handleRecover(loop.name) : undefined}
                recovering={recoveringName === loop.name}
              />
            );
          })}
          <div>
            <button
              onClick={() => setConfigTarget({ kind: "new" })}
              style={{ border: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 500 }}
            >
              ＋ 新建 Loop
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
