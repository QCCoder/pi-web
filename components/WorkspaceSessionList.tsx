"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * 本工作区会话列表（2026-09 工作区 tab 菜单化）：拉 /api/sessions 后按工作区
 * 前缀过滤（cwd/projectRoot 命中、排除 subagent 子会话），按修改时间降序；
 * 默认前 {@link SESSION_PREVIEW_COUNT} 条 + 「显示全部」展开；行内删除
 * （RecentSessionRow 语义自总览平移）。宿主：移动端工作区 tab 的「会话」子页
 * （全屏，showHeader=false——PanelHeader 已有标题）+ WorkspaceOverview 的
 * 「会话」区块（桌面家 tab 仪表盘）。移动端工作区内找会话的主入口；全局
 * 跨工作区列表住首页/桌面中栏（HomeSessionGroups）。
 */
const SESSION_PREVIEW_COUNT = 20;

interface Props {
  workspace: WorkspaceSummary;
  onSelectSession: (session: SessionInfo) => void;
  onSessionDeleted?: (id: string) => void;
  /** 是否渲染「会话 (N)」小节头（总览区块 true / 移动端全屏子页 false，PanelHeader 已有标题）。 */
  showHeader?: boolean;
}

export function WorkspaceSessionList({
  workspace,
  onSelectSession,
  onSessionDeleted,
  showHeader = true,
}: Props) {
  const isMobile = useIsMobile();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [showAllSessions, setShowAllSessions] = useState(false);
  // 切工作区时重置展开态（宿主也以 key=workspace.id 挂载，这里兜底）。
  useEffect(() => {
    setShowAllSessions(false);
  }, [workspace.id]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/sessions", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { sessions?: SessionInfo[] };
        setSessions(data.sessions ?? []);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to load workspace sessions:", error);
        }
      });
    return () => controller.abort();
  }, [workspace.id]);

  const wsPath = workspace.path.replace(/\/+$/, "");
  const workspaceSessions = useMemo(() => {
    const path = workspace.path;
    const prefix = `${wsPath}/`;
    return sessions
      .filter((session) =>
        !session.subagentChild
        && (
          session.cwd === path
          || session.cwd.startsWith(prefix)
          || session.projectRoot === path
        ),
      )
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }, [sessions, wsPath, workspace.path]);

  return (
    <section style={{ marginTop: 26 }}>
      {showHeader && (
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
      )}
      {workspaceSessions.length === 0 ? (
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
      ) : (
        <div>
          {(showAllSessions ? workspaceSessions : workspaceSessions.slice(0, SESSION_PREVIEW_COUNT)).map((session) => (
            <RecentSessionRow
              key={session.id}
              session={session}
              isMobile={isMobile}
              onOpen={() => onSelectSession(session)}
              onRemoved={(id) => setSessions((prev) => prev.filter((item) => item.id !== id))}
              onDeleted={onSessionDeleted}
            />
          ))}
          {!showAllSessions && workspaceSessions.length > SESSION_PREVIEW_COUNT && (
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
  onOpen,
  onRemoved,
  onDeleted,
}: {
  session: SessionInfo;
  isMobile: boolean;
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
        padding: "11px 12px",
        marginBottom: 8,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: hovered && !confirming ? "var(--bg-hover)" : "var(--bg-panel)",
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
          fontSize: 13,
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
