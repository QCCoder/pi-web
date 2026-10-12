"use client";

import { useState } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/**
 * 工作区切换面板（2026-09-27 侧栏瘦身改版，两端共用）：
 *
 *   工作区 ────────────   ← 可选用工作区列表：点击 = 切换（两端统一语义：
 *   ✓ pi        ⟳          桌面开总览家 tab；手机 ensureWorkspaceContext +
 *   · cxin                 mobilePage:"overview" 落总览）；行可拖拽排序
 *   ──────────────         （全量 PATCH，停用/不可用项保持现序垫底）
 *   ＋ 新建工作区…         ← 原「项目＋」菜单承接
 *   ⬆ 导入目录…
 *   ──────────────
 *   ⚙ cxin（已停用）       ← 树底暗淡行承接（hover/点击 ⚙ 深链设置›工作区
 *   ──────────────           重启用——「找得回」硬要求不断）
 *   模块（当前工作区）
 *   🏠 总览  📄 文件       ← 宿主传入（桌面 = dock 开合语义；手机 = 目的地页），
 *   ☑ 工作项  📚 知识库      capability 门控与 active 高亮都由宿主计算
 *   🔁 Loops
 *
 * 宿主形态：桌面 = 32px 工作区工具行「工作区名 ▾」下方弹出（点外部关闭）；
 * 移动端 = 抽屉/常驻树头部的「工作区名 ▾」内联展开。本组件只渲染内容。
 */

/** 模块入口行（宿主组装：桌面 = 右坞开合语义；手机 = mobilePage 目的地）。 */
export interface SwitcherModuleEntry {
  id: string;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}

interface Props {
  /** 全量工作区列表（含停用/不可用——重排序时要保持隐藏项现序垫底）。 */
  workspaces: WorkspaceSummary[];
  currentWorkspaceId: string | null;
  workspaceActivity: Record<string, "running" | "completed" | undefined>;
  /** 当前工作区的模块入口（移动端 = mobilePage 目的地；桌面 rail 改版后
   *  不再传入——模块入口常驻右坞图标列，切换器回归纯工作区管理）。缺省/空 = 不渲染模块区。 */
  moduleEntries?: SwitcherModuleEntry[];
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onReorderWorkspaces?: (ids: string[]) => void;
  /** 已停用工作区的 ⚙ 重启用路径（设置›工作区预选）。 */
  onOpenWorkspaceSettings?: (workspace: WorkspaceSummary) => void;
}

export function WorkspaceSwitcherPanel({
  workspaces,
  currentWorkspaceId,
  workspaceActivity,
  moduleEntries = [],
  onSelectWorkspace,
  onCreateWorkspace,
  onImportDirectory,
  onReorderWorkspaces,
  onOpenWorkspaceSettings,
}: Props) {
  const selectable = workspaces.filter((workspace) => workspace.available && !workspace.disabled);
  // 树底暗淡行承接：停用（可重启用，⚙ 可点）/ 目录不可用（纯展示）。
  const hiddenWorkspaces = workspaces.filter((workspace) => !workspace.available || workspace.disabled);

  // ---- 拖拽排序（原树内 DnD 平移）：drop 到行上半/下半 = 插前/插后，列表尾
  // 空区 = 移到末位；PATCH 全量期望序——停用/不可用项保持现序垫底。 ----------
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string | null; position: "before" | "after" } | null>(null);
  const clearDrag = () => {
    setDraggedId(null);
    setDropHint(null);
  };
  const moveDraggedWorkspace = (targetId: string | null, position: "before" | "after") => {
    if (!draggedId || !onReorderWorkspaces) return;
    if (targetId === draggedId) return;
    const visibleIds = selectable.map((w) => w.id);
    const next = visibleIds.filter((id) => id !== draggedId);
    if (targetId === null) {
      next.push(draggedId);
    } else {
      const at = next.indexOf(targetId);
      if (at < 0) return;
      next.splice(position === "after" ? at + 1 : at, 0, draggedId);
    }
    const visible = new Set(visibleIds);
    const tail = workspaces.filter((w) => !visible.has(w.id)).map((w) => w.id);
    onReorderWorkspaces([...next, ...tail]);
  };
  const dropPositionOf = (event: React.DragEvent): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  };

  return (
    <div style={{ padding: 6, fontSize: 12.5 }}>
      <PanelSectionLabel>工作区</PanelSectionLabel>
      <div
        onDragOver={(event) => {
          if (draggedId) {
            event.preventDefault();
            setDropHint({ targetId: null, position: "after" });
          }
        }}
        onDrop={(event) => {
          if (!draggedId) return;
          event.preventDefault();
          moveDraggedWorkspace(null, "after");
          clearDrag();
        }}
      >
        {selectable.map((workspace) => {
          const isCurrent = workspace.id === currentWorkspaceId;
          const activity = workspaceActivity[workspace.id];
          return (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={isCurrent}
              draggable={onReorderWorkspaces ? true : undefined}
              onDragStart={() => {
                if (!onReorderWorkspaces) return;
                setDraggedId(workspace.id);
              }}
              onDragEnd={clearDrag}
              onDragOver={(event) => {
                if (!onReorderWorkspaces || !draggedId) return;
                event.preventDefault();
                event.stopPropagation();
                setDropHint({ targetId: workspace.id, position: dropPositionOf(event) });
              }}
              onDrop={(event) => {
                if (!onReorderWorkspaces || !draggedId) return;
                event.preventDefault();
                event.stopPropagation();
                moveDraggedWorkspace(workspace.id, dropPositionOf(event));
                clearDrag();
              }}
              onClick={() => onSelectWorkspace(workspace)}
              title={`${workspace.name}${isCurrent ? "（当前工作区）" : "（切换）"}`}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "6px 9px",
                border: 0,
                borderRadius: 7,
                background: isCurrent ? "var(--bg-selected)" : "transparent",
                color: "var(--text)",
                cursor: "pointer",
                textAlign: "left",
                opacity: draggedId === workspace.id ? 0.5 : 1,
                transition: "opacity 0.15s ease, background 0.1s",
                position: "relative",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = isCurrent ? "var(--bg-selected)" : "transparent"; }}
            >
              {dropHint?.targetId === workspace.id && (
                <span
                  aria-hidden
                  className="workspace-drop-line"
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    height: 2,
                    borderRadius: 2,
                    background: "var(--accent)",
                    boxShadow: "0 0 4px color-mix(in srgb, var(--accent) 45%, transparent)",
                    ...(dropHint.position === "before" ? { top: -2 } : { bottom: -2 }),
                  }}
                />
              )}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: isCurrent ? "var(--accent)" : "var(--text-dim)" }}>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span style={{ flex: 1, minWidth: 0, fontWeight: isCurrent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis" }}>
                {workspace.name}
              </span>
              {activity === "running" && (
                <span title="有会话正在运行" style={{ display: "inline-flex", flexShrink: 0, color: "var(--text)" }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
                    <g>
                      <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
                      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                    </g>
                  </svg>
                </span>
              )}
              {activity === "completed" && (
                <span title="有会话已完成" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: "var(--accent)" }} />
              )}
              {isCurrent && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          );
        })}
        {draggedId && dropHint?.targetId === null && (
          <div aria-hidden className="workspace-drop-line" style={{ height: 2, margin: "0 2px 4px", borderRadius: 2, background: "var(--accent)" }} />
        )}
      </div>

      <button
        type="button"
        role="menuitem"
        onClick={onCreateWorkspace}
        className="workspace-switcher-action"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 9px",
          border: 0,
          borderRadius: 7,
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M12 5v14" /><path d="M5 12h14" />
        </svg>
        新建工作区…
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onImportDirectory}
        className="workspace-switcher-action"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 9px",
          border: 0,
          borderRadius: 7,
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        导入目录…
      </button>

      {hiddenWorkspaces.length > 0 && <PanelDivider />}
      {hiddenWorkspaces.map((workspace) => {
        const actionable = Boolean(workspace.disabled && workspace.available && onOpenWorkspaceSettings);
        return (
          <button
            key={workspace.id}
            type="button"
            disabled={!actionable}
            role={actionable ? "menuitem" : undefined}
            title={actionable
              ? `${workspace.name}（已停用——点击前往设置重新启用）`
              : `${workspace.name}（目录或配置不可用）`}
            aria-label={actionable ? `已停用：${workspace.name}，前往设置重新启用` : undefined}
            onClick={() => onOpenWorkspaceSettings?.(workspace)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 9px",
              border: 0,
              borderRadius: 7,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: actionable ? "pointer" : "default",
              fontSize: 12,
              textAlign: "left",
              opacity: 0.68,
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { if (actionable) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{workspace.name}</span>
            <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", background: "var(--bg-hover)", borderRadius: 6, padding: "1px 6px" }}>
              {!workspace.available ? "不可用" : "已停用"}
            </span>
          </button>
        );
      })}

      {moduleEntries.length > 0 && (
        <>
          <PanelDivider />
          <PanelSectionLabel>模块（{workspaces.find((w) => w.id === currentWorkspaceId)?.name ?? ""}）</PanelSectionLabel>
          {moduleEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={entry.active}
              onClick={entry.onClick}
              title={entry.label}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "6px 9px",
                border: 0,
                borderRadius: 7,
                background: entry.active ? "var(--bg-selected)" : "transparent",
                color: entry.active ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                textAlign: "left",
                transition: "background 0.1s",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { if (!entry.active) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = entry.active ? "var(--bg-selected)" : "transparent"; }}
            >
              <span style={{ display: "flex", flexShrink: 0, opacity: entry.active ? 1 : 0.75 }}>{entry.icon}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{entry.label}</span>
              {entry.active && (
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: "var(--accent)" }} />
              )}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function PanelSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "4px 9px 3px", fontSize: 10.5, fontWeight: 700, color: "var(--text-dim)", userSelect: "none", letterSpacing: 0.3 }}>
      {children}
    </div>
  );
}

function PanelDivider() {
  return <div style={{ height: 1, background: "var(--border)", margin: "5px 4px" }} />;
}
