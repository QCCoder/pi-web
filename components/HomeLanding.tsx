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

/** 方向 A（会话优先，2026-09 重做 + 工作区维度收敛修订）：首页 = 全局启动器，
 *  不设「当前工作区」chip。主动作 = 发起新会话（大输入卡 → HomeNewSession，
 *  工作区在选择器里挑）；工作区入口有二、职责不重叠——最近分组的组头
 *  （HomeSessionGroups，继续干活时的顺路入口；空工作区不成组）与右上角 ⊞
 *  工作区面板（完整列表 + 新建/导入，管理入口）。仅服务移动端首页；桌面首页
 *  是 HomeNewSession composer 页（本组件返回 null）。分组排序纯逻辑见
 *  lib/home-quick-switch.ts 的 groupSessionsByWorkspace（活跃度降序）。 */
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
  const [sheetOpen, setSheetOpen] = useState(false);

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
  // 空工作区不成组（无会话的工作区只在 ⊞ 面板出现，最近区保持紧凑）。
  const sessionGroups = useMemo(
    () => groupSessionsByWorkspace(workspaces, sessions).filter((group) => group.sessions.length > 0),
    [workspaces, sessions],
  );

  if (!isMobile) {
    // ---- Desktop: retired —— 桌面首页默认就是新建会话 composer 页（HomeNewSession，
    // DesktopShell 直挂）；本组件只服务移动端首页。防误用兜底：
    return null;
  }

  const { greeting, dateLabel } = homeChrome();
  const hasWorkspaces = availableWorkspaces.length > 0;

  return (
    <main
      aria-label="Pi Web 首页"
      style={{
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        padding: "14px 14px 0",
      }}
    >
      {hasWorkspaces ? (
        <>
          {/* Top row: app mark + date + workspace sheet entry (⊞) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <BrandMark size={22} />
            <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text)", flex: 1 }}>Pi</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{dateLabel}</span>
            <button
              onClick={() => setSheetOpen(true)}
              aria-label="工作区"
              aria-haspopup="dialog"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                marginLeft: 4,
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </button>
          </div>

          {/* Greeting */}
          <div style={{ marginTop: 26, flexShrink: 0 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "var(--text)" }}>
              {greeting} 👋
            </h1>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 5 }}>今天想推进什么？</div>
          </div>

          {/* Big input card → HomeNewSession (tap-to-compose, ChatGPT-style) */}
          <button
            onClick={onNewSession}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 18,
              padding: "13px 14px",
              border: "1px solid var(--border)",
              borderRadius: 14,
              background: "var(--bg-panel)",
              color: "var(--text-dim)",
              fontSize: 13,
              cursor: "pointer",
              textAlign: "left",
              flexShrink: 0,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              问点什么，或 /skill:…
            </span>
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                color: "var(--accent)",
                fontWeight: 800,
              }}
            >
              ＋
            </span>
          </button>

          {/* 最近会话 — grouped by workspace (group header tap = enter workspace) */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 7, padding: "16px 2px 8px", flexShrink: 0 }}>
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>最近</h2>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {sessionGroups.reduce((sum, group) => sum + group.sessions.length, 0)}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 14 }}>
            {sessionGroups.length === 0 ? (
              <div
                style={{
                  padding: "22px 12px",
                  textAlign: "center",
                  color: "var(--text-dim)",
                  fontSize: 12,
                  border: "1px dashed var(--border)",
                  borderRadius: 12,
                }}
              >
                还没有会话——点上方输入框开始第一段对话。
              </div>
            ) : (
              <HomeSessionGroups
                groups={sessionGroups}
                runningSessionIds={runningSessionIds}
                onSelectWorkspace={onSelectWorkspace}
                onSelectSession={onSelectSession}
              />
            )}
          </div>
        </>
      ) : (
        /* Onboarding: no workspace yet — the only meaningful actions are create/import. */
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: "0 20px 40px" }}>
          <BrandMark size={52} />
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)" }}>{greeting} 👋</h1>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            创建第一个工作区，开始与 pi 协作。
          </p>
          <button
            onClick={onCreateWorkspace}
            style={{
              marginTop: 10,
              width: "100%",
              maxWidth: 280,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              height: 44,
              borderRadius: 12,
              border: 0,
              background: "var(--accent)",
              color: "#fff",
              fontWeight: 800,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            ＋ 新建工作区
          </button>
          <button
            onClick={onImportDirectory}
            style={{
              width: "100%",
              maxWidth: 280,
              height: 40,
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            导入已有目录
          </button>
        </div>
      )}

      {sheetOpen && (
        <WorkspaceSheet
          workspaces={availableWorkspaces}
          onClose={() => setSheetOpen(false)}
          onSelectWorkspace={onSelectWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          onImportDirectory={onImportDirectory}
        />
      )}
    </main>
  );
}

/** Bottom sheet: the complete workspace list (select = enter) + 新建/导入
 *  footer — the management counterpart to the recent-groups' quick entry. */
function WorkspaceSheet({
  workspaces,
  onClose,
  onSelectWorkspace,
  onCreateWorkspace,
  onImportDirectory,
}: {
  workspaces: WorkspaceSummary[];
  onClose: () => void;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
}) {
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(0,0,0,0.35)" }}
      />
      <div
        role="dialog"
        aria-label="工作区"
        style={{
          position: "fixed",
          left: 10,
          right: 10,
          bottom: 10,
          zIndex: 31,
          display: "flex",
          flexDirection: "column",
          maxHeight: "68vh",
          border: "1px solid var(--border)",
          borderRadius: 16,
          background: "var(--bg)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "center", padding: "8px 0 2px", flexShrink: 0 }}>
          <span style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border)" }} />
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", padding: "6px 14px 4px", flexShrink: 0 }}>
          工作区
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "0 6px" }}>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              onClick={act(() => onSelectWorkspace(workspace))}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "11px 10px",
                border: 0,
                borderRadius: 10,
                background: "transparent",
                color: "var(--text)",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {workspace.name}
              </span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ))}
        </div>
        <div style={{ height: 1, background: "var(--border)", margin: "4px 10px", flexShrink: 0 }} />
        <div style={{ display: "flex", gap: 8, padding: "8px 10px calc(10px + env(safe-area-inset-bottom))", flexShrink: 0 }}>
          <button
            onClick={act(onCreateWorkspace)}
            style={{
              flex: 1,
              height: 38,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ＋ 新建工作区
          </button>
          <button
            onClick={act(onImportDirectory)}
            style={{
              flex: 1,
              height: 38,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            导入已有目录
          </button>
        </div>
      </div>
    </>
  );
}

function BrandMark({ size }: { size: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background: "color-mix(in srgb, var(--accent) 14%, var(--bg-panel))",
        border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--accent)",
        flexShrink: 0,
      }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9.5L12 3l9 6.5" />
        <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
      </svg>
    </div>
  );
}

function homeChrome(now = new Date()): { greeting: string; dateLabel: string } {
  const hour = now.getHours();
  const greeting =
    hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 周${weekdays[now.getDay()]}`;
  return { greeting, dateLabel };
}
