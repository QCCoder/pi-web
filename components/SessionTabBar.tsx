"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeMenuLayout, readViewportWindow } from "@/lib/dropdown-layout";
import { contextCloseTargetIds, type SessionTabState } from "@/lib/session-tabs";

/**
 * 会话 tab 条（docs/session-tabs-design.md Phase 1）：顶栏 tab = 会话/占位/
 * 工作区家 tab，跨工作区混排（工作区色点标识）。替换旧的 WorkspaceTabBar，
 * 桌面/移动两 shell 共用（无 isMobile 分支——移动端就是一排可横滚的紧凑 chips）。
 *
 * 右端按钮区（P1）：＋ = 在当前 tab 的工作区开新会话 tab（无活动 tab 时隐藏——
 * 首页有自己的 composer）。⊞ 工作区选择器已删除（2026-09 移动端反馈：
 * tab 条只留 chips + ＋；工作区切换走 设置›工作区，桌面走项目树）；「首页」
 * chip 桌面保留、移动端经 showHomeTab=false 退役（移动端的家 tab 即首页，
 * MobileShell 空态自动落回家 tab）。
 *
 * 右键菜单（桌面主路径；移动端无 isMobile 分支——Android 长按若触发
 * contextmenu 事件同样受益）：关闭 / 关闭其他 / 关闭左侧 / 关闭右侧。
 * 目标集合由纯函数 contextCloseTargetIds 计算；草稿合并确认在
 * useAppShellState.closeTabs。定位复用 computeMenuLayout（锚 = tab chip
 * 本身，与 ⊞ 选择器同一套 portal + 遮罩关闭模式）。
 */

interface Props {
  tabs: SessionTabState[];
  activeTabId: string | null;
  /** 全局 running 集会话级徽章，无需每会话 SSE（M1）。 */
  runningIds: ReadonlySet<string>;
  completedIds: ReadonlySet<string>;
  /** 家 tab 上的工作区级聚合活动（沿用旧 tab 条的 ActivityIndicator）。 */
  workspaceActivity: Record<string, "running" | "completed" | undefined>;
  /** 「首页」chip 是否渲染：桌面保留（首页 composer 页的锚点）；移动端
   *  退役（2026-09：家 tab 即首页，空态由 MobileShell 自动落回家 tab）。 */
  showHomeTab?: boolean;
  onSelectHome: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** 右键菜单批量关闭（关闭其他/左侧/右侧）：目标 id 集合（不含锚 tab）。 */
  onCloseTabs: (ids: string[]) => void;
  onReorder: (ids: string[]) => void;
  onNewSession: () => void;
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
  runningIds,
  completedIds,
  workspaceActivity,
  showHomeTab = true,
  onSelectHome,
  onSelectTab,
  onCloseTab,
  onCloseTabs,
  onReorder,
  onNewSession,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tabId: string; anchor: DOMRect } | null>(null);
  const [ctxRect, setCtxRect] = useState<{ top: number; right: number; maxHeight: number } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    setCtxRect(computeMenuLayout({ anchor: ctxMenu.anchor, menuMinWidth: 160, maxMenuHeight: 240 }, readViewportWindow()));
  }, [ctxMenu]);

  // Escape 关右键菜单（遮罩已经接管点击关闭）。
  useEffect(() => {
    if (!ctxMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ctxMenu]);

  const menuTabIndex = ctxMenu ? tabs.findIndex((t) => t.id === ctxMenu.tabId) : -1;
  const ctxTargets = (mode: "others" | "left" | "right") =>
    menuTabIndex === -1 ? [] : contextCloseTargetIds(tabs, ctxMenu!.tabId, mode);
  const runCtxClose = (ids: string[]) => {
    setCtxMenu(null);
    if (ids.length > 0) onCloseTabs(ids);
  };

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
      className="hide-scrollbar"
      role="tablist"
      aria-label="会话"
      onWheel={(event) => {
        if (ctxMenu) setCtxMenu(null);
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
        scrollPaddingRight: 36,
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {showHomeTab && (
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
      )}
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
              setCtxMenu(null);
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
            onContextMenu={(event) => {
              event.preventDefault();
              setCtxMenu({ tabId: tab.id, anchor: event.currentTarget.getBoundingClientRect() });
            }}
            title={tabTitle(tab)}
            style={{ ...tabStyle(active), opacity: draggedId === tab.id ? 0.55 : 1 }}
          >
            {(running || completed) && <ActivityIndicator status={running ? "running" : "completed"} />}
            {workspaceStatus && <ActivityIndicator status={workspaceStatus} />}
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
          首页有自己的 composer）。sticky right：tab 多到溢出时吸附在条的最右
          （不透明背景，chips 从底下滚过），不溢出时紧跟最后一个 tab。 */}
      {activeTabId !== null && (
        <button
          type="button"
          title="新会话"
          aria-label="新会话"
          onClick={onNewSession}
          style={{
            ...buttonStyle(false),
            position: "sticky",
            right: 0,
            zIndex: 1,
            background: "var(--bg-panel)",
          }}
        >
          ＋
        </button>
      )}
      {ctxMenu && ctxRect && createPortal(
        <>
          <div
            aria-hidden="true"
            onContextMenu={(event) => event.preventDefault()}
            onClick={() => setCtxMenu(null)}
            style={{ position: "fixed", inset: 0, zIndex: 2000 }}
          />
          <div
            role="menu"
            aria-label="tab 操作"
            style={{
              position: "fixed",
              top: ctxRect.top,
              right: ctxRect.right,
              zIndex: 2001,
              minWidth: 160,
              padding: 4,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
            }}
          >
            <ContextMenuItem label="关闭" hint="中键" onClick={() => { const id = ctxMenu.tabId; setCtxMenu(null); onCloseTab(id); }} />
            <ContextMenuItem
              label="关闭其他"
              disabled={ctxTargets("others").length === 0}
              onClick={() => runCtxClose(ctxTargets("others"))}
            />
            <ContextMenuItem
              label="关闭左侧"
              disabled={ctxTargets("left").length === 0}
              onClick={() => runCtxClose(ctxTargets("left"))}
            />
            <ContextMenuItem
              label="关闭右侧"
              disabled={ctxTargets("right").length === 0}
              onClick={() => runCtxClose(ctxTargets("right"))}
            />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function ContextMenuItem({ label, hint, disabled, onClick }: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 12,
        justifyContent: "space-between",
        minHeight: 32,
        padding: "6px 10px",
        border: 0,
        borderRadius: 6,
        background: "transparent",
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
        fontSize: 12,
        fontWeight: 450,
      }}
    >
      <span>{label}</span>
      {hint && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{hint}</span>}
    </button>
  );
}

function tabStyle(active: boolean, pinned = false): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: pinned ? 72 : 140,
    maxWidth: pinned ? 72 : 140,
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
