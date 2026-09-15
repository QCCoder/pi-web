"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeMenuLayout, readViewportWindow } from "@/lib/dropdown-layout";
import type { SessionTabState } from "@/lib/session-tabs";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";

/**
 * 会话 tab 条（docs/session-tabs-design.md Phase 1）：顶栏 tab = 会话/占位/
 * 工作区家 tab，跨工作区混排（工作区色点标识）。替换旧的 WorkspaceTabBar，
 * 桌面/移动两 shell 共用（无 isMobile 分支——移动端就是一排可横滚的紧凑 chips）。
 *
 * 右端按钮区（P1）：＋ = 在当前 tab 的工作区开新会话 tab（无活动 tab 时隐藏——
 * 首页有自己的 composer）；⊞ = 工作区选择器下拉 → 开/激活该工作区的家 tab。
 */

interface Props {
  tabs: SessionTabState[];
  activeTabId: string | null;
  workspaces: WorkspaceSummary[];
  /** 全局 running 集会话级徽章，无需每会话 SSE（M1）。 */
  runningIds: ReadonlySet<string>;
  completedIds: ReadonlySet<string>;
  /** 家 tab 上的工作区级聚合活动（沿用旧 tab 条的 ActivityIndicator）。 */
  workspaceActivity: Record<string, "running" | "completed" | undefined>;
  onSelectHome: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onNewSession: () => void;
  onPickWorkspace: (workspace: WorkspaceSummary) => void;
}

/** 工作区色点：id 哈希 → 固定调色板（同一工作区跨会话/家 tab 颜色一致，
 *  跨工作区 tab 一眼可辨——「上下文甩鞭」的缓解手段之一）。 */
const WORKSPACE_COLORS = [
  "#e05d5d", "#e08b3a", "#c9a227", "#5aa469",
  "#4d9de0", "#7b6ce0", "#b56bb5", "#5aa0a8",
];

function workspaceColor(workspaceId: string): string {
  let hash = 0;
  for (let index = 0; index < workspaceId.length; index += 1) {
    hash = (hash * 31 + workspaceId.charCodeAt(index)) | 0;
  }
  return WORKSPACE_COLORS[Math.abs(hash) % WORKSPACE_COLORS.length];
}

function tabLabel(tab: SessionTabState): string {
  if (tab.kind === "workspace-home") return tab.workspace.name;
  if (tab.kind === "new-session") return "新会话";
  const name = tab.session?.name?.trim();
  if (name) return name;
  const first = tab.session?.firstMessage?.trim();
  return first ? (first.length > 24 ? `${first.slice(0, 24)}…` : first) : "会话";
}

function tabTitle(tab: SessionTabState): string {
  if (tab.kind === "workspace-home") return `${tab.workspace.name}（总览）\n${tab.workspace.path}`;
  if (tab.kind === "new-session") return `新会话\n${tab.workspace.name} · ${tab.workspace.path}`;
  return `${tabLabel(tab)}\n${tab.workspace.name} · ${tab.workspace.path}`;
}

export function SessionTabBar({
  tabs,
  activeTabId,
  workspaces,
  runningIds,
  completedIds,
  workspaceActivity,
  onSelectHome,
  onSelectTab,
  onCloseTab,
  onReorder,
  onNewSession,
  onPickWorkspace,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRect, setPickerRect] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const availableWorkspaces = workspaces.filter(isWorkspaceSelectable);

  useEffect(() => {
    if (!pickerOpen) return;
    const rect = pickerRef.current?.getBoundingClientRect();
    if (rect) {
      setPickerRect(
        computeMenuLayout({ anchor: rect, menuMinWidth: 220, maxMenuHeight: 320 }, readViewportWindow()),
      );
    }
  }, [pickerOpen]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  const reorderBefore = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const next = tabs.map((t) => t.id).filter((id) => id !== draggedId);
    next.splice(next.indexOf(targetId), 0, draggedId);
    onReorder(next);
  };

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label="会话"
      onWheel={(event) => {
        if (!containerRef.current || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        containerRef.current.scrollLeft += event.deltaY;
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!draggedId) return;
        onReorder([...tabs.map((t) => t.id).filter((id) => id !== draggedId), draggedId]);
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
        ref={activeTabId === null ? activeRef : undefined}
        role="tab"
        aria-selected={activeTabId === null}
        onClick={onSelectHome}
        style={tabStyle(activeTabId === null, true)}
      >
        <HomeIcon />
        <span>首页</span>
      </div>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const running = tab.kind === "session" && tab.session
          ? runningIds.has(tab.session.id)
          : false;
        const completed = tab.kind === "session" && tab.session && !active
          ? completedIds.has(tab.session.id)
          : false;
        const workspaceStatus = tab.kind === "workspace-home" ? workspaceActivity[tab.workspace.id] : undefined;
        return (
          <div
            key={tab.id}
            ref={active ? activeRef : undefined}
            role="tab"
            aria-selected={active}
            draggable
            onDragStart={(event) => {
              setDraggedId(tab.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              reorderBefore(tab.id);
              setDraggedId(null);
            }}
            onClick={() => onSelectTab(tab.id)}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onCloseTab(tab.id);
            }}
            title={tabTitle(tab)}
            style={{ ...tabStyle(active), opacity: draggedId === tab.id ? 0.55 : 1 }}
          >
            {(running || completed) && <ActivityIndicator status={running ? "running" : "completed"} />}
            {workspaceStatus && <ActivityIndicator status={workspaceStatus} />}
            <span
              aria-hidden
              title={tab.workspace.name}
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                flexShrink: 0,
                background: workspaceColor(tab.workspace.id),
              }}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {tabLabel(tab)}
            </span>
            <button
              type="button"
              title={`关闭 ${tabLabel(tab)}`}
              aria-label={`关闭 ${tabLabel(tab)}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
              style={{
                width: 26,
                height: 26,
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
      {/* ＋ 在当前 tab 的工作区开新会话 tab（P1：无活动 tab = 首页上下文时隐藏，
          首页有自己的 composer）。 */}
      {activeTabId !== null && (
        <button
          ref={plusRef}
          type="button"
          title="新会话"
          aria-label="新会话"
          onClick={onNewSession}
          style={buttonStyle(false)}
        >
          ＋
        </button>
      )}
      <button
        ref={pickerRef}
        type="button"
        title="打开工作区"
        aria-label="打开工作区"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((open) => !open)}
        style={buttonStyle(pickerOpen)}
      >
        <WorkspaceIcon />
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
              const homeOpen = tabs.some((t) => t.kind === "workspace-home" && t.workspace.id === workspace.id);
              const anyOpen = tabs.some((t) => t.workspace.id === workspace.id);
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
                    background: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 12,
                    fontWeight: 450,
                  }}
                >
                  <span
                    aria-hidden
                    style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: workspaceColor(workspace.id) }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {workspace.name}
                  </span>
                  <ActivityIndicator status={workspaceActivity[workspace.id]} />
                  {anyOpen && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{homeOpen ? "家已开" : "已开"}</span>}
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
    gap: 6,
    minWidth: pinned ? 72 : 110,
    maxWidth: pinned ? 72 : 200,
    height: 36,
    padding: pinned ? "0 12px" : "0 4px 0 10px",
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

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: 0,
    border: 0,
    borderLeft: "1px solid var(--border)",
    background: active ? "var(--bg-hover)" : "transparent",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
  };
}

function ActivityIndicator({ status }: { status: "running" | "completed" | undefined }) {
  if (!status) return null;
  if (status === "running") {
    return (
      <span
        title="会话正在运行"
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
