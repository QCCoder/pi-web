"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { workspaceForSession } from "@/lib/home-quick-switch";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * 本工作区会话列表（2026-09 工作区 tab 菜单化）：拉 /api/sessions 后按工作区
 * 归属过滤（与侧栏 groupSessionsByWorkspace 同语义：cwd 最长前缀归属本工作区；
 * 无归属但 projectRoot 指向本工作区的会话也保留——它们不属于任何其他工作区，
 * 只在这里可见。排除 subagent 子会话），按修改时间降序；
 * 默认前 {@link SESSION_PREVIEW_COUNT} 条 + 「显示全部」展开；行内删除
 * （RecentSessionRow 语义自总览平移）。宿主：移动端工作区 tab 的「会话」子页
 * （全屏，showHeader=false——PanelHeader 已有标题）+ WorkspaceOverview 的
 * 「会话」区块（桌面家 tab 仪表盘）。移动端工作区内找会话的主入口；全局
 * 跨工作区列表住首页/桌面中栏（HomeSessionGroups）。
 */
const SESSION_PREVIEW_COUNT = 20;
/** 总览卡片内嵌模式的默认条数（2026-10 用户反馈：20 条把会话卡撑成一根柱子，
 *  瀑布流里压过所有其它卡）。超出收进「显示全部」。 */
const EMBEDDED_PREVIEW_COUNT = 8;

// ── 展开态窗口化（upstream 5f8f47b 技术移植，共识 #11）────────────────────────
// 行高固定：独立列表 11px 上下 padding + 2px 边框 + 行内最高元素 28px（删除钮）
// = 52px，行距 8 → 节距 60；卡片内嵌（embedded）行 8px 上下 padding + 2px 透明
// 边框 + 28px = 46px，行距 2 → 节距 48（与其它卡片的行密度一致）。只挂载可见
// 窗口 + overscan；焦点行强制保留在窗口内（删除确认两步的行滚出窗口不能丢
// 状态——对应上游 inline rename 的保留）。
const SESSION_ROW_HEIGHT = 52;
const SESSION_ROW_PITCH = SESSION_ROW_HEIGHT + 8;
const EMBEDDED_ROW_HEIGHT = 46;
const EMBEDDED_ROW_PITCH = EMBEDDED_ROW_HEIGHT + 2;
/** 展开但行数不多时窗口化纯属开销，超过该阈值才启用。 */
const WINDOWING_THRESHOLD = 60;

/** 纯函数：给定总数/滚动位置/视口高，返回应挂载的下标（含焦点行钉住）。
 *  pitch = 行节距（独立列表 60 / 卡片内嵌 48）。 */
export function getSessionListIndices(count: number, scrollTop: number, viewportHeight: number, focusedIndex = -1, pitch = SESSION_ROW_PITCH): number[] {
  const overscan = 8;
  const visibleCount = Math.ceil((viewportHeight || 600) / pitch) + overscan * 2;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / pitch) - overscan, count - visibleCount));
  const end = Math.min(count, start + visibleCount);
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end && focusedIndex < count) indices.push(focusedIndex);
  return indices;
}

interface Props {
  workspace: WorkspaceSummary;
  /** 全量可选工作区列表：用于与侧栏一致的最长前缀归属判定（防止嵌套工作区
   *  的会话被本工作区重复计入——侧栏徽标数与总览「会话 N」不一致的根因）。 */
  workspaces: WorkspaceSummary[];
  onSelectSession: (session: SessionInfo) => void;
  onSessionDeleted?: (id: string) => void;
  /** 是否渲染「会话 (N)」小节头（总览区块 true / 移动端全屏子页 false，PanelHeader 已有标题）。 */
  showHeader?: boolean;
  /** 宿主已有的全量会话列表（shell 的 sessionActivity——与侧栏/首页同一份）。
   *  传入 = 不再自拉 /api/sessions（打开总览零额外请求、即时渲染，2026-10
   *  用户反馈「总览会话不秒出」）；缺省 = 组件自拉（独立宿主兜底）。 */
  sessions?: SessionInfo[];
  /** 总览卡片内嵌模式（2026-10 总览瀑布流：会话成为第一张卡）：无外边距、
   *  小节头改为卡片头样式（12.5px muted + 计数 chip）、默认只预览
   *  {@link EMBEDDED_PREVIEW_COUNT} 条（20 条会把卡撑成一根柱子）、行扁平化且
   *  更紧（46px 行 / 48 节距，与其它卡片行密度一致；展开态窗口化按同一组几何
   *  计算）、空态去虚线框。移动端全屏子页不传。 */
  embedded?: boolean;
}

export function WorkspaceSessionList({
  workspace,
  workspaces,
  onSelectSession,
  onSessionDeleted,
  showHeader = true,
  sessions: sessionsFromHost,
  embedded = false,
}: Props) {
  const isMobile = useIsMobile();
  const [fetchedSessions, setFetchedSessions] = useState<SessionInfo[]>([]);
  const [showAllSessions, setShowAllSessions] = useState(false);
  // 展开态窗口化（仅 showAll 且行数超阈值时激活）：内嵌滚动容器 + ResizeObserver
  // 测视口，onScroll 经 rAF 节流更新窗口（upstream 5f8f47b 手法）。
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [listViewportH, setListViewportH] = useState(0);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const listScrollRafRef = useRef<number | null>(null);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    if (listScrollRafRef.current != null) return;
    listScrollRafRef.current = requestAnimationFrame(() => {
      listScrollRafRef.current = null;
      setListScrollTop(top);
    });
  }, []);
  useLayoutEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setListViewportH(entry.contentRect.height);
    });
    ro.observe(el);
    setListViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // 切工作区时重置展开态（宿主也以 key=workspace.id 挂载，这里兜底）。
  useEffect(() => {
    setShowAllSessions(false);
    setHiddenIds(new Set());
  }, [workspace.id]);

  // 删除行的乐观移除：宿主注入模式下不能改宿主数组——本地 hiddenIds 隐藏
  //（宿主 refresh 追上后仍不复活）；自拉模式顺带真删本地列表。
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const handleRowRemoved = useCallback((id: string) => {
    setHiddenIds((prev) => new Set([...prev, id]));
    setFetchedSessions((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // 宿主注入（shell sessionActivity）时零请求；独立宿主兜底自拉。
  const sessions = useMemo(
    () => (sessionsFromHost ?? fetchedSessions).filter((session) => !hiddenIds.has(session.id)),
    [sessionsFromHost, fetchedSessions, hiddenIds],
  );
  useEffect(() => {
    if (sessionsFromHost) return;
    const controller = new AbortController();
    fetch("/api/sessions", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { sessions?: SessionInfo[] };
        setFetchedSessions(data.sessions ?? []);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to load workspace sessions:", error);
        }
      });
    return () => controller.abort();
  }, [workspace.id, sessionsFromHost]);

  const workspaceSessions = useMemo(() => {
    const path = workspace.path;
    return sessions
      .filter((session) => {
        if (session.subagentChild) return false;
        const owner = workspaceForSession(session, workspaces);
        // 与侧栏同归属；无主会话退回 projectRoot 命中（否则这类会话在任何
        // 工作区都看不到）。
        if (owner) return owner.id === workspace.id;
        return session.projectRoot === path;
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }, [sessions, workspaces, workspace.id, workspace.path]);
  const previewCount = embedded ? EMBEDDED_PREVIEW_COUNT : SESSION_PREVIEW_COUNT;

  return (
    <section style={{ marginTop: embedded ? 0 : 26 }}>
      {showHeader && (embedded ? (
        <h2
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: 0,
            padding: "8px 10px 6px",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--text-muted)",
            userSelect: "none",
          }}
        >
          会话
          <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--text-dim)", background: "var(--bg-hover)", borderRadius: 999, padding: "1px 7px" }}>
            {workspaceSessions.length}
          </span>
        </h2>
      ) : (
        <h2
          style={{
            margin: "0 0 12px",
            fontSize: 15,
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          会话
          <span style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 400 }}>{workspaceSessions.length}</span>
        </h2>
      ))}
      {workspaceSessions.length === 0 ? (
        embedded ? (
          <div style={{ padding: "18px 10px 14px", textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
            还没有会话。点击「新建会话」开始。
          </div>
        ) : (
          <div
            style={{
              padding: "22px 16px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 13,
              border: "1px dashed var(--border)",
              borderRadius: 10,
            }}
          >
            还没有会话。点击「新建会话」开始。
          </div>
        )
      ) : (
        <div>
          {(() => {
            // 窗口化仅展开态 + 行数超阈值时激活（共识 #11-i：默认预览零改动）。
            // 行几何按宿主形态取：内嵌卡片行更紧（EMBEDDED_*）。
            const rowHeight = embedded ? EMBEDDED_ROW_HEIGHT : SESSION_ROW_HEIGHT;
            const rowPitch = embedded ? EMBEDDED_ROW_PITCH : SESSION_ROW_PITCH;
            if (showAllSessions && workspaceSessions.length > WINDOWING_THRESHOLD) {
              const virtualIndices = getSessionListIndices(
                workspaceSessions.length,
                listScrollTop,
                listViewportH,
                workspaceSessions.findIndex((session) => session.id === focusedSessionId),
                rowPitch,
              );
              return (
                <div
                  ref={listScrollRef}
                  onScroll={handleListScroll}
                  style={{ overflowY: "auto", maxHeight: "min(70vh, 640px)" }}
                >
                  <div style={{ position: "relative", height: workspaceSessions.length * rowPitch }}>
                    {virtualIndices.map((index) => {
                      const session = workspaceSessions[index];
                      return (
                        <div
                          key={session.id}
                          onFocus={() => setFocusedSessionId(session.id)}
                          onBlur={() => setFocusedSessionId(null)}
                          style={{ position: "absolute", top: index * rowPitch, left: 0, right: 0, height: rowHeight }}
                        >
                          <RecentSessionRow
                            session={session}
                            isMobile={isMobile}
                            flat={embedded}
                            onOpen={() => onSelectSession(session)}
                            onRemoved={handleRowRemoved}
                            onDeleted={onSessionDeleted}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (showAllSessions ? workspaceSessions : workspaceSessions.slice(0, previewCount)).map((session) => (
              <RecentSessionRow
                key={session.id}
                session={session}
                isMobile={isMobile}
                flat={embedded}
                onOpen={() => onSelectSession(session)}
                onRemoved={handleRowRemoved}
                onDeleted={onSessionDeleted}
              />
            ));
          })()}
          {!showAllSessions && workspaceSessions.length > previewCount && (
            <button
              onClick={() => setShowAllSessions(true)}
              style={{
                border: 0,
                background: "transparent",
                color: "var(--accent)",
                cursor: "pointer",
                padding: "4px 8px",
                margin: "4px 2px",
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              显示全部 {workspaceSessions.length} 个会话
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "刚刚"; // clock skew / future
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天`;
  return new Date(dateStr).toLocaleDateString();
}

function RecentSessionRow({
  session,
  isMobile,
  flat = false,
  onOpen,
  onRemoved,
  onDeleted,
}: {
  session: SessionInfo;
  isMobile: boolean;
  /** 扁平行（总览卡片内嵌）：边框透明保住几何、底色透明、hover 才上色。 */
  flat?: boolean;
  onOpen: () => void;
  onRemoved: (id: string) => void;
  onDeleted?: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const title = session.name || session.firstMessage || "未命名会话";

  const performDelete = async () => {
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
      });
      if (response.ok) {
        onRemoved(session.id);
        onDeleted?.(session.id);
      }
    } catch {
      // ignore network errors — row stays, user can retry
    }
    setDeleting(false);
    setConfirming(false);
  };

  const showDelete = isMobile || hovered || confirming;

  return (
    <div
      role="button"
      tabIndex={confirming ? -1 : 0}
      onClick={confirming ? undefined : onOpen}
      onKeyDown={(e) => {
        if (!confirming && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: flat ? "8px 10px" : "11px 12px",
        marginBottom: flat ? 2 : 8,
        border: flat ? "1px solid transparent" : "1px solid var(--border)",
        borderRadius: flat ? 8 : 10,
        background: hovered && !confirming
          ? "var(--bg-hover)"
          : (flat ? "transparent" : "var(--bg-panel)"),
        cursor: confirming ? "default" : "pointer",
        transition: "background 0.12s",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: flat ? 12.5 : 13,
          color: "var(--text)",
        }}
      >
        {title}
      </span>

      {confirming ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>确认删除？</span>
          <button
            onClick={performDelete}
            disabled={deleting}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              border: "1px solid rgba(239,68,68,0.4)",
              borderRadius: 6,
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              cursor: deleting ? "not-allowed" : "pointer",
            }}
          >
            删除
          </button>
          <button
            onClick={() => setConfirming(false)}
            disabled={deleting}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: deleting ? "not-allowed" : "pointer",
            }}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {formatRelativeTime(session.modified)} · {session.messageCount} 条
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            aria-label="删除会话"
            title="删除会话"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              flexShrink: 0,
              border: "none",
              borderRadius: 7,
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              opacity: showDelete ? 1 : 0,
              transition: "opacity 0.12s, color 0.12s",
              pointerEvents: showDelete ? "auto" : "none",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
