"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkItemRecord } from "@/lib/work-items/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { WorkspaceRepositoryState } from "@/lib/workspaces/types";
import { useKitLoops } from "@/hooks/useKitLoops";

/**
 * 移动端「工作区」tab 的落地菜单（2026-09 菜单化，替代原总览仪表盘）：
 * ＋ 新建会话（唯一常驻按钮）→ 会话（本工作区，计数）→ 模块组（工作项/
 * 知识库按 capability 显示，Loops 常驻——状态作 meta）→ 工作区设置。
 * 每行点进 MobileShell 的 overview 栈子页（会话/工作项/知识库/Loops 管理），
 * 状态一览靠计数/状态 meta 保留，重管理操作全部在子页里。
 * 仓库不设菜单行：浏览 = 底部「文件」tab（本来就在），管理 = 设置›工作区。
 * 桌面家 tab 不用它（大画布，保持 WorkspaceOverview 仪表盘）。
 *
 * 计数数据自取（work-items 活跃数 / 知识库 bundle 数 / loops 状态 / 会话数），
 * 按 capability 裁剪请求；宿主以 key={workspace.id} 挂载。
 */
interface Props {
  workspace: WorkspaceSummary;
  onNewSession: () => void;
  onOpenSessions: () => void;
  onOpenWorkItems: () => void;
  onOpenKnowledge: () => void;
  onOpenLoops: () => void;
  onOpenSettings: () => void;
  /** shell 的 loop 变更信号（子页里创建/删除/保存后 bump → 重新拉取）。 */
  loopsRefreshKey?: number;
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  padding: "13px 14px",
  marginBottom: 8,
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 14,
};

const groupLabelStyle: React.CSSProperties = {
  margin: "18px 4px 10px",
  fontSize: 11,
  color: "var(--text-dim)",
  letterSpacing: "0.06em",
};

function RowIcon({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: "flex", alignItems: "center", color: "var(--text-muted)", flexShrink: 0 }} aria-hidden>
      {children}
    </span>
  );
}

function CountBadge({ count }: { count: number }) {
  return (
    <span
      style={{
        flexShrink: 0,
        minWidth: 20,
        height: 20,
        padding: "0 7px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        background: "var(--bg-hover)",
        color: "var(--text-muted)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {count}
    </span>
  );
}

function Chevron() {
  return (
    <span style={{ color: "var(--text-dim)", fontSize: 14, flexShrink: 0 }} aria-hidden>›</span>
  );
}

export function WorkspaceHomeMenu({
  workspace,
  onNewSession,
  onOpenSessions,
  onOpenWorkItems,
  onOpenKnowledge,
  onOpenLoops,
  onOpenSettings,
  loopsRefreshKey,
}: Props) {
  const hasWorkItems = workspace.capabilities.includes("work-items");
  const hasKnowledge = workspace.capabilities.includes("knowledge");

  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [activeWorkItemCount, setActiveWorkItemCount] = useState<number | null>(null);
  const [knowledgeBundleCount, setKnowledgeBundleCount] = useState<number | null>(null);
  const { loops } = useKitLoops(workspace.id, loopsRefreshKey);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/sessions", { signal: controller.signal }),
      hasWorkItems
        ? fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/work-items`, { signal: controller.signal })
        : null,
      hasKnowledge
        ? fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories`, { signal: controller.signal })
        : null,
    ]).then(async ([sessionsResponse, itemsResponse, repositoriesResponse]) => {
      if (sessionsResponse?.ok) {
        const data = await sessionsResponse.json() as { sessions?: SessionInfo[] };
        const path = workspace.path;
        const prefix = `${path.replace(/\/+$/, "")}/`;
        setSessionCount((data.sessions ?? []).filter((session) =>
          !session.subagentChild
          && (session.cwd === path || session.cwd.startsWith(prefix) || session.projectRoot === path),
        ).length);
      }
      if (itemsResponse?.ok) {
        const data = await itemsResponse.json() as { items?: WorkItemRecord[] };
        setActiveWorkItemCount((data.items ?? []).filter((item) =>
          !item.archivedAt && item.status !== "done" && item.status !== "cancelled").length);
      }
      if (repositoriesResponse?.ok) {
        const data = await repositoriesResponse.json() as { repositories?: WorkspaceRepositoryState[] };
        setKnowledgeBundleCount((data.repositories ?? []).filter((repository) =>
          repository.kind === "knowledge" && repository.status === "active").length);
      }
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("Failed to load workspace menu counts:", error);
      }
    });
    return () => controller.abort();
  }, [workspace.id, workspace.path, hasWorkItems, hasKnowledge]);

  const runningLoops = loops.filter((loop) => loop.running).length;
  const pausedLoops = loops.filter((loop) => loop.paused).length;
  const loopsMeta = loops.length === 0
    ? "暂无"
    : [
        runningLoops > 0 ? `${runningLoops} 运行中` : null,
        pausedLoops > 0 ? `${pausedLoops} 已暂停` : null,
        runningLoops === 0 && pausedLoops === 0 ? "全部就绪" : null,
      ].filter(Boolean).join(" · ");

  const hoverHandlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "var(--bg-hover)"; },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "var(--bg-panel)"; },
  };

  return (
    <div style={{ padding: "16px 14px 28px", maxWidth: 560, margin: "0 auto" }}>
      {/* 唯一常驻动作 */}
      <button
        onClick={onNewSession}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: "100%",
          padding: "13px 16px",
          marginBottom: 6,
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

      {/* 会话（本工作区） */}
      <button onClick={onOpenSessions} style={rowStyle} {...hoverHandlers}>
        <RowIcon>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </RowIcon>
        <span style={{ flex: 1, fontWeight: 600 }}>会话</span>
        {sessionCount !== null && <CountBadge count={sessionCount} />}
        <Chevron />
      </button>

      {/* 工作区模块（capability 门控；Loops 文件即声明、常驻） */}
      <div style={groupLabelStyle}>模块</div>
      {hasWorkItems && (
        <button onClick={onOpenWorkItems} style={rowStyle} {...hoverHandlers}>
          <RowIcon>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <path d="M9 12h6" /><path d="M9 16h4" />
            </svg>
          </RowIcon>
          <span style={{ flex: 1, fontWeight: 600 }}>工作项</span>
          {activeWorkItemCount !== null && <CountBadge count={activeWorkItemCount} />}
          <Chevron />
        </button>
      )}
      {hasKnowledge && (
        <button onClick={onOpenKnowledge} style={rowStyle} {...hoverHandlers}>
          <RowIcon>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </RowIcon>
          <span style={{ flex: 1, fontWeight: 600 }}>知识库</span>
          {knowledgeBundleCount !== null && <CountBadge count={knowledgeBundleCount} />}
          <Chevron />
        </button>
      )}
      <button onClick={onOpenLoops} style={rowStyle} {...hoverHandlers}>
        <RowIcon>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
            <path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
          </svg>
        </RowIcon>
        <span style={{ flex: 1, fontWeight: 600 }}>Loops</span>
        <span style={{ flexShrink: 0, fontSize: 12, color: "var(--text-dim)" }}>{loopsMeta}</span>
        <Chevron />
      </button>

      {/* 工作区设置 */}
      <div style={groupLabelStyle}>设置</div>
      <button onClick={onOpenSettings} style={rowStyle} {...hoverHandlers}>
        <RowIcon>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </RowIcon>
        <span style={{ flex: 1, fontWeight: 600 }}>工作区设置</span>
        <Chevron />
      </button>
    </div>
  );
}
