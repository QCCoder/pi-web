"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

interface Props {
  workspaces: WorkspaceSummary[];
  tabIds: string[];
  activeWorkspaceId: string | null;
  activityByWorkspaceId: Record<string, "running" | "completed" | undefined>;
  onSelectHome: () => void;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onReorder: (tabIds: string[]) => void;
  /** ＋ at the tab strip's right end — opens a workspace picker: select one
   *  to open (or switch to) that workspace's chat view. Creating workspaces
   *  lives on HomeLanding only (mobile consensus: the old ＋-opens-wizard
   *  behavior made switching to an unopened workspace a detour through 首页). */
  onPickWorkspace: (workspace: WorkspaceSummary) => void;
}

function shortestUniqueLabels(workspaces: WorkspaceSummary[]): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, WorkspaceSummary[]>();
  for (const workspace of workspaces) {
    const group = byName.get(workspace.name) ?? [];
    group.push(workspace);
    byName.set(workspace.name, group);
  }
  for (const group of byName.values()) {
    if (group.length === 1) {
      labels.set(group[0].id, group[0].name);
      continue;
    }
    const segments = group.map((workspace) => workspace.path.split(/[\\/]+/).filter(Boolean));
    for (let depth = 1; depth <= Math.max(...segments.map((parts) => parts.length)); depth += 1) {
      const suffixes = segments.map((parts) => parts.slice(-depth).join("/"));
      if (new Set(suffixes).size !== group.length) continue;
      group.forEach((workspace, index) => labels.set(workspace.id, `${workspace.name} · ${suffixes[index]}`));
      break;
    }
    group.forEach((workspace) => {
      if (!labels.has(workspace.id)) labels.set(workspace.id, `${workspace.name} · ${workspace.id.slice(0, 6)}`);
    });
  }
  return labels;
}

export function WorkspaceTabBar({
  workspaces,
  tabIds,
  activeWorkspaceId,
  activityByWorkspaceId,
  onSelectHome,
  onSelectWorkspace,
  onCloseWorkspace,
  onReorder,
  onPickWorkspace,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRect, setPickerRect] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const openWorkspaces = tabIds
    .map((id) => workspaces.find((workspace) => workspace.id === id))
    .filter((workspace): workspace is WorkspaceSummary => Boolean(workspace));
  const labels = shortestUniqueLabels(openWorkspaces);
  const availableWorkspaces = workspaces.filter((workspace) => workspace.available);
  const pickerLabels = shortestUniqueLabels(availableWorkspaces);
  const openTabIds = new Set(tabIds);

  // The picker dropdown lives in a body-level portal: the tab strip is an
  // overflow-x scroller and would clip an absolutely-positioned child.
  useEffect(() => {
    if (!pickerOpen) return;
    const rect = plusRef.current?.getBoundingClientRect();
    if (rect) {
      setPickerRect({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
        maxHeight: Math.max(160, Math.min(320, window.innerHeight - rect.bottom - 16)),
      });
    }
  }, [pickerOpen]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeWorkspaceId]);

  const reorderBefore = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const next = tabIds.filter((id) => id !== draggedId);
    next.splice(next.indexOf(targetId), 0, draggedId);
    onReorder(next);
  };

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label="工作区"
      onWheel={(event) => {
        if (!containerRef.current || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        containerRef.current.scrollLeft += event.deltaY;
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!draggedId) return;
        onReorder([...tabIds.filter((id) => id !== draggedId), draggedId]);
        setDraggedId(null);
      }}
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 36,
        flexShrink: 0,
        overflowX: "auto",
        overflowY: "hidden",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        ref={activeWorkspaceId === null ? activeRef : undefined}
        role="tab"
        aria-selected={activeWorkspaceId === null}
        onClick={onSelectHome}
        style={tabStyle(activeWorkspaceId === null, true)}
      >
        <HomeIcon />
        <span>首页</span>
      </div>
      {openWorkspaces.map((workspace) => {
        const active = workspace.id === activeWorkspaceId;
        return (
          <div
            key={workspace.id}
            ref={active ? activeRef : undefined}
            role="tab"
            aria-selected={active}
            draggable
            onDragStart={(event) => {
              setDraggedId(workspace.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", workspace.id);
            }}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              reorderBefore(workspace.id);
              setDraggedId(null);
            }}
            onClick={() => onSelectWorkspace(workspace)}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onCloseWorkspace(workspace.id);
            }}
            title={`${workspace.name}\n${workspace.path}`}
            style={{ ...tabStyle(active), opacity: draggedId === workspace.id ? 0.55 : 1 }}
          >
            <ActivityIndicator status={activityByWorkspaceId[workspace.id]} />
            <WorkspaceIcon />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {labels.get(workspace.id) ?? workspace.name}
            </span>
            <button
              type="button"
              title={`关闭 ${workspace.name}`}
              aria-label={`关闭 ${workspace.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseWorkspace(workspace.id);
              }}
              style={{
                width: 28,
                height: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                padding: 0,
                border: 0,
                borderRadius: 5,
                background: "transparent",
                color: "var(--text-dim)",
                cursor: "pointer",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="m2 2 6 6M8 2 2 8" />
              </svg>
            </button>
          </div>
        );
      })}
      <button
        ref={plusRef}
        type="button"
        title="打开工作区"
        aria-label="打开工作区"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((open) => !open)}
        style={{
          width: 36,
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          padding: 0,
          border: 0,
          borderLeft: "1px solid var(--border)",
          background: pickerOpen ? "var(--bg-hover)" : "transparent",
          color: pickerOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ＋
      </button>
      {pickerOpen && pickerRect && createPortal(
        <>
          <div
            aria-hidden="true"
            onClick={() => setPickerOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 2000 }}
          />
          <div
            role="menu"
            aria-label="打开工作区"
            style={{
              position: "fixed",
              top: pickerRect.top,
              right: pickerRect.right,
              zIndex: 2001,
              minWidth: 220,
              maxWidth: 300,
              maxHeight: pickerRect.maxHeight,
              overflowY: "auto",
              padding: 4,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
            }}
          >
            {availableWorkspaces.length === 0 && (
              <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-dim)" }}>没有可用工作区</div>
            )}
            {availableWorkspaces.map((workspace) => {
              const active = workspace.id === activeWorkspaceId;
              const isOpen = openTabIds.has(workspace.id);
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitem"
                  title={`${workspace.name}\n${workspace.path}`}
                  onClick={() => { setPickerOpen(false); onPickWorkspace(workspace); }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    minHeight: 34,
                    padding: "6px 8px",
                    border: 0,
                    borderRadius: 6,
                    background: active ? "var(--bg-selected)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 12,
                    fontWeight: active ? 600 : 450,
                  }}
                >
                  <WorkspaceIcon />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {pickerLabels.get(workspace.id) ?? workspace.name}
                  </span>
                  <ActivityIndicator status={activityByWorkspaceId[workspace.id]} />
                  {isOpen && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>已打开</span>}
                  {active && <span aria-hidden style={{ color: "var(--accent)", fontSize: 12, flexShrink: 0 }}>✓</span>}
                </button>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function tabStyle(active: boolean, pinned = false): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minWidth: pinned ? 96 : 120,
    maxWidth: pinned ? 96 : 220,
    height: 36,
    padding: pinned ? "0 14px" : "0 5px 0 12px",
    flexShrink: 0,
    borderRight: "1px solid var(--border)",
    borderTop: active ? "2px solid var(--accent)" : "2px solid transparent",
    background: active ? "var(--bg)" : "var(--bg-panel)",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: 12,
    fontWeight: active ? 600 : 450,
    boxSizing: "border-box",
    whiteSpace: "nowrap",
  };
}

function ActivityIndicator({ status }: { status: "running" | "completed" | undefined }) {
  if (!status) return null;
  if (status === "running") {
    return (
      <span
        title="有会话正在运行"
        aria-label="运行中"
        style={{
          width: 12,
          height: 12,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text)",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
          <g>
            <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 12 12"
              to="360 12 12"
              dur="0.9s"
              repeatCount="indefinite"
            />
          </g>
        </svg>
      </span>
    );
  }
  return (
    <span
      title="有会话已完成，尚未查看"
      aria-label="完成"
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        flexShrink: 0,
        background: "var(--accent)",
      }}
    />
  );
}

function HomeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
