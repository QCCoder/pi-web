"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { useIsMobile } from "@/hooks/useIsMobile";
import { HomeSessionGroups } from "./HomeSessionGroups";
import { groupSessionsByWorkspace } from "@/lib/home-quick-switch";

interface Props {
  workspaces: WorkspaceSummary[];
  refreshKey: number;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onSelectSession: (session: SessionInfo) => void;
  /** 打开首页无主新会话页（工作区选择器 + 输入框） */
  onNewSession: () => void;
  /** 运行中会话 id 集（移动端分组列表呼吸点） */
  runningSessionIds: Set<string>;
}

export function HomeLanding({
  workspaces,
  refreshKey,
  onSelectWorkspace,
  onCreateWorkspace,
  onImportDirectory,
  onSelectSession,
  onNewSession,
  runningSessionIds,
}: Props) {
  const isMobile = useIsMobile();
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

  // ---- Mobile (≤640px): one-screen two-zone layout ----------------------------
  // Hero compresses to a single row; 工作区 (~40%) scrolls horizontally, 最近会话
  // (~60%) scrolls internally. No page-level scroll — each zone owns its overflow.
  if (isMobile) {
    const compactBtn: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      height: 36,
      padding: "0 12px",
      borderRadius: 8,
      fontSize: 13,
      cursor: "pointer",
      flexShrink: 0,
    };
    const zoneHeader: React.CSSProperties = {
      display: "flex",
      alignItems: "baseline",
      gap: 7,
      padding: "2px 2px 4px",
      flexShrink: 0,
    };
    return (
      <main
        aria-label="Pi Web 首页"
        style={{
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          padding: "12px 12px 0",
        }}
      >
        {/* Compact hero row: small mark + title + actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <div
            aria-hidden="true"
            style={{
              width: 24,
              height: 24,
              borderRadius: 7,
              background: "color-mix(in srgb, var(--accent) 14%, var(--bg-panel))",
              border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9.5L12 3l9 6.5" />
              <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
            </svg>
          </div>
          <h1 style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 16, fontWeight: 750, color: "var(--text)" }}>
            Pi Web
          </h1>
          <button
            onClick={onNewSession}
            style={{
              ...compactBtn,
              border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              color: "var(--accent)",
              fontWeight: 700,
            }}
          >
            ＋ 会话
          </button>
          <button
            onClick={onCreateWorkspace}
            style={{
              ...compactBtn,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontWeight: 600,
            }}
          >
            新建工作区
          </button>
          <button
            onClick={onImportDirectory}
            style={{
              ...compactBtn,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontWeight: 600,
            }}
          >
            导入
          </button>
        </div>

        {/* Upper zone: 工作区 (~40%) — horizontal scroll of compact cards */}
        <section style={{ flex: 4, minHeight: 0, display: "flex", flexDirection: "column", marginTop: 12 }}>
          <div style={zoneHeader}>
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>工作区</h2>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{availableWorkspaces.length}</span>
          </div>
          {availableWorkspaces.length === 0 ? (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "16px 12px",
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 12,
                border: "1px dashed var(--border)",
                borderRadius: 12,
              }}
            >
              还没有工作区。点击「新建工作区」或「导入」开始。
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                overflowX: "auto",
                overflowY: "hidden",
                padding: "6px 2px 10px",
                WebkitOverflowScrolling: "touch",
              }}
            >
              {availableWorkspaces.map((workspace) => (
                <WorkspaceChip
                  key={workspace.id}
                  workspace={workspace}
                  onOpen={() => onSelectWorkspace(workspace)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Lower zone: 最近会话 (~60%) — internal scroll */}
        <section style={{ flex: 6, minHeight: 0, display: "flex", flexDirection: "column", marginTop: 12, paddingBottom: 12 }}>
          <div style={zoneHeader}>
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>最近会话</h2>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
            <HomeSessionGroups
              groups={groupSessionsByWorkspace(workspaces, sessions)}
              runningSessionIds={runningSessionIds}
              onSelectWorkspace={onSelectWorkspace}
              onSelectSession={onSelectSession}
            />
          </div>
        </section>
      </main>
    );
  }

  // ---- Desktop (>640px): single scrolling column -------------------------------
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
            选择一个工作区继续，或直接新建一个会话开始。
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
            onClick={onNewSession}
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <line x1="12" y1="7" x2="12" y2="13" />
              <line x1="9" y1="10" x2="15" y2="10" />
            </svg>
            新建会话
          </button>
          <button
            onClick={onCreateWorkspace}
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
      </div>
    </main>
  );
}

/** Compact workspace card for the mobile horizontal scroll row (~190px wide,
 *  name + counts only — no path). */
function WorkspaceChip({
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
        flex: "0 0 auto",
        width: 190,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "11px 12px",
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: hovered ? "var(--bg-hover)" : "var(--bg-panel)",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        transition: "background 0.12s, border-color 0.12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {workspace.name}
        </strong>
      </div>
      <div style={{ display: "flex", gap: 5, marginTop: 2, flexWrap: "wrap" }}>
        <span style={badgeStyle}>{workspace.capabilities.length} 能力</span>
        <span style={badgeStyle}>{workspace.repositoryCount} 仓库</span>
      </div>
    </button>
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
        <span style={badgeStyle}>{workspace.capabilities.length} 能力</span>
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
