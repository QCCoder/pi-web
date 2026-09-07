"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { ChatInputHandle } from "./ChatInput";
import { ChatWindow } from "./ChatWindow";
import { PanelHeader } from "./PanelHeader";

/**
 * 首页无主新会话页（B1 原地切换）：首页主区在 hero 页与此页之间切换。
 * 顶部「‹ 返回」回 hero；工作区选择器默认选中最近活跃工作区（由
 * useAppShellState.handleHomeNewSession 决定，共识 Q11=a）；composer 草稿用
 * home 专属键 `new:__home__`（draftKeyOverride），切换选择不清空已打内容。
 * 首次发送：ChatWindow 以所选工作区根为 cwd 走现有 POST /api/agent/new，
 * daemon 按 cwd 解析工作区装配扩展（服务端零改动）；onSessionCreated 后由
 * useAppShellState.handleHomeSessionCreated 打开该工作区 tab 并落到会话。
 * 无任何可用工作区时显示创建引导。
 */
interface Props {
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onBack: () => void;
  onSessionCreated: (session: SessionInfo) => void;
  onCreateWorkspace: () => void;
  modelsRefreshKey: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
}

export function HomeNewSession({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onBack,
  onSessionCreated,
  onCreateWorkspace,
  modelsRefreshKey,
  chatInputRef,
}: Props) {
  const available = workspaces.filter((workspace) => workspace.available);
  const selected = available.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;

  if (available.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <PanelHeader title="新建会话" onBack={onBack} />
        <div
          style={{
            flex: 1,
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
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <PanelHeader title="新建会话" onBack={onBack} meta={<WorkspaceSelector workspaces={available} selected={selected} onSelect={onSelectWorkspace} />} />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {selected ? (
          <ChatWindow
            session={null}
            newSessionCwd={selected.path}
            draftKeyOverride="new:__home__"
            onSessionCreated={onSessionCreated}
            modelsRefreshKey={modelsRefreshKey}
            chatInputRef={chatInputRef}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
              fontSize: 14,
            }}
          >
            请先在上方选择一个工作区。
          </div>
        )}
      </div>
    </div>
  );
}

function WorkspaceSelector({
  workspaces,
  selected,
  onSelect,
}: {
  workspaces: WorkspaceSummary[];
  selected: WorkspaceSummary | null;
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
    <div ref={containerRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        onClick={() => setOpen((value) => !value)}
        title="选择本次会话归属的工作区"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: open ? "var(--bg-hover)" : "var(--bg-panel)",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          maxWidth: 220,
        }}
      >
        <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>工作区：</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: selected ? "var(--accent)" : "var(--text-dim)" }}>
          {selected ? selected.name : "请选择"}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 300,
            minWidth: 200,
            maxHeight: 300,
            overflowY: "auto",
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            boxShadow: "0 6px 20px rgba(0,0,0,0.14)",
          }}
        >
          {workspaces.map((workspace) => {
            const isSelected = selected?.id === workspace.id;
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
