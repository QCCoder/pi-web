"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { AgentsConfig } from "./AgentsConfig";
import { PanelHeader } from "./PanelHeader";
import { MobileCard, MobileNote, MobilePageTitle, MobileRow, MobileSection } from "./shell/mobile-ui";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { setupPushSubscription } from "@/lib/push-client";
import {
  isThinkingExpandedByDefault,
  setThinkingExpandedByDefault,
} from "@/lib/thinking-expansion-preference";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/** The settings panel's subpages. Controlled by the owner (MobileShell) so
 *  entry points outside the panel can deep-link straight to a subpage.
 *  （2026-09 配置页拆分：桌面配置面改走 ConfigCenterPage 独立整页，本组件
 *  退为移动端设置目的地页专用；SettingsPage 值域保持完整——移动端索引页 +
 *  推入子页仍覆盖 全部配置分区，桌面导航深链也复用其中的 workspace/
 *  preferences/plugins/skills 值作页内分区。） */
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

/** 设置 tab 的子页（index 之外的全部值域）——手机壳推入页 kind "settings-sub" 用。 */
export type SettingsSubpage = Exclude<SettingsPage, "index">;

/** 子页标题的单一出处（meta 仅平板壳 PanelHeader 用——手机导航栏是单标题，
 *  2026-10-26 用户反馈撤下 meta）。 */
export function settingsSubpageHeader(
  page: SettingsSubpage,
  settingsCwd: string,
  workspaceMeta?: string | null,
): { title: string; meta?: string } {
  return {
    title: SUBPAGE_TITLES[page],
    meta: page === "workspace" ? workspaceMeta ?? undefined
      : page === "models" ? "~/.pi/agent/models.json"
      : page === "skills" || page === "plugins" || page === "agents" ? shortenPath(settingsCwd)
      : undefined,
  };
}

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
  /** The 工作区 subpage content — the shell builds a panel-mode WorkspaceManager
   *  node (it owns that component's wide prop surface) and passes it in. */
  workspaceSlot: ReactNode;
  /** Switch to the archive panel (index row — the mobile path to the archive;
   *  desktop has the project-tree 归档 row instead). */
  onOpenArchive?: () => void;
  /** 工作区子页 header 的 meta（选中工作区名，WorkspaceManager 上报）。 */
  workspaceMeta?: string | null;
  onPluginsReloaded?: () => void;
  /** Fired when the models config is saved so the owner can refresh model lists. */
  onModelsSaved?: () => void;
  sessionId: string | null;
  /** × close — mobile full-screen overlay. */
  onCloseOverlay?: () => void;
  /** 手机壳（MobileTabShell）设置 tab 宿主：索引省略 工作区 / Skills / 归档
   *  三行——工作区设置经会话首页 ⋯ 或工作区页 ⚙ 推入，Skills 升为一级 tab，
   *  归档住工作区页底部。平板壳（MobileShell 设置目的地页）缺省 = 全量索引。 */
  phoneTab?: boolean;
  /** 不渲染任何页头（手机壳把子页推入 pushStack、由壳提供 MobileNavBar 时用；
   *  2026-10-26 导航统一——手机设置子页并入推入栈，本面板只出正文）。 */
  headerless?: boolean;
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

const PHONE_ICON_PROPS = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

/** 手机壳设置 tab 的索引（2026-10 底部 tab 改版 + 用户反馈「设置页不好看」）：
 *  iOS 分组卡片 + 彩色图标瓷片 + 右侧当前值 hint。只放全局配置——偏好 / 模型 /
 *  Agents / 插件；工作区设置住会话首页 ⋯ 与工作区页 ⚙，Skills 是一级 tab，归档
 *  住工作区页。子页经壳推入栈（settings-sub，MobileNavBar ‹设置 返回）。 */
function PhoneSettingsIndex({ onPageChange }: { onPageChange: (page: SettingsPage) => void }) {
  const { isDark } = useTheme();
  const { locale, supportedLocales } = useI18n();
  const localeLabel = supportedLocales.find((item) => item.id === locale)?.label ?? locale;
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 28 }}>
      <MobileSection title="外观与语言" />
      <MobileCard>
        <MobileRow
          first
          icon={<svg {...PHONE_ICON_PROPS}><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.4 5.4 0 0 1-7.54-7.54A9 9 0 0 0 12 3z" /></svg>}
          iconTone="hsl(248 72% 60%)"
          label="偏好"
          sublabel="主题 · 语言 · 思考块 · 通知"
          hint={`${isDark ? "深色" : "浅色"} · ${localeLabel}`}
          onClick={() => onPageChange("preferences")}
        />
      </MobileCard>

      <MobileSection title="模型与扩展" />
      <MobileCard>
        <MobileRow
          first
          icon={<svg {...PHONE_ICON_PROPS}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>}
          iconTone="hsl(199 89% 48%)"
          label="模型"
          sublabel="API Key · 默认模型"
          onClick={() => onPageChange("models")}
        />
        <MobileRow
          icon={<svg {...PHONE_ICON_PROPS}><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="M12 22V12M3 7l9 5 9-5" /></svg>}
          iconTone="hsl(32 95% 50%)"
          label="Agents"
          sublabel="子代理 · 角色剧本"
          onClick={() => onPageChange("agents")}
        />
        <MobileRow
          icon={<svg {...PHONE_ICON_PROPS}><path d="M20.2 12.8a2 2 0 0 0 0-1.6l1.3-1.3a1 1 0 0 0 0-1.4l-2-2a1 1 0 0 0-1.4 0L16.8 7.8a2 2 0 0 0-1.6 0L13.9 6.5a1 1 0 0 0-1.4 0l-2 2a1 1 0 0 0 0 1.4l1.3 1.3a2 2 0 0 0 0 1.6l-1.3 1.3a1 1 0 0 0 0 1.4l2 2a1 1 0 0 0 1.4 0l1.3-1.3a2 2 0 0 0 1.6 0l1.3 1.3a1 1 0 0 0 1.4 0l2-2a1 1 0 0 0 0-1.4z" /><path d="M3 21l6-6" /></svg>}
          iconTone="hsl(160 84% 39%)"
          label="插件"
          sublabel="pi 插件启停 · 重载"
          onClick={() => onPageChange("plugins")}
        />
      </MobileCard>

      <MobileNote>
        工作区设置在「会话」首页右上 ⋯ 或工作区页 ⚙；Skill 在底部「Skill」tab；已归档会话在各工作区页底部。
      </MobileNote>
    </div>
  );
}

/**
 * The mobile settings destination page: an iOS-settings-style index page plus
 * push-in subpages（‹设置 返回）. Desktop renders `ConfigCenterPage` standalone
 * pages instead (2026-09 配置页拆分) — this panel is mobile-only now.
 */
export function SettingsPanel({
  page,
  onPageChange,
  workspace,
  settingsCwd,
  workspaceSlot,
  onOpenArchive,
  workspaceMeta = null,
  onPluginsReloaded,
  onModelsSaved,
  sessionId,
  onCloseOverlay,
  phoneTab = false,
  headerless = false,
}: Props) {
  const { title, meta } = page !== "index"
    ? settingsSubpageHeader(page, settingsCwd, workspaceMeta)
    : { title: "设置" as const, meta: undefined };
  const back = page !== "index"
    ? { onBack: () => onPageChange("index"), backLabel: "设置" }
    : {};

  // 子页内容（推入式全屏页）。
  const sectionBody = (
    <>
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
            projectInstallAvailable={Boolean(workspace)}
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
      {page === "agents" && settingsCwd && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* 交付感知（backlog-clearing T2 接线）：激活工作区 id 透传——无激活
              工作区 = null → 面板整体不渲染（行为与从前一致）。 */}
          <AgentsConfig
            embedded
            key={settingsCwd}
            cwd={settingsCwd}
            sessionId={sessionId}
            workspaceId={workspace?.id ?? null}
            onClose={onCloseOverlay}
            onReloaded={onPluginsReloaded}
          />
        </div>
      )}
      {page === "preferences" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <PreferencesPage />
        </div>
      )}
    </>
  );

  // 移动端：全行索引 + 内嵌子页（推入式，‹设置 返回）。手机壳 tab 根页 =
  // MobilePageTitle 大标题（与会话/Skill tab 同一视觉语言）；headerless（手机壳
  // 推入子页宿主）不渲染任何页头——页头由壳的 MobileNavBar 提供。
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {!headerless && (phoneTab && page === "index" ? (
        <MobilePageTitle title="设置" />
      ) : (
        <PanelHeader
          title={title}
          meta={meta}
          onClose={onCloseOverlay}
          {...back}
        />
      ))}
      {page === "index" && phoneTab && (
        <PhoneSettingsIndex onPageChange={onPageChange} />
      )}
      {page === "index" && !phoneTab && (
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          borderTop: "1px solid var(--border)",
        }}>
          {/* 工作区管理是全局的（列表+详情在中央内容区），首页也可见入口；
              hint 显示当前工作区名（无则描述用途）。手机 tab 宿主（phoneTab）
              走上面的 PhoneSettingsIndex：工作区设置经会话首页 ⋯ / 工作区页 ⚙
              推入，Skills 升为一级 tab，归档住工作区页。 */}
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
