"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkItemRecord, WorkItemType } from "@/lib/work-items/types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";
import { useIsMobile } from "@/hooks/useIsMobile";

interface Props {
  workspace: WorkspaceSummary;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenWorkItems: () => void;
  onCreateWorkItem: (type: WorkItemType) => void;
  onSelectSession: (session: SessionInfo) => void;
  onSessionDeleted?: (id: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "刚刚"; // clock skew / future
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString();
}

export function WorkspaceOverview({
  workspace,
  onNewSession,
  onOpenSettings,
  onOpenWorkItems,
  onCreateWorkItem,
  onSelectSession,
  onSessionDeleted,
}: Props) {
  const isMobile = useIsMobile();
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/work-items`, {
        signal: controller.signal,
      }),
      fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories`, {
        signal: controller.signal,
      }),
      fetch("/api/sessions", { signal: controller.signal }),
    ]).then(async ([itemsResponse, repositoriesResponse, sessionsResponse]) => {
      if (itemsResponse.ok) {
        const data = await itemsResponse.json() as { items?: WorkItemRecord[] };
        setWorkItems(data.items ?? []);
      }
      if (repositoriesResponse.ok) {
        const data = await repositoriesResponse.json() as {
          repositories?: WorkspaceRepositoryState[];
        };
        setRepositories(data.repositories ?? []);
      }
      if (sessionsResponse.ok) {
        const data = await sessionsResponse.json() as { sessions?: SessionInfo[] };
        setSessions(data.sessions ?? []);
      }
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("Failed to load workspace overview:", error);
      }
    });
    return () => controller.abort();
  }, [workspace.id]);

  const wsPath = workspace.path.replace(/\/+$/, "");
  const recentSessions = useMemo(() => {
    const path = workspace.path;
    const prefix = `${wsPath}/`;
    return sessions
      .filter((session) =>
        !session.subagentChild
        && !session.loopOrchestrator
        && (
          session.cwd === path
          || session.cwd.startsWith(prefix)
          || session.projectRoot === path
        ),
      )
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, 5);
  }, [sessions, wsPath, workspace.path]);

  const activeWorkItems = workItems.filter((item) => !item.archivedAt);
  const openItems = activeWorkItems.filter(
    (item) => item.status !== "done" && item.status !== "cancelled",
  );
  const activeRepositories = repositories.filter((repository) => repository.status === "active");

  return (
    <main
      aria-label={`${workspace.name} overview`}
      style={{ height: "100%", overflow: "auto", padding: "clamp(20px, 4vw, 48px)" }}
    >
      <div style={{ width: "min(860px, 100%)", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.08em" }}>WORKSPACE</div>
            <h1 style={{ margin: "6px 0 4px", fontSize: 24, color: "var(--text)" }}>{workspace.name}</h1>
            <code style={{ color: "var(--text-muted)", fontSize: 11 }}>{workspace.path}</code>
          </div>
          <button className="workspace-action" onClick={onOpenSettings}>工作区设置</button>
        </div>

        {/* Compact stat strip */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 8,
            marginTop: 22,
          }}
        >
          <StatCard
            label="待处理工作项"
            value={String(openItems.length)}
            detail={`${activeWorkItems.filter((item) => item.type === "requirement").length} 需求 · ${activeWorkItems.filter((item) => item.type === "bug").length} Bug`}
            onClick={onOpenWorkItems}
          />
          <StatCard
            label="Repositories"
            value={String(activeRepositories.length)}
            detail={`${activeRepositories.filter((repository) => repository.kind === "code").length} code · ${activeRepositories.filter((repository) => repository.kind === "knowledge").length} knowledge`}
            onClick={onOpenSettings}
          />
          <StatCard
            label="Skills"
            value={String(workspace.skills.length)}
            detail={workspace.skills.length > 0 ? workspace.skills.join(" · ") : "尚未选择技能"}
            onClick={onOpenSettings}
          />
        </div>

        {/* Quick actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            onClick={onNewSession}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "14px 16px",
              border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
              borderRadius: 10,
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              color: "var(--accent)",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新建会话
          </button>
          {workspace.capabilities.includes("work-items") && (
            <button
              onClick={() => onCreateWorkItem("requirement")}
              style={{
                flex: "0 0 auto",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "14px 16px",
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              新建工作项
            </button>
          )}
        </div>

        {/* Recent sessions */}
        <section style={{ marginTop: 28 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 15, color: "var(--text)" }}>最近会话</h2>
          {recentSessions.length === 0 ? (
            <div
              style={{
                padding: "28px 16px",
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 13,
                border: "1px dashed var(--border)",
                borderRadius: 10,
              }}
            >
              还没有会话。点击上方「新建会话」开始。
            </div>
          ) : (
            <div>
              {recentSessions.map((session) => (
                <RecentSessionRow
                  key={session.id}
                  session={session}
                  isMobile={isMobile}
                  onOpen={() => onSelectSession(session)}
                  onRemoved={(id) => setSessions((prev) => prev.filter((item) => item.id !== id))}
                  onDeleted={onSessionDeleted}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  detail,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-panel)",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{label}</span>
      <strong style={{ fontSize: 18, lineHeight: 1.1 }}>{value}</strong>
      <span
        style={{
          color: "var(--text-dim)",
          fontSize: 10,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {detail}
      </span>
    </button>
  );
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
