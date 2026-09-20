"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { groupSessionsByWorkspace } from "@/lib/home-quick-switch";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { computeMenuLayout, readViewportWindow, type MenuLayout } from "@/lib/dropdown-layout";
import type { CenterPage } from "./shell/useAppShellState";
import { SessionRow } from "./SessionRow";

/**
 * 项目树侧栏（2026-09 grill 共识：左侧 = 单一树形侧栏，取代图标栏 + 中栏
 * 面板两件套）。结构：
 *
 *   [＋ 新建任务]           ← 新会话 composer 入口（复用现有行为）；折叠
 *                          由 ChatToolbar 的 ☰ 开关承担（不在侧栏内）
 *   工作区           ＋    ← 分区标题（与新建任务左对齐）；＋ → 新建/导入
 *   📂 pi     🏠 🗑      ← 节点（缩进一级）：整行 = 展开/折叠；hover 右侧
 *                           出现 工作区首页/归档 两个快捷按钮
 *      · 会话行…（默认 5 条，更多收进「显示更多」）
 *   …不可用工作区（暗淡）
 *   ─────────────────
 *   设置 模型 插件 Skills  ← 底部四入口（全局配置心智）→ 中央区整页
 *
 * 作用域即位置：树 = 工作区资源（会话/归档），底部 = 全局配置入口（打开时
 * 可带工作区上下文）。工作项/Loops/知识库/文件不进树（右坞 + 总览 hub 不变）。
 * 折叠状态（哪些工作区节点收起）持久化在 localStorage。
 */

const COLLAPSED_KEY = "pi-tree-collapsed";

/** 会话列表每组默认展示条数；超出收进「显示更多」（会话内临时展开，不持久化）。 */
const SESSION_PREVIEW_COUNT = 5;

interface Props {
  workspaces: WorkspaceSummary[];
  allSessions: SessionInfo[];
  runningSessionIds: Set<string>;
  completedSessionIds: Set<string>;
  selectedSessionId: string | null;
  /** 当前打开的中央区整页（底部入口高亮）。 */
  centerPage: CenterPage | null;
  /** 方案二骨架门控：未加载时渲染骨架，不渲染假空态。 */
  workspacesLoaded: boolean;
  sessionsLoaded: boolean;
  onNewSession: () => void;
  /** 节点行 hover 的「工作区首页」按钮 → 开/激活该工作区总览（家 tab）。 */
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
  /** 节点行 hover 的「归档」按钮 → 中央区归档页（工作区作用域就地）。 */
  onOpenArchive: (workspace: WorkspaceSummary) => void;
  onSelectSession: (session: SessionInfo) => void;
  onOpenSessionInNewTab: (session: SessionInfo) => void;
  onSessionRemoved: (id: string) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onOpenCenterPage: (page: CenterPage) => void;
  /** 工作区级聚合活动（running/completed）——节点上的状态点。 */
  workspaceActivity: Record<string, "running" | "completed" | undefined>;
}

/** 底部四入口图标（原 ActivityBar 图标常量迁移；sidebar 底部一条 strip）。 */
const BOTTOM_ENTRIES: {
  kind: "settings" | "models" | "skills" | "plugins";
  label: string;
  title: string;
  icon: React.ReactNode;
}[] = [
  {
    kind: "settings",
    label: "设置",
    title: "设置",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    kind: "models",
    label: "模型",
    title: "模型（models.json）",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2" />
        <path d="M15 20v2" />
        <path d="M9 2v2" />
        <path d="M9 20v2" />
        <path d="M2 15h2" />
        <path d="M2 9h2" />
        <path d="M20 15h2" />
        <path d="M20 9h2" />
      </svg>
    ),
  },
  {
    kind: "skills",
    label: "Skills",
    title: "Skills",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      </svg>
    ),
  },
  {
    kind: "plugins",
    label: "插件",
    title: "插件",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
      </svg>
    ),
  },
];

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function ProjectSidebar({
  workspaces,
  allSessions,
  runningSessionIds,
  completedSessionIds,
  selectedSessionId,
  centerPage,
  workspacesLoaded,
  sessionsLoaded,
  onNewSession,
  onOpenWorkspace,
  onOpenArchive,
  onSelectSession,
  onOpenSessionInNewTab,
  onSessionRemoved,
  onCreateWorkspace,
  onImportDirectory,
  onOpenCenterPage,
  workspaceActivity,
}: Props) {
  // 折叠状态：SSR 先空（服务端无 localStorage），挂载后读取持久化值——避免
  // 服务端/客户端首帧不一致的 hydration mismatch（同 sidebarWidth 的模式）。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setCollapsed(loadCollapsed());
    setHydrated(true);
  }, []);
  const persistCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    if (!hydrated) setHydrated(true);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
  };
  const toggleGroup = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    persistCollapsed(next);
  };

  // ＋ 菜单（新建工作区 / 导入目录）——body-portal，computeMenuLayout 钳进可视区。
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [plusRect, setPlusRect] = useState<MenuLayout | null>(null);
  // 「显示更多」展开的工作区（会话内临时态，不持久化）。
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!plusOpen) return;
    const rect = plusRef.current?.getBoundingClientRect();
    if (rect) {
      setPlusRect(computeMenuLayout({ anchor: rect, menuMinWidth: 170, maxMenuHeight: 200 }, readViewportWindow()));
    }
  }, [plusOpen]);

  const groups = groupSessionsByWorkspace(workspaces, allSessions);
  const unavailableWorkspaces = workspaces.filter((workspace) => !workspace.available);

  const renderBody = () => {
    // 骨架门控：未加载时绝不渲染「尚无工作区」假空态。
    if (!workspacesLoaded || !sessionsLoaded) {
      return (
        <div style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 14, height: 14, borderRadius: 4, background: "var(--bg-hover)", flexShrink: 0 }} />
              <span style={{ height: 10, flex: 1, borderRadius: 5, background: "var(--bg-hover)", opacity: 1 - i * 0.25 }} />
            </div>
          ))}
        </div>
      );
    }
    if (groups.length === 0 && unavailableWorkspaces.length === 0) {
      return (
        <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
          尚无工作区——点右上 ＋ 新建或导入。
        </div>
      );
    }
    return (
      <div style={{ padding: "4px 8px 12px" }}>
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.workspace.id);
          const activity = workspaceActivity[group.workspace.id];
          return (
            <section key={group.workspace.id} style={{ marginBottom: 4 }}>
              {/* 工作区节点（不选中高亮——树只是组织结构，选中的是会话）：
                  整行 = 展开/折叠开关；hover 时右侧出现 工作区首页/归档 两个
                  快捷按钮（取代徽章/计数，SessionRow 同款模式）。左缩进一级。 */}
              <div style={{ paddingLeft: 8 }}>
                <WorkspaceNodeRow
                  workspace={group.workspace}
                  sessionCount={group.sessions.length}
                  isCollapsed={isCollapsed}
                  activity={activity}
                  onToggle={() => toggleGroup(group.workspace.id)}
                  onOpenHome={onOpenWorkspace}
                  onOpenArchive={onOpenArchive}
                />
              </div>

              {!isCollapsed && (
                <div style={{ paddingLeft: 8 }}>
                  {group.sessions.length === 0 ? (
                    <div style={{ padding: "4px 10px 4px 14px", color: "var(--text-dim)", fontSize: 11 }}>
                      暂无会话
                    </div>
                  ) : (
                    <>
                      {(expandedGroups.has(group.workspace.id)
                        ? group.sessions
                        : group.sessions.slice(0, SESSION_PREVIEW_COUNT)
                      ).map((session) => {
                        const sessActivity = runningSessionIds.has(session.id)
                          ? "running"
                          : completedSessionIds.has(session.id)
                            ? "completed"
                            : undefined;
                        return (
                          <SessionRow
                            key={session.id}
                            session={session}
                            isSelected={selectedSessionId === session.id}
                            activity={sessActivity}
                            showTime
                            rounded
                            onSelect={() => onSelectSession(session)}
                            onOpenInNewTab={() => onOpenSessionInNewTab(session)}
                            onRemoved={onSessionRemoved}
                          />
                        );
                      })}
                      {group.sessions.length > SESSION_PREVIEW_COUNT && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedGroups((prev) => new Set([...prev, group.workspace.id]))
                          }
                          title={`展开全部 ${group.sessions.length} 条会话`}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "5px 12px 5px 22px",
                            border: 0,
                            borderRadius: 6,
                            background: "transparent",
                            color: "var(--text-dim)",
                            cursor: "pointer",
                            fontSize: 11.5,
                            textAlign: "left",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                            <circle cx="12" cy="5" r="1" />
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="12" cy="19" r="1" />
                          </svg>
                          显示更多（共 {group.sessions.length}）
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {unavailableWorkspaces.map((workspace) => (
          <div
            key={workspace.id}
            style={{
              display: "grid",
              gap: 2,
              padding: "8px 10px",
              marginBottom: 4,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              opacity: 0.6,
            }}
          >
            <strong style={{ fontSize: "var(--pi-sidebar-fs)", color: "var(--text-muted)" }}>{workspace.name}</strong>
            <span style={{ fontSize: "var(--pi-sidebar-fs-meta)", color: "var(--text-dim)" }}>
              目录或配置不可用
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 顶部：新建任务 + 折叠 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 8px 6px", flexShrink: 0 }}>
        <button
          type="button"
          onClick={onNewSession}
          title="新建任务（新会话）"
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "7px 10px",
            border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
            borderRadius: 8,
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            color: "var(--accent)",
            fontWeight: 700,
            cursor: "pointer",
            fontSize: 12.5,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建任务
        </button>
      </div>

      {/* 分区标题：工作区 + ＋（新建工作区 / 导入目录）——标题左缩进对齐
          节点名称（文件夹图标右侧），整体往右。 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px 2px 8px",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", userSelect: "none" }}>工作区</span>
        <button
          ref={plusRef}
          type="button"
          title="新建 / 导入工作区"
          aria-haspopup="menu"
          aria-expanded={plusOpen}
          onClick={() => setPlusOpen((open) => !open)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            padding: 0,
            border: 0,
            borderRadius: 5,
            background: plusOpen ? "var(--bg-hover)" : "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ＋
        </button>
      </div>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>{renderBody()}</div>

      {/* 底部四入口：设置 / 模型 / 插件 / Skills（全局配置心智，打开 = 中央区
          整页）。圆角按钮 + 内缩，hover/选中有圆角底。 */}
      <div
        role="tablist"
        aria-label="全局配置"
        style={{
          display: "flex",
          gap: 2,
          padding: "6px 8px calc(6px + env(safe-area-inset-bottom, 0px))",
          flexShrink: 0,
          borderTop: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        {BOTTOM_ENTRIES.map((entry) => {
          const active = centerPage?.kind === entry.kind;
          return (
            <button
              key={entry.kind}
              type="button"
              role="tab"
              aria-selected={active}
              title={entry.title}
              aria-label={entry.label}
              onClick={() => onOpenCenterPage({ kind: entry.kind })}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
                height: 44,
                padding: 0,
                border: 0,
                borderRadius: 8,
                background: active ? "var(--bg-selected)" : "transparent",
                color: active ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                position: "relative",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
            >
              {active && (
                <span aria-hidden style={{ position: "absolute", top: 6, left: 14, right: 14, height: 2, borderRadius: 1, background: "var(--accent)" }} />
              )}
              {entry.icon}
              <span style={{ fontSize: 10, lineHeight: 1 }}>{entry.label}</span>
            </button>
          );
        })}
      </div>

      {plusOpen && plusRect && createPortal(
        <>
          <div aria-hidden="true" onClick={() => setPlusOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 2000 }} />
          <div
            role="menu"
            aria-label="工作区"
            style={{
              position: "fixed",
              top: plusRect.top,
              right: plusRect.right,
              zIndex: 2001,
              minWidth: 170,
              padding: 4,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => { setPlusOpen(false); onCreateWorkspace(); }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "7px 9px",
                border: 0,
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                textAlign: "left",
              }}
            >
              新建工作区…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setPlusOpen(false); onImportDirectory(); }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "7px 9px",
                border: 0,
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                textAlign: "left",
              }}
            >
              导入目录…
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** 工作区节点行：整行点击 = 展开/折叠（文件夹开/合两态）；hover 时右侧出现
 *  工作区首页（🏠 开/激活总览家 tab）与 归档（回收站，中央区整页）两个快捷
 *  按钮（取代徽章/计数，SessionRow 的 hover-action 同款模式；两按钮
 *  stopPropagation，不触发折叠）。 */
function WorkspaceNodeRow({
  workspace,
  sessionCount,
  isCollapsed,
  activity,
  onToggle,
  onOpenHome,
  onOpenArchive,
}: {
  workspace: WorkspaceSummary;
  sessionCount: number;
  isCollapsed: boolean;
  activity: "running" | "completed" | undefined;
  onToggle: () => void;
  onOpenHome: (workspace: WorkspaceSummary) => void;
  onOpenArchive: (workspace: WorkspaceSummary) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-label={isCollapsed ? "展开会话" : "折叠会话"}
      aria-expanded={!isCollapsed}
      onClick={onToggle}
      title={`${workspace.name}（${isCollapsed ? "展开" : "折叠"}会话列表）`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 6px 5px 2px",
        border: 0,
        borderRadius: 8,
        background: hovered ? "var(--bg-hover)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      {isCollapsed ? (
        /* 合上的文件夹 */
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", flexShrink: 0, color: "var(--accent)" }}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      ) : (
        /* 打开的文件夹 */
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", flexShrink: 0, color: "var(--accent)" }}>
          <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
        </svg>
      )}
      <strong style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {workspace.name}
      </strong>
      {hovered ? (
        <span style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <span
            role="button"
            tabIndex={0}
            title={`工作区首页（${workspace.name} 总览）`}
            aria-label={`工作区首页（${workspace.name}）`}
            onClick={(e) => { e.stopPropagation(); onOpenHome(workspace); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onOpenHome(workspace); } }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 6,
              background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
            </svg>
          </span>
          <span
            role="button"
            tabIndex={0}
            title={`归档（${workspace.name} 回收站）`}
            aria-label={`归档（${workspace.name}）`}
            onClick={(e) => { e.stopPropagation(); onOpenArchive(workspace); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onOpenArchive(workspace); } }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 6,
              background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </span>
        </span>
      ) : (
        <>
          {activity === "running" && (
            <span title="工作区有会话正在运行" style={{ display: "inline-flex", flexShrink: 0, color: "var(--text)" }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
                <g>
                  <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                </g>
              </svg>
            </span>
          )}
          {activity === "completed" && (
            <span title="工作区有会话已完成" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: "var(--accent)" }} />
          )}
          <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)" }}>
            {sessionCount}
          </span>
        </>
      )}
    </button>
  );
}
