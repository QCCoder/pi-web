"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

interface Props {
  workspaces: WorkspaceSummary[];
  refreshKey: number;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onSelectSession: (session: SessionInfo) => void;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 0) return "刚刚";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString();
}

function workspaceForSession(session: SessionInfo, workspaces: WorkspaceSummary[]): WorkspaceSummary | undefined {
  return workspaces
    .filter((workspace) => {
      const prefix = `${workspace.path.replace(/\/+$/, "")}/`;
      return workspace.available && (session.cwd === workspace.path || session.cwd.startsWith(prefix));
    })
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export function HomeLanding({
  workspaces,
  refreshKey,
  onSelectWorkspace,
  onCreateWorkspace,
  onImportDirectory,
  onSelectSession,
}: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/sessions", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { sessions?: SessionInfo[] };
        setSessions(data.sessions ?? []);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to load sessions for home:", error);
        }
      });
    return () => controller.abort();
  }, [refreshKey]);

  const availableWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.available),
    [workspaces],
  );

  const recentSessions = useMemo(() => {
    return sessions
      .filter((session) => !session.subagentChild && workspaceForSession(session, workspaces))
      .sort((left, right) => right.modified.localeCompare(left.modified))
      .slice(0, 5);
  }, [sessions, workspaces]);

  return (
    <main
      aria-label="Pi Web 首页"
      style={{ height: "100%", overflow: "auto", padding: "clamp(24px, 5vw, 56px)" }}
    >
      <div style={{ width: "min(960px, 100%)", margin: "0 auto" }}>
        {/* Hero */}
        <div style={{ textAlign: "center", padding: "clamp(16px, 4vw, 40px) 0 8px" }}>
          <div
            aria-hidden="true"
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 16px",
              borderRadius: 16,
              background: "color-mix(in srgb, var(--accent) 14%, var(--bg-panel))",
              border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent)",
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9.5L12 3l9 6.5" />
              <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
            </svg>
          </div>
          <h1 style={{ margin: "0 0 6px", fontSize: 26, fontWeight: 750, color: "var(--text)" }}>
            欢迎使用 Pi Web
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
            选择一个工作区继续，或新建 / 导入一个开始协作。
          </p>
        </div>

        {/* Primary actions */}
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
            marginTop: 22,
          }}
        >
          <button
            onClick={onCreateWorkspace}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 20px",
              border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
              borderRadius: 10,
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
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
            新建工作区
          </button>
          <button
            onClick={onImportDirectory}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 20px",
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            导入目录
          </button>
        </div>

        {/* Workspaces */}
        <section style={{ marginTop: 36 }}>
          <div style={{ display: "flex", alignItems: "baseline", marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>工作区</h2>
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-dim)" }}>{availableWorkspaces.length}</span>
          </div>
          {availableWorkspaces.length === 0 ? (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 13,
                border: "1px dashed var(--border)",
                borderRadius: 12,
              }}
            >
              还没有工作区。点击上方「新建工作区」或「导入目录」开始。
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: 12,
              }}
            >
              {availableWorkspaces.map((workspace) => (
                <WorkspaceCard
                  key={workspace.id}
                  workspace={workspace}
                  onOpen={() => onSelectWorkspace(workspace)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Recent sessions */}
        {recentSessions.length > 0 && (
          <section style={{ marginTop: 36 }}>
            <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>最近会话</h2>
            <div>
              {recentSessions.map((session) => {
                const owner = workspaceForSession(session, workspaces);
                return (
                  <button
                    key={session.id}
                    onClick={() => onSelectSession(session)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "11px 14px",
                      marginBottom: 8,
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                      }}
                    >
                      {session.name || session.firstMessage || "未命名会话"}
                    </span>
                    {owner && (
                      <span
                        style={{
                          flexShrink: 0,
                          maxWidth: 160,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 11,
                          color: "var(--accent)",
                        }}
                      >
                        {owner.name}
                      </span>
                    )}
                    <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                      {formatRelativeTime(session.modified)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function WorkspaceCard({
  workspace,
  onOpen,
}: {
  workspace: WorkspaceSummary;
  onOpen: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "14px 16px",
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: hovered ? "var(--bg-hover)" : "var(--bg-panel)",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        transition: "background 0.12s, border-color 0.12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {workspace.name}
        </strong>
      </div>
      <code
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {workspace.path}
      </code>
      <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
        <span style={badgeStyle}>{workspace.templateId}</span>
        <span style={badgeStyle}>{workspace.repositoryCount} 仓库</span>
        {workspace.skills.length > 0 && <span style={badgeStyle}>{workspace.skills.length} 技能</span>}
      </div>
    </button>
  );
}

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  background: "var(--bg-hover)",
  borderRadius: 10,
  padding: "2px 8px",
  whiteSpace: "nowrap",
};
