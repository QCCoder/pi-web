"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";
import type { ChatInputHandle } from "./ChatInput";
import { ChatWindow } from "./ChatWindow";

/**
 * 首页无主新会话页（B1 原地切换，反馈修订：去掉定制外壳）：
 * 不再渲染专用 PanelHeader 页面，直接呈现与普通工作区新会话一致的
 * 「只有 composer」视图，可直接发起对话；返回首页 = 顶部 tab 栏首页按钮
 * （activateTab 会重置无主页模式）。
 *
 * 工作区选择器（反馈修订 2）下移到 composer 控制行、上传图片按钮左侧
 * （ChatInput leadingControl 槽）；选择器默认选中最近活跃工作区（Q11=a），
 * 草稿用 home 专属键 `new:__home__`（draftKeyOverride），切换选择不清空。
 * 首次发送：以所选工作区根为 cwd 走现有 POST /api/agent/new（daemon 按
 * cwd 解析工作区装配扩展，服务端零改动）；onSessionCreated →
 * useAppShellState.handleHomeSessionCreated 打开该工作区 tab 并落到会话。
 * 无任何可用工作区时显示创建引导。
 */
interface Props {
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onSessionCreated: (session: SessionInfo) => void;
  onCreateWorkspace: () => void;
  modelsRefreshKey: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
}

export function HomeNewSession({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onSessionCreated,
  onCreateWorkspace,
  modelsRefreshKey,
  chatInputRef,
}: Props) {
  const available = workspaces.filter(isWorkspaceSelectable);

  if (available.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          color: "var(--text-muted)",
        }}
      >
        <span style={{ fontSize: 14 }}>还没有可用的工作区，先创建一个再开始会话。</span>
        <button
          onClick={onCreateWorkspace}
          style={{
            padding: "10px 18px",
            border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
            borderRadius: 10,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            color: "var(--accent)",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ＋ 新建工作区
        </button>
      </div>
    );
  }

  // selectedWorkspaceId normally always valid (opened with the default pick);
  // a stale id (workspace removed mid-flight) falls back to the first available
  // so the composer is always sendable.
  const selected = available.find((workspace) => workspace.id === selectedWorkspaceId) ?? available[0];

  return (
    <ChatWindow
      session={null}
      newSessionCwd={selected.path}
      draftKeyOverride="new:__home__"
      inputLeadingControl={
        <WorkspaceSelector workspaces={available} selected={selected} onSelect={onSelectWorkspace} />
      }
      onSessionCreated={onSessionCreated}
      modelsRefreshKey={modelsRefreshKey}
      chatInputRef={chatInputRef}
    />
  );
}

/** 「工作区： name ▾」选择器 — 宿主在 composer 控制行（上传按钮左侧），
 *  下拉向上展开（bottom 锚定）。 */
function WorkspaceSelector({
  workspaces,
  selected,
  onSelect,
}: {
  workspaces: WorkspaceSummary[];
  selected: WorkspaceSummary;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((value) => !value)}
        title="选择本次会话归属的工作区"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 32,
          padding: "0 8px",
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: open ? "var(--bg-hover)" : "transparent",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 11.5,
          fontWeight: 600,
          maxWidth: 190,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>工作区:</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--accent)" }}>
          {selected.name}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}>
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 300,
            minWidth: 200,
            maxHeight: 280,
            overflowY: "auto",
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            boxShadow: "0 -4px 16px rgba(0,0,0,0.14)",
          }}
        >
          {workspaces.map((workspace) => {
            const isSelected = selected.id === workspace.id;
            return (
              <button
                key={workspace.id}
                onClick={() => {
                  onSelect(workspace.id);
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 9px",
                  border: 0,
                  borderRadius: 7,
                  background: isSelected ? "var(--bg-selected)" : "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12.5,
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {workspace.name}
                </span>
                {isSelected && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
