"use client";

import { useState } from "react";
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
}

export function LoopsDockPanel({ workspace, refreshKey, onChanged, onRunLoop }: Props) {
  const [configTarget, setConfigTarget] = useState<LoopConfigTarget | null>(null);
  const { loops, busy, refresh, runAction } = useKitLoops(workspace.id, refreshKey);

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
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" }}>
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
          {loops.map((loop) => (
            <LoopRow
              key={loop.name}
              loop={loop}
              busy={busy}
              onConfigure={(name) => setConfigTarget({ kind: "loop", name })}
              onAction={(name, action) => void runAction(name, action)}
              onRun={() => onRunLoop(loop.name)}
            />
          ))}
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
  );
}
