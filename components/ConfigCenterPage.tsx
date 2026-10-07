"use client";

import type { ReactNode } from "react";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { AgentsConfig } from "./AgentsConfig";
import { PreferencesPage } from "./SettingsPanel";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/**
 * 中央区配置整页族（2026-09 配置页拆分）。设置 / 模型 / 插件&技能 / Agents
 * 四个导航入口此前共用一个两栏设置页、只换预选分区——页头永远是「设置」、
 * 左索引列永远全量六项，用户反馈「跳转的页面都一模一样」。拆分后每个入口
 * 是独立整页，整页打开时 DesktopShell 隐藏会话 tab 条（ZCode 市场页/设置页
 * 同款整页心智），页面 chrome 为市场页同款 hero：
 *
 *   ┌ icon章 + 大标题 + meta + ✕ ──────────────────────┐
 *   │ 描述行（安静说明）                                │
 *   │ [插件] [技能]  ← 分区 pills（仅多分区页）           │
 *   ├──────────────────────────────────────────────────┤
 *   │ content（单分区页直接宿主 Config 组件，自带        │
 *   │ 列表+详情 分栏）                                   │
 *   └──────────────────────────────────────────────────┘
 *
 * 移动端不变：仍是 SettingsPanel 索引页 + 推入子页，不经本组件。
 *
 * 页内分区状态（settingsPage）由 shell 持有：本组件只收 section/
 * onSectionChange——多分区页 pills 切换写回 settingsPage，导航高亮与移动端
 * 深链共用同一记忆。
 */

export type ConfigCenterKind = "settings" | "models" | "plugins" | "agents";

/** 页内分区值域 = 设置页（workspace/preferences）∪ 插件&技能页（plugins/
 *  skills）。均为 SettingsPage 的子集，onSectionChange 直接写 settingsPage。 */
export type ConfigCenterSection = "workspace" | "preferences" | "plugins" | "skills";

interface Props {
  page: { kind: ConfigCenterKind };
  /** 当前页内分区（shell 从 settingsPage 派生；单分区页不消费）。 */
  section: ConfigCenterSection;
  onSectionChange: (section: ConfigCenterSection) => void;
  /** Active workspace, or null at home（工作区分区内容 / Skills 作用域）。 */
  workspace: WorkspaceSummary | null;
  /** Cwd used for skills/plugins scoping (falls back through session → workspace → home). */
  settingsCwd: string;
  /** 设置›工作区 分区内容——AppShell 构建的 panel 模式 WorkspaceManager 节点
   *  （该组件 prop 面很宽，由宿主注入）。 */
  workspaceSlot: ReactNode;
  /** 工作区分区 header 的 meta（选中工作区名，WorkspaceManager 上报）。 */
  workspaceMeta?: string | null;
  onWorkspaceSkillsChange?: (workspace: WorkspaceSummary) => void;
  onPluginsReloaded?: () => void;
  onModelsSaved?: () => void;
  sessionId: string | null;
  /** ✕ close — 中央区整页（点任何会话 tab 也会关闭）。 */
  onClose?: () => void;
}

function shortenPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : path;
}

/* ---- 页头图标（与侧栏导航行同源，accent 章底） ---------------------------- */

function PageIcon({ kind }: { kind: ConfigCenterKind }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "models":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path d="M15 2v2" /><path d="M15 20v2" /><path d="M9 2v2" /><path d="M9 20v2" />
          <path d="M2 15h2" /><path d="M2 9h2" /><path d="M20 15h2" /><path d="M20 9h2" />
        </svg>
      );
    case "plugins":
      return (
        <svg {...common}>
          <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
        </svg>
      );
    case "agents":
      return (
        <svg {...common}>
          <rect x="5" y="8" width="14" height="12" rx="2" />
          <circle cx="12" cy="14" r="2.4" />
          <path d="M12 11.6V9" />
          <path d="M9 3h6" /><path d="M12 3v5" />
        </svg>
      );
  }
}

/* ---- 页内作用域索引列的条目图标 ------------------------------------------ */

function SectionIcon({ id }: { id: ConfigCenterSection }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (id) {
    case "workspace":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    case "preferences":
      return (
        <svg {...common}>
          <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
        </svg>
      );
    case "plugins":
      return (
        <svg {...common}>
          <path d="M13 3v2a1 1 0 0 1-1 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 1 1-1h2" />
          <path d="M17 3h4v4" /><path d="M13 7l8-4" />
        </svg>
      );
    case "skills":
      return (
        <svg {...common}>
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      );
  }
}

/** 多分区页的分区 pills 定义（每页各自的作用域条目——不再是全量六项大杂烩）。 */
const PAGE_SECTIONS: Partial<Record<ConfigCenterKind, Array<{ id: ConfigCenterSection; label: string }>>> = {
  settings: [
    { id: "workspace", label: "工作区" },
    { id: "preferences", label: "偏好" },
  ],
  plugins: [
    { id: "plugins", label: "插件" },
    { id: "skills", label: "技能" },
  ],
};

const PAGE_TITLES: Record<ConfigCenterKind, string> = {
  settings: "设置",
  models: "模型",
  plugins: "插件 & 技能",
  agents: "Agents",
};

/** 页头描述行（ZCode 市场页同款 hero：大标题下一行安静说明）。 */
const PAGE_DESCRIPTIONS: Record<ConfigCenterKind, string> = {
  settings: "管理工作区、外观与通知偏好",
  models: "配置模型 Provider、API Key 与默认模型",
  plugins: "用插件和技能扩展 Agent 的能力",
  agents: "创建和管理子代理（subagent）",
};

export function ConfigCenterPage({
  page,
  section,
  onSectionChange,
  workspace,
  settingsCwd,
  workspaceSlot,
  workspaceMeta = null,
  onWorkspaceSkillsChange,
  onPluginsReloaded,
  onModelsSaved,
  sessionId,
  onClose,
}: Props) {
  const kind = page.kind;
  const railSections = PAGE_SECTIONS[kind];

  // 页头 meta（mono 次级信息，与大标题同行右倾）：模型页 = 配置文件路径；
  // 多分区页按分区给上下文（工作区分区跟随 WorkspaceManager 上报的选中项；
  // 插件&技能 = 作用域 cwd）。
  const meta = kind === "models"
    ? "~/.pi/agent/models.json"
    : kind === "settings"
      ? (section === "workspace" ? workspaceMeta ?? undefined : "主题 / 语言 / 通知")
      : shortenPath(settingsCwd);

  // 分区内容：多分区页按 section 切换；单分区页整页直挂（Config 组件自带
  // 列表+详情分栏，就是这一页的两栏视觉）。
  let content: ReactNode;
  if (kind === "settings" && section === "workspace") {
    content = workspaceSlot;
  } else if (kind === "settings" && section === "preferences") {
    content = (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 700, margin: "0 auto", padding: "16px 22px 30px" }}>
          <PreferencesPage />
        </div>
      </div>
    );
  } else if (kind === "models") {
    content = <ModelsConfig embedded onSaved={onModelsSaved} />;
  } else if (kind === "plugins" && section === "skills") {
    content = settingsCwd ? (
      <SkillsConfig
        market
        cwd={settingsCwd}
        globalOnly={!workspace}
        workspace={workspace}
        onWorkspaceSkillsChange={onWorkspaceSkillsChange}
      />
    ) : null;
  } else if (kind === "plugins") {
    content = settingsCwd ? (
      <PluginsConfig
        market
        cwd={settingsCwd}
        sessionId={sessionId}
        onReloaded={onPluginsReloaded}
      />
    ) : null;
  } else {
    content = settingsCwd ? (
      <AgentsConfig
        embedded
        key={settingsCwd}
        cwd={settingsCwd}
        sessionId={sessionId}
        onClose={onClose}
        onReloaded={onPluginsReloaded}
      />
    ) : null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 页头（ZCode 市场页同款 hero）：图标章 + 大标题 + 描述行 + 分区 pills，
          替代原 44px 面板式页头。中央区整页打开时 DesktopShell 会隐藏会话
          tab 条，本页占满中央区——与 ZCode 的整页设置/市场一致。 */}
      <header
        style={{
          flexShrink: 0,
          padding: "18px 22px 0",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span
            aria-hidden
            style={{
              display: "grid",
              placeItems: "center",
              width: 30,
              height: 30,
              borderRadius: 9,
              background: "color-mix(in srgb, var(--accent) 13%, transparent)",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            <PageIcon kind={kind} />
          </span>
          <strong style={{ fontSize: 19, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}>
            {PAGE_TITLES[kind]}
          </strong>
          {meta && (
            <span
              title={typeof meta === "string" ? meta : undefined}
              style={{
                fontSize: 11,
                color: "var(--text-dim)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
                alignSelf: "center",
                marginTop: 3,
              }}
            >
              {meta}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                border: "1px solid var(--border)",
                borderRadius: 7,
                background: "var(--bg)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                flexShrink: 0,
                padding: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              ✕
            </button>
          )}
        </div>
        <div style={{ margin: "5px 0 0 41px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
          {PAGE_DESCRIPTIONS[kind]}
        </div>
        {/* 分区 pills（ZCode 市场页「公开/个人」同款分段按钮）：仅多分区页。
            选中态 = bg-selected + accent 图标；内容区随选中切换。 */}
        {railSections && (
          <div
            role="tablist"
            aria-label={`${PAGE_TITLES[kind]}分区`}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "12px 0 12px 41px" }}
          >
            {railSections.map((item) => {
              const selected = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => { if (!selected) onSectionChange(item.id); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    height: 30,
                    padding: "0 14px",
                    border: `1px solid ${selected ? "color-mix(in srgb, var(--accent) 38%, var(--border))" : "transparent"}`,
                    borderRadius: 8,
                    background: selected ? "var(--bg-selected)" : "transparent",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    fontWeight: selected ? 600 : 500,
                    fontSize: 12.5,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ display: "flex", flexShrink: 0, color: selected ? "var(--accent)" : "var(--text-dim)" }}>
                    <SectionIcon id={item.id} />
                  </span>
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
        {!railSections && <div style={{ height: 14 }} />}
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {content}
      </div>
    </div>
  );
}
