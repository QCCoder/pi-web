"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { AgentsConfig } from "./AgentsConfig";
import { PanelHeader } from "./PanelHeader";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { setupPushSubscription } from "@/lib/push-client";
import {
  isThinkingExpandedByDefault,
  setThinkingExpandedByDefault,
} from "@/lib/thinking-expansion-preference";
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
  | "agents"
  | "preferences";

const SUBPAGE_TITLES: Record<Exclude<SettingsPage, "index">, string> = {
  workspace: "工作区",
  models: "模型",
  skills: "Skills",
  plugins: "插件",
  agents: "Agents",
  preferences: "偏好",
};

/** 桌面设置页的左索引列（2026-09 设置页收敛为两栏：与 模型/Skills/插件 等
 *  配置页同一视觉语言——左列选分区、右侧直接渲染内容，不再有空索引页和
 *  板内推跳）。模型/Skills/插件/Agents 不再是独立中央区整页，全部住进这里。 */
const DESKTOP_NAV_SECTIONS: Array<{ id: Exclude<SettingsPage, "index">; label: string }> = [
  { id: "workspace", label: "工作区" },
  { id: "models", label: "模型" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "插件" },
  { id: "agents", label: "Agents" },
  { id: "preferences", label: "偏好" },
];

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
  /** Desktop center-page mode（2026-09 设置页收敛为两栏）：单页两栏——左侧
   *  常驻分区索引列（工作区/模型/Skills/插件/Agents/偏好），右侧直接渲染当前
   *  分区内容（模型等不再独立整页，底部入口 = 打开设置页预选分区）；无索引页、
   *  无板内推跳。缺省（移动端）保持原样：全行索引 + 内嵌子页 + ‹设置 返回。 */
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
  // 默认展开思考块（upstream #639）：localStorage 持久 + 广播事件让已挂载的
  // ThinkingBlock 同步。本面板文案沿用偏好页的中文硬编码风格（外观/语言同）。
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  useEffect(() => {
    setThinkingExpanded(isThinkingExpandedByDefault());
  }, []);
  // Web Push 注册（upstream #728「Settings → General 注册按钮」语义）：iOS 主屏
  // PWA 的授权弹窗必须发生在用户手势内、且重装主屏后无法自动恢复订阅，所以
  // 提供手动注册入口，而不是只在会话完成时惰性触发。
  const [pushRegistering, setPushRegistering] = useState(false);
  const [pushStatus, setPushStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const registerPush = async () => {
    if (pushRegistering) return;
    setPushRegistering(true);
    setPushStatus(null);
    try {
      if (typeof window === "undefined" || !("Notification" in window)) {
        throw new Error("浏览器不支持或未授权通知");
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") throw new Error("通知权限未授予");
      const ok = await setupPushSubscription(locale);
      if (!ok) throw new Error("订阅失败（需先安装为 PWA / 支持 Push API）");
      setPushStatus({ ok: true, message: "推送已注册，后台通知就绪。" });
    } catch (cause) {
      setPushStatus({ ok: false, message: `注册失败：${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setPushRegistering(false);
    }
  };
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
      <div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700, marginBottom: 8, padding: "0 2px" }}>思考过程显示</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7, marginBottom: 8, padding: "0 2px" }}>
          选择消息加载时模型思考块是否默认展开。
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 2px" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>默认展开思考块</span>
          <button
            type="button"
            role="switch"
            aria-checked={thinkingExpanded}
            aria-label="默认展开思考块"
            onClick={() => {
              const next = !thinkingExpanded;
              setThinkingExpandedByDefault(next);
              setThinkingExpanded(next);
            }}
            style={{
              width: 36,
              height: 20,
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: thinkingExpanded ? "var(--accent)" : "var(--bg)",
              position: "relative",
              cursor: "pointer",
              padding: 0,
              flexShrink: 0,
            }}
          >
            <span aria-hidden style={{
              position: "absolute",
              top: 1,
              left: thinkingExpanded ? 17 : 1,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.15s",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }} />
          </button>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700, marginBottom: 8, padding: "0 2px" }}>后台推送（iOS 主屏应用）</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7, marginBottom: 8, padding: "0 2px" }}>
          将本站添加到主屏幕后（iPhone 需 iOS 16.4+），会话完成且页面不在前台时可在锁屏收到系统通知。若通知不再送达，可回到这里重新注册。注册必须由点击触发。
        </div>
        <button
          type="button"
          disabled={pushRegistering}
          onClick={() => void registerPush()}
          style={{
            padding: "8px 14px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            color: pushRegistering ? "var(--text-dim)" : "var(--text)",
            cursor: pushRegistering ? "default" : "pointer",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {pushRegistering ? "注册中…" : "注册推送"}
        </button>
        {pushStatus && (
          <div
            role="status"
            style={{ fontSize: 11, marginTop: 8, padding: "0 2px", color: pushStatus.ok ? "var(--accent)" : "#b91c1c" }}
          >
            {pushStatus.message}
          </div>
        )}
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
  // 桌面：左索引列常驻，没有索引页——"index" 归一为 "workspace"；移动端保留
  // 索引页 + 板内推子页（‹设置 返回）。
  const activePage: SettingsPage = desktop && page === "index" ? "workspace" : page;
  const title = !desktop && activePage !== "index" ? SUBPAGE_TITLES[activePage] : "设置";
  const back = !desktop && activePage !== "index"
    ? { onBack: () => onPageChange("index"), backLabel: "设置" }
    : {};
  const meta = activePage === "workspace" ? workspaceMeta ?? undefined
    : activePage === "models" ? "~/.pi/agent/models.json"
    : activePage === "skills" || activePage === "plugins" || activePage === "agents" ? shortenPath(settingsCwd)
    : undefined;

  // 分区内容（桌面 = 右侧内容列；移动端 = 推入的子页）。
  const sectionBody = (
    <>
      {activePage === "workspace" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {workspaceSlot}
        </div>
      )}
      {activePage === "models" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ModelsConfig embedded onSaved={onModelsSaved} />
        </div>
      )}
      {activePage === "skills" && settingsCwd && (
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
      {activePage === "plugins" && settingsCwd && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <PluginsConfig
            embedded
            cwd={settingsCwd}
            sessionId={sessionId}
            onReloaded={onPluginsReloaded}
          />
        </div>
      )}
      {activePage === "agents" && settingsCwd && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <AgentsConfig
            embedded
            key={settingsCwd}
            cwd={settingsCwd}
            sessionId={sessionId}
            onClose={onCloseOverlay}
            onReloaded={onPluginsReloaded}
          />
        </div>
      )}
      {activePage === "preferences" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <PreferencesPage />
        </div>
      )}
    </>
  );

  // 桌面：单页两栏——左侧分区索引（含全部配置分区），右侧当前分区内容。
  // 「工作区」分区的 workspaceSlot 本身是 列表+详情 并排，整页里外合计三栏，
  // 每栏窄而专注；不再渲染几乎空白的索引页，也没有板内推跳。
  if (desktop) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PanelHeader
          title={title}
          meta={meta}
          onClose={onCloseOverlay}
        />
        <div style={{ flex: 1, minHeight: 0, display: "flex", borderTop: "1px solid var(--border)" }}>
          <nav
            aria-label="设置分区"
            style={{
              width: 200,
              flexShrink: 0,
              minHeight: 0,
              overflowY: "auto",
              borderRight: "1px solid var(--border)",
              background: "var(--bg-panel)",
              padding: "8px 6px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {DESKTOP_NAV_SECTIONS.map((section) => {
              const selected = activePage === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => onPageChange(section.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    border: 0,
                    borderRadius: 7,
                    background: selected ? "var(--bg-selected)" : "transparent",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    fontWeight: selected ? 600 : 500,
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {section.label}
                  </span>
                </button>
              );
            })}
          </nav>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {sectionBody}
          </div>
        </div>
      </div>
    );
  }

  // 移动端：全行索引 + 内嵌子页（推入式，‹设置 返回）。
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PanelHeader
        title={title}
        meta={meta}
        onClose={onCloseOverlay}
        {...back}
      />
      {activePage === "index" && (
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
          <IndexRow label="模型" hint="API Key / 默认模型" onClick={() => onPageChange("models")} />
          <IndexRow label="Skills" onClick={() => onPageChange("skills")} />
          <IndexRow label="插件" onClick={() => onPageChange("plugins")} />
          <IndexRow label="Agents" onClick={() => onPageChange("agents")} />
          <IndexRow label="偏好" hint="主题 / 语言" onClick={() => onPageChange("preferences")} />
          {onOpenArchive && (
            <IndexRow label="归档" hint="回收站" onClick={onOpenArchive} />
          )}
        </div>
      )}
      {sectionBody}
    </div>
  );
}
