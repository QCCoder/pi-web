"use client";

import { useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { workspaceForSession } from "@/lib/home-quick-switch";
import { WorkspaceSessionList } from "../WorkspaceSessionList";
import { workspaceAvatarStyle } from "../ProjectSidebar";
import { MobileCard, MobileMenu, MobileNavBar, MobileNote, MobilePill, MobileRow, MobileSection } from "./mobile-ui";
import { WorkspaceModuleIcon, workspaceModuleEntries } from "./workspace-modules";
import { shortenPath } from "./useMobileSkills";

/**
 * 手机壳二级页：工作区页（2026-10 底部 tab 改版；用户反馈「二级太简陋、布局不合理、
 * 顶部按键不用，用 ⋯ 就好」后重做；2026-10-26 导航统一——页头 MobileNavBar、菜单
 * MobileMenu、模块入口出自 workspaceModuleEntries 注册表）。
 *
 *   顶栏 = ‹ 返回 + 工作区名 + **⋯**（文件 / 工作项 / 知识库 / Loops〔capability 门控〕
 *   / 工作区设置——原一级首页 ⋯ 的内容下沉到这里：它们都是「某个工作区的」，在首页
 *   没有明确作用对象）。正文 = hero（彩色首字头像 + 名 + 路径 + 会话数/能力 pills）
 *   → 「新建会话」主按钮 → 会话列表卡片（WorkspaceSessionList 全量，自带删除）
 *   → 已归档会话。模块入口只在 ⋯ 里，正文不再放一排 chips。
 */

export type WorkspaceModuleKind = "files" | "work-items" | "knowledge" | "loops";

const CAPABILITY_LABELS: Partial<Record<WorkspaceSummary["capabilities"][number], string>> = {
  "work-items": "工作项",
  knowledge: "知识库",
  repositories: "仓库",
  workflows: "Loops",
  subagent: "子代理",
};

function PlusGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function MobileWorkspacePage({
  workspace,
  workspaces,
  sessions,
  onBack,
  backLabel,
  onNewSession,
  onOpenModule,
  onOpenSettings,
  onOpenArchive,
  onSelectSession,
  onSessionDeleted,
}: {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  sessions: SessionInfo[];
  onBack: () => void;
  backLabel: string;
  onNewSession: () => void;
  onOpenModule: (kind: WorkspaceModuleKind) => void;
  onOpenSettings: () => void;
  onOpenArchive: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onSessionDeleted?: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionCount = useMemo(
    () => sessions.filter((session) => !session.subagentChild && workspaceForSession(session, workspaces)?.id === workspace.id).length,
    [sessions, workspaces, workspace.id],
  );
  const capabilityPills = workspace.capabilities
    .map((capability) => CAPABILITY_LABELS[capability])
    .filter((label): label is string => Boolean(label));
  const avatar = workspaceAvatarStyle(workspace.name);
  const initial = [...workspace.name][0]?.toUpperCase() ?? "?";

  // ⋯ 菜单 = 注册表条目（文件/工作项/知识库/Loops〔capability 门控〕+ 工作区设置）。
  const menuEntries = workspaceModuleEntries(workspace, { settings: true }).map((entry) => ({
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    onClick: () => {
      if (entry.id === "ws-settings") onOpenSettings();
      else onOpenModule(entry.id as WorkspaceModuleKind);
    },
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }}>
      <MobileNavBar
        title={workspace.name}
        onBack={onBack}
        backLabel={backLabel}
        actions={(
          <button
            type="button"
            aria-label="更多"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="更多"
            onClick={() => setMenuOpen((open) => !open)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 40, height: 40, padding: 0, border: 0, borderRadius: 10, flexShrink: 0,
              background: menuOpen ? "var(--bg-hover)" : "transparent",
              color: menuOpen ? "var(--text)" : "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
            </svg>
          </button>
        )}
      />

      <MobileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        ariaLabel={`工作区 ${workspace.name}`}
        entries={menuEntries}
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 32 }}>
        {/* hero */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px 4px" }}>
          <span
            aria-hidden
            style={{
              width: 56, height: 56, borderRadius: 16, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 24, fontWeight: 700, lineHeight: 1,
              ...avatar,
            }}
          >
            {initial}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workspace.name}</div>
            <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={workspace.path}>
              {shortenPath(workspace.path)}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 20px 0" }}>
          <MobilePill tone="accent">{sessionCount > 0 ? `${sessionCount} 个会话` : "暂无会话"}</MobilePill>
          {capabilityPills.map((label) => <MobilePill key={label}>{label}</MobilePill>)}
        </div>

        {/* 主动作 */}
        <button
          type="button"
          onClick={onNewSession}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            margin: "16px 12px 0", width: "calc(100% - 24px)", height: 46, borderRadius: 13, border: 0,
            background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer",
          }}
        >
          <PlusGlyph />
          新建会话
        </button>

        {/* 会话 */}
        <MobileSection title="会话" trailing={<span style={{ fontSize: 11, color: "var(--text-dim)" }}>{sessionCount}</span>} />
        <MobileCard>
          {sessionCount === 0 ? (
            <div style={{ padding: "22px 16px", textAlign: "center", fontSize: 13, color: "var(--text-dim)" }}>
              这个工作区还没有会话——点上方「新建会话」开始。
            </div>
          ) : (
            <WorkspaceSessionList
              workspace={workspace}
              workspaces={workspaces}
              sessions={sessions}
              showHeader={false}
              onSelectSession={onSelectSession}
              onSessionDeleted={onSessionDeleted}
            />
          )}
        </MobileCard>

        <MobileSection title="更多" />
        <MobileCard>
          <MobileRow
            first
            icon={<WorkspaceModuleIcon kind="archive" />}
            label="已归档会话"
            sublabel="回收站：恢复或彻底删除"
            onClick={onOpenArchive}
          />
        </MobileCard>

        <MobileNote>文件 / 工作项 / 知识库 / Loops 与工作区设置在右上角 ⋯。</MobileNote>
      </div>
    </div>
  );
}
