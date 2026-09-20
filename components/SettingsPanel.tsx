"use client";

import type { ReactNode } from "react";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { PanelHeader } from "./PanelHeader";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/** The settings panel's subpages. Controlled by the owner (AppShell) so entry
 *  points outside the panel (overview rows, 添加仓库 buttons, home create-workspace)
 *  can deep-link straight to a subpage. */
export type SettingsPage =
  | "index"
  | "workspace"
  | "models"
  | "skills"
  | "plugins"
  | "preferences";

const SUBPAGE_TITLES: Record<Exclude<SettingsPage, "index">, string> = {
  workspace: "工作区",
  models: "模型",
  skills: "Skills",
  plugins: "插件",
  preferences: "偏好",
};

function shortenPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : path;
}

interface Props {
  page: SettingsPage;
  onPageChange: (page: SettingsPage) => void;
  /** Active workspace, or null at home (hides the 工作区 index row). */
  workspace: WorkspaceSummary | null;
  /** Cwd used for skills/plugins scoping (falls back through session → workspace → home). */
  settingsCwd: string;
  /** The 工作区 subpage content — AppShell builds a panel-mode WorkspaceManager
   *  node (it owns that component's wide prop surface) and passes it in. */
  workspaceSlot: ReactNode;
  /** Switch to the archive panel (index row — the mobile path to the archive;
   *  desktop has the project-tree 归档 row instead). */
  onOpenArchive?: () => void;
  /** Desktop center-page mode（2026-09 树形侧栏改版）：设置作为中央区整页
   *  渲染——索引只列 工作区/偏好（模型/Skills/插件 在侧栏底部四入口，归档
   *  在项目树），子页面板内推进航（‹ 设置 返回）。缺省（移动端抽屉）保持
   *  原样：全行索引 + 内嵌子页。 */
  desktop?: boolean;
  /** 工作区子页 header 的 meta（选中工作区名，WorkspaceManager 上报）。 */
  workspaceMeta?: string | null;
  onWorkspaceSkillsChange?: (workspace: WorkspaceSummary) => void;
  onPluginsReloaded?: () => void;
  /** Fired when the models config is saved so the owner can refresh model lists. */
  onModelsSaved?: () => void;
  sessionId: string | null;
  /** × close — mobile full-screen overlay & desktop center page. */
  onCloseOverlay?: () => void;
}

function IndexRow({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        border: 0,
        borderTop: "1px solid var(--border)",
        background: active ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 13,
        textAlign: "left",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
        {hint && (
          <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-dim)" }}>{hint}</span>
        )}
      </span>
      <span aria-hidden style={{ color: "var(--text-dim)", fontSize: 12, flexShrink: 0 }}>›</span>
    </button>
  );
}

export function PreferencesPage() {
  const { isDark, toggleTheme } = useTheme();
  const { locale, setLocale, supportedLocales } = useI18n();
  return (
    <div style={{ padding: "12px 10px", display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700, marginBottom: 8, padding: "0 2px" }}>外观</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[false, true].map((dark) => {
            const active = isDark === dark;
            return (
              <button
                key={String(dark)}
                type="button"
                onClick={() => { if (!active) toggleTheme(); }}
                style={{
                  flex: 1,
                  padding: "9px 10px",
                  border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
                  borderRadius: 8,
                  background: active ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "var(--bg)",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  fontWeight: active ? 700 : 500,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {dark ? "深色" : "浅色"}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700, marginBottom: 8, padding: "0 2px" }}>语言</div>
        <div style={{ display: "flex", gap: 6 }}>
          {supportedLocales.map((item) => {
            const active = locale === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => { if (!active) setLocale(item.id as typeof locale); }}
                style={{
                  flex: 1,
                  padding: "9px 10px",
                  border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
                  borderRadius: 8,
                  background: active ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "var(--bg)",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  fontWeight: active ? 700 : 500,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7, padding: "0 2px" }}>
        完成提示音的开关在聊天输入框的控件行里；系统提示词、分支导航等会话级工具在聊天顶栏。
      </div>
    </div>
  );
}

/**
 * The settings panel: an iOS-settings-style index page plus subpages. The
 * subpage bodies are the former full-screen modals in `embedded` mode — model /
 * skills / plugins configuration lives here now instead of overlay modals.
 */
export function SettingsPanel({
  page,
  onPageChange,
  workspace,
  settingsCwd,
  workspaceSlot,
  onOpenArchive,
  desktop = false,
  workspaceMeta = null,
  onWorkspaceSkillsChange,
  onPluginsReloaded,
  onModelsSaved,
  sessionId,
  onCloseOverlay,
}: Props) {
  const title = page === "index" ? "设置" : SUBPAGE_TITLES[page];
  // 子页面板内推进航（‹ 设置 返回）——桌面中央区页与移动端抽屉同构；索引
  // 只在 index 页渲染（子页换入换出）。
  const back = page !== "index"
    ? { onBack: () => onPageChange("index"), backLabel: "设置" }
    : {};
  const showIndex = page === "index";
  const meta = page === "workspace" ? workspaceMeta ?? undefined
    : page === "models" ? "~/.pi/agent/models.json"
    : page === "skills" || page === "plugins" ? shortenPath(settingsCwd)
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PanelHeader
        title={title}
        meta={meta}
        onClose={onCloseOverlay}
        {...back}
      />
      {showIndex && (
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          borderTop: "1px solid var(--border)",
        }}>
          {/* 工作区管理是全局的（列表+详情在中央内容区），首页也可见入口；
              hint 显示当前工作区名（无则描述用途）。 */}
          <IndexRow
            label="工作区"
            hint={workspace?.name ?? "管理全部工作区"}
            onClick={() => onPageChange("workspace")}
          />
          {/* 模型/Skills/插件：桌面端在侧栏底部四入口（中央区整页），设置里不再
              重复；手机端这三行是唯一入口，进入内嵌子页。归档同理：桌面在项目
              树组尾，手机在设置索引行。 */}
          {!desktop && (
            <>
              <IndexRow label="模型" hint="API Key / 默认模型" onClick={() => onPageChange("models")} />
              <IndexRow label="Skills" onClick={() => onPageChange("skills")} />
              <IndexRow label="插件" onClick={() => onPageChange("plugins")} />
            </>
          )}
          <IndexRow label="偏好" hint="主题 / 语言" onClick={() => onPageChange("preferences")} />
          {!desktop && onOpenArchive && (
            <IndexRow label="归档" hint="回收站" onClick={onOpenArchive} />
          )}
        </div>
      )}
      {/* 子页面（板内推进航）：mobile 传 panel-mode WorkspaceManager，desktop
          传 inline-split（列表+详情并排）——两者都在本面板内渲染。 */}
      {page === "workspace" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {workspaceSlot}
        </div>
      )}
      {page === "models" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ModelsConfig embedded onSaved={onModelsSaved} />
        </div>
      )}
      {page === "skills" && settingsCwd && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <SkillsConfig
            embedded
            cwd={settingsCwd}
            globalOnly={!workspace}
            workspace={workspace}
            onWorkspaceSkillsChange={onWorkspaceSkillsChange}
          />
        </div>
      )}
      {page === "plugins" && settingsCwd && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <PluginsConfig
            embedded
            cwd={settingsCwd}
            sessionId={sessionId}
            onReloaded={onPluginsReloaded}
          />
        </div>
      )}
      {page === "preferences" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <PreferencesPage />
        </div>
      )}
    </div>
  );
}
