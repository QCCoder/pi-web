"use client";

import type { SessionInfo } from "@/lib/types";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";
import type { ChatInputHandle } from "./ChatInput";
import { ChatWindow } from "./ChatWindow";
import { WorkspaceSelector } from "./WorkspaceSelector";

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
