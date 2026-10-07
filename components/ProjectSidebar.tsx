"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { groupSessionsByWorkspace } from "@/lib/home-quick-switch";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { computeMenuLayout, readViewportWindow, type MenuLayout } from "@/lib/dropdown-layout";
import { useI18n } from "@/hooks/useI18n";
import type { CenterPage } from "./shell/useAppShellState";
import { SessionRow } from "./SessionRow";
import { SearchPalette } from "./SearchPalette";

/**
 * 会话侧栏（2026-09-27 侧栏瘦身改版 + 同日分组开关；原「项目树侧栏」）：
 * 工作区切换 + 模块入口收进 WorkspaceSwitcherPanel（桌面挂在顶部工作区工具行
 * 的「工作区名 ▾」下，移动端嵌抽屉头部 headerSlot）。侧栏 = 会话清单，两种
 * 形态可切（「# 分组」chip，持久化 pi-sidebar-grouped，默认分组）：
 *
 *   [headerSlot]              ← 移动端 = 抽屉头「工作区名 ▾」切换块；桌面不传
 *   [⊕ 新建任务      ⌘N]
 *   [🔍 搜索         ⌘K]
 *   [🧩 插件&技能]
 *   ─────────────────
 *   [# 分组]                  ← 开关 chip：开 = 按项目分组（ZCode 同款：项目名
 *    📂 pi                      静态组头 + 组内会话，每组 5 条 + 显示更多）；
 *      · 会话行…                关 = 全部会话平铺（跨项目最近活跃序，前 20 +
 *    🗑 归档                    显示更多一次性展开）
 *   ─────────────────
 *   设置 模型 Agents          ← 底部全局配置入口（不变）
 *
 * 组头是纯视觉分组（不可点/不可折叠）——工作区切换只走顶部面板（2026-09-27
 * 用户确认）。归档行 = 当前工作区回收站。
 */

/** 会话列表默认展示条数（分组模式每组 / 平铺模式整列）；超出收进「显示更多」。 */
const SESSION_PREVIEW_COUNT = 5;
const FLAT_PREVIEW_COUNT = 20;

/** 「分组」开关持久化键：缺省 = 分组开（用户默认心智）。 */
const GROUPED_KEY = "pi-sidebar-grouped";

/** 「项目」分区收起持久化键：缺省 = 展开。 */
const PROJECTS_COLLAPSED_KEY = "pi-projects-collapsed";

/** 分组折叠持久化键（组头点击收起/展开该项目会话）：值 = 已收起的工作区 id
 *  数组，缺省 = 全展开。沿用树时代的键，老用户的折叠偏移自动延续。 */
const COLLAPSED_KEY = "pi-tree-collapsed";

function loadGrouped(): boolean {
  try {
    const raw = localStorage.getItem(GROUPED_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function loadProjectsCollapsed(): boolean {
  try {
    return localStorage.getItem(PROJECTS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** 当前打开的配置整页 kind（导航入口高亮派生；null = 没开配置页）。桌面 =
 *  centerPage.kind 直传；移动端从设置目的地页的子页反推（子页值域比 kind 多
 *  index/skills/preferences，归并到宿主 kind）。 */
export type ActiveConfigPage = "settings" | "models" | "plugins" | "agents";

interface Props {
  workspaces: WorkspaceSummary[];
  allSessions: SessionInfo[];
  runningSessionIds: Set<string>;
  completedSessionIds: Set<string>;
  selectedSessionId: string | null;
  /** 当前工作区：组尾「归档」行的归属（会话清单不再按工作区过滤——分组模式
   *  列全部项目，平铺模式列全部最近会话）。null = 首页态（桌面无活动 tab）。 */
  activeWorkspace: WorkspaceSummary | null;
  /** 配置页高亮（2026-09 配置页拆分后 = 页粒度）。桌面 = centerPage.kind 直传；
   *  移动端从设置目的地页的子页反推。 */
  activeConfigPage: ActiveConfigPage | null;
  /** 方案二骨架门控：未加载时渲染骨架，不渲染假空态。 */
  workspacesLoaded: boolean;
  sessionsLoaded: boolean;
  /** 移动端抽屉/常驻树头部的「工作区名 ▾」切换块（内嵌 WorkspaceSwitcherPanel）。
   *  桌面不传——切换器在顶部工作区工具行。 */
  headerSlot?: ReactNode;
  onNewSession: () => void;
  /** 会话区组尾「归档」行 → 当前工作区回收站（桌面中央区整页 / 手机目的地页）。 */
  onOpenArchive: (workspace: WorkspaceSummary) => void;
  onSelectSession: (session: SessionInfo) => void;
  /** 搜索结果命中行：带 entryId/blockIndex 的深跳转（打开会话并定位到具体消息）。 */
  onSelectSearchHit: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  /** 会话列表版本（跨窗口同步）：变化时让进行中的搜索重新执行。 */
  sessionListVersion: number | null;
  onOpenSessionInNewTab: (session: SessionInfo) => void;
  onSessionRemoved: (id: string) => void;
  /** SearchPalette 内的「新建工作区/导入目录」建议操作（面板之外仍可达）。 */
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onOpenCenterPage: (page: CenterPage) => void;
}

/** 底部三入口（sidebar 底部一条 strip）。2026-09 ZCode 风格导航改版：插件/
 *  Skills 上移为顶部「插件&技能」导航行，底部只留 设置/模型/Agents；2026-09
 *  配置页拆分后各入口打开**各自独立整页**；同页再点 = 关闭，异页 = 原地切换。 */
const BOTTOM_ENTRIES: {
  kind: ActiveConfigPage;
  label: string;
  title: string;
  icon: React.ReactNode;
}[] = [
  {
    kind: "settings",
    label: "设置",
    title: "设置",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    kind: "models",
    label: "模型",
    title: "模型（models.json）",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2" />
        <path d="M15 20v2" />
        <path d="M9 2v2" />
        <path d="M9 20v2" />
        <path d="M2 15h2" />
        <path d="M2 9h2" />
        <path d="M20 15h2" />
        <path d="M20 9h2" />
      </svg>
    ),
  },
  {
    kind: "agents",
    label: "Agents",
    title: "Agents（子代理）",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="8" width="14" height="12" rx="2" />
        <circle cx="12" cy="14" r="2.4" />
        <path d="M12 11.6V9" />
        <path d="M9 3h6" /><path d="M12 3v5" />
      </svg>
    ),
  },
];

/** 项目头像配色：FNV-1a 哈希 → 精选 12 色相板（色相间隔大，相邻项目不易
 *  撞色），半透明同系底 + 饱和同系字色——明暗主题都可读。 */
function workspaceAvatarStyle(name: string): React.CSSProperties {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const palette = [3, 25, 48, 88, 130, 165, 195, 220, 250, 280, 310, 335];
  const hue = palette[Math.abs(hash) % palette.length];
  return {
    background: `hsl(${hue} 70% 50% / 0.16)`,
    color: `hsl(${hue} 72% 46%)`,
  };
}

/** 项目头像：名字首字（拉丁字符大写）+ 稳定配色的小圆角块。 */
function WorkspaceAvatar({ name }: { name: string }) {
  const first = [...name][0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: 5,
        fontSize: 10.5,
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
        ...workspaceAvatarStyle(name),
      }}
    >
      {first}
    </span>
  );
}

export function ProjectSidebar({
  workspaces,
  allSessions,
  runningSessionIds,
  completedSessionIds,
  selectedSessionId,
  activeWorkspace,
  activeConfigPage,
  workspacesLoaded,
  sessionsLoaded,
  headerSlot,
  onNewSession,
  onOpenArchive,
  onSelectSession,
  onSelectSearchHit,
  sessionListVersion,
  onOpenSessionInNewTab,
  onSessionRemoved,
  onCreateWorkspace,
  onImportDirectory,
  onOpenCenterPage,
}: Props) {
  const { t } = useI18n();
  // 搜索弹框（SearchPalette，ZCode 命令面板同款）：⌘K 或「搜索」行开合。
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  // 「# 分组」开关：SSR 先渲染默认（开），挂载后读持久化值——避免 hydration
  // mismatch（同旧折叠持久化的模式）。
  const [grouped, setGrouped] = useState(true);
  useEffect(() => {
    setGrouped(loadGrouped());
  }, []);
  const toggleGrouped = () => {
    setGrouped((prev) => {
      const next = !prev;
      try { localStorage.setItem(GROUPED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
    // 形态切换时复位两种临时展开态。
    setExpandedGroups(new Set());
    setShowAllFlat(false);
  };
  // 分组模式：每组「显示更多」展开（会话内临时态，不持久化）。
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  // 平铺模式：一次性展开全部。
  const [showAllFlat, setShowAllFlat] = useState(false);

  // 全局快捷键（ZCode 同款，导航行右侧有对应 ⌘ 提示）：⌘/Ctrl+N 新建任务、
  // ⌘/Ctrl+K 会话搜索。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        onNewSession();
      } else if (key === "k") {
        event.preventDefault();
        setSearchPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNewSession]);

  // 分组模式：全部项目的会话（保持传入列表序 = 手动排序）；平铺模式：全部
  // 会话按最近活跃（allSessions 即 activity 序，与首页「最近」同源）。
  const groups = groupSessionsByWorkspace(workspaces, allSessions, { orderBy: "workspaces" });
  const totalSessions = allSessions.length;

  // 「项目」分区收起（行尾 chevron）：SSR 先展开，挂载后读持久化值。
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  useEffect(() => {
    setProjectsCollapsed(loadProjectsCollapsed());
  }, []);
  const toggleProjectsCollapsed = () => {
    setProjectsCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(PROJECTS_COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  // 分组折叠（组头点击收起/展开该项目会话）：SSR 先全展开，挂载后读持久化。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);
  const toggleGroup = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  // 「项目」分区行的 ＋ 菜单（新建工作区/导入目录）——body-portal，钳进可视区。
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [plusRect, setPlusRect] = useState<MenuLayout | null>(null);
  useEffect(() => {
    if (!plusOpen) return;
    const rect = plusRef.current?.getBoundingClientRect();
    if (rect) {
      setPlusRect(computeMenuLayout({ anchor: rect, menuMinWidth: 170, maxMenuHeight: 200 }, readViewportWindow()));
    }
  }, [plusOpen]);

  const renderSessionRow = (session: SessionInfo) => {
    const sessActivity = runningSessionIds.has(session.id)
      ? "running"
      : completedSessionIds.has(session.id)
        ? "completed"
        : undefined;
    return (
      <SessionRow
        key={session.id}
        session={session}
        isSelected={selectedSessionId === session.id}
        activity={sessActivity}
        showTime
        rounded
        onSelect={() => onSelectSession(session)}
        onOpenInNewTab={() => onOpenSessionInNewTab(session)}
        onRemoved={onSessionRemoved}
      />
    );
  };

  const renderBody = () => {
    // 骨架门控：未加载时绝不渲染假空态。
    if (!workspacesLoaded || !sessionsLoaded) {
      return (
        <div style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 14, height: 14, borderRadius: 4, background: "var(--bg-hover)", flexShrink: 0 }} />
              <span style={{ height: 10, flex: 1, borderRadius: 5, background: "var(--bg-hover)", opacity: 1 - i * 0.25 }} />
            </div>
          ))}
        </div>
      );
    }
    return (
      <div style={{ padding: "4px 8px 12px" }}>
        {/* 分区标题「项目」行（ZCode 同款）：文件夹图标 + 标题（与导航行同
            字号 13px）+ 「# 分组」开关 chip；右侧 ＋ = 新建工作区/导入目录。
            左缩进 10px（+容器 8px = 18px）：与导航行图标列、组头图标同列对齐。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px 6px 10px" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-muted)" }}>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", userSelect: "none", flexShrink: 0 }}>
            项目
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={grouped}
            onClick={toggleGrouped}
            title={grouped ? "按项目分组中——点击切换为不分组（全部会话按最近排序）" : "不分组——点击切换为按项目分组"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 10px",
              border: 0,
              borderRadius: 999,
              background: grouped ? "var(--bg-selected)" : "transparent",
              color: grouped ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11.5,
              fontWeight: 500,
              transition: "background 0.1s, color 0.1s",
            }}
            onMouseEnter={(e) => { if (!grouped) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = grouped ? "var(--bg-selected)" : "transparent"; }}
          >
            <span aria-hidden style={{ fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1, color: grouped ? "var(--accent)" : "var(--text-dim)" }}>#</span>
            分组
          </button>
          <div style={{ flex: 1 }} />
          <button
            ref={plusRef}
            type="button"
            title="新建 / 导入工作区"
            aria-label="新建 / 导入工作区"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            onClick={() => setPlusOpen((open) => !open)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              border: 0,
              borderRadius: 5,
              background: plusOpen ? "var(--bg-hover)" : "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-dim)";
              e.currentTarget.style.background = plusOpen ? "var(--bg-hover)" : "transparent";
            }}
          >
            ＋
          </button>
          <button
            type="button"
            onClick={toggleProjectsCollapsed}
            title={projectsCollapsed ? "展开项目列表" : "收起项目列表"}
            aria-label={projectsCollapsed ? "展开项目列表" : "收起项目列表"}
            aria-expanded={!projectsCollapsed}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              border: 0,
              borderRadius: 5,
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              flexShrink: 0,
              transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: projectsCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        {!projectsCollapsed && (<>
        {grouped ? (
          groups.length === 0 ? (
            <div style={{ padding: "4px 10px", color: "var(--text-dim)", fontSize: 11 }}>
              暂无会话
            </div>
          ) : (
            groups.map((group) => {
              const groupCollapsed = collapsed.has(group.workspace.id);
              return (
              <section key={group.workspace.id} style={{ marginBottom: 2 }}>
                {/* 分组头（整行可点 = 收起/展开该项目会话，持久化 pi-tree-
                    collapsed）：项目首字头像（名字哈希稳定配色）+ 项目名 +
                    chevron + 会话数；工作区切换只走顶部「工作区名 ▾」面板。 */}
                <button
                  type="button"
                  onClick={() => toggleGroup(group.workspace.id)}
                  aria-expanded={!groupCollapsed}
                  aria-label={`${groupCollapsed ? "展开" : "收起"} ${group.workspace.name} 的会话`}
                  title={groupCollapsed ? `展开 ${group.workspace.name} 的会话` : `收起 ${group.workspace.name} 的会话`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "6px 10px 2px",
                    border: 0,
                    borderRadius: 6,
                    background: "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <WorkspaceAvatar name={group.workspace.name} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", userSelect: "none" }}>
                    {group.workspace.name}
                  </span>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)", transform: groupCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}>
                    <polyline points="2 3.5 5 6.5 8 3.5" />
                  </svg>
                  <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                    {group.sessions.length}
                  </span>
                </button>
                {!groupCollapsed && (
                <div style={{ paddingLeft: 8 }}>
                  {(expandedGroups.has(group.workspace.id)
                    ? group.sessions
                    : group.sessions.slice(0, SESSION_PREVIEW_COUNT)
                  ).map(renderSessionRow)}
                  {group.sessions.length > SESSION_PREVIEW_COUNT && (
                    <button
                      type="button"
                      onClick={() => setExpandedGroups((prev) => new Set([...prev, group.workspace.id]))}
                      title={`展开全部 ${group.sessions.length} 条会话`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 12px",
                        border: 0,
                        borderRadius: 6,
                        background: "transparent",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        fontSize: 11.5,
                        textAlign: "left",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="5" r="1" />
                        <circle cx="12" cy="12" r="1" />
                        <circle cx="12" cy="19" r="1" />
                      </svg>
                      显示更多（共 {group.sessions.length}）
                    </button>
                  )}
                </div>
                )}
              </section>
              );
            })
          )
        ) : totalSessions === 0 ? (
          <div style={{ padding: "4px 10px", color: "var(--text-dim)", fontSize: 11 }}>
            暂无会话
          </div>
        ) : (
          <>
            {(showAllFlat
              ? allSessions
              : allSessions.slice(0, FLAT_PREVIEW_COUNT)
            ).map(renderSessionRow)}
            {allSessions.length > FLAT_PREVIEW_COUNT && (
              <button
                type="button"
                onClick={() => setShowAllFlat(true)}
                title={`展开全部 ${allSessions.length} 条会话`}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 12px",
                  border: 0,
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 11.5,
                  textAlign: "left",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="5" r="1" />
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="12" cy="19" r="1" />
                </svg>
                显示更多（共 {allSessions.length}）
              </button>
            )}
          </>
        )}

        {/* 组尾「归档」行：当前工作区回收站（工作区作用域；顶部切换器换工作区
            时归档跟随）。 */}
        {activeWorkspace && (
          <button
            type="button"
            onClick={() => onOpenArchive(activeWorkspace)}
            title={`归档（${activeWorkspace.name} 回收站）`}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "5px 10px",
              marginTop: 2,
              border: 0,
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11.5,
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            归档
          </button>
        )}
        </>)}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 移动端：抽屉/常驻树头部的「工作区名 ▾」切换块（WorkspaceSwitcherPanel
          内联展开）；桌面不传（切换器在顶部工作区工具行）。 */}
      {headerSlot}

      {/* 顶部导航（2026-09 ZCode 风格改版）：三行安静导航行。 */}
      <nav aria-label="主导航" style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 8px 4px", flexShrink: 0 }}>
        <NavRow
          label="新建任务"
          hint="⌘N"
          title="新建任务（当前工作区；⌘N）"
          onClick={onNewSession}
          icon={
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="5" />
              <path d="M12 8v8" /><path d="M8 12h8" />
            </svg>
          }
        />
        <NavRow
          label="搜索"
          hint="⌘K"
          active={searchPaletteOpen}
          ariaHasPopup="dialog"
          title={`${t("sidebar.toggleSessionSearch")}（⌘K）`}
          onClick={() => setSearchPaletteOpen((open) => !open)}
          icon={
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
            </svg>
          }
        />
        <NavRow
          label="插件&技能"
          title="插件 & 技能"
          active={activeConfigPage === "plugins"}
          onClick={() => onOpenCenterPage({ kind: "plugins" })}
          icon={
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
            </svg>
          }
        />
      </nav>

      {/* 会话主体：「# 分组」chip + 分组（项目静态组头）/平铺（最近活跃）两
          形态 + 组尾归档行（当前工作区）。 */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>{renderBody()}</div>

      {/* 搜索弹框（⌘K / 搜索行开合）：全文检索命中行支持 entryId/blockIndex
          深跳转（onSelectSearchHit）；无词时展示最近任务 + 建议操作。 */}
      <SearchPalette
        open={searchPaletteOpen}
        onClose={() => setSearchPaletteOpen(false)}
        allSessions={allSessions}
        selectedSessionId={selectedSessionId}
        refreshKey={sessionListVersion}
        onSelectSession={onSelectSearchHit}
        onNewSession={onNewSession}
        onCreateWorkspace={onCreateWorkspace}
        onImportDirectory={onImportDirectory}
        onOpenCenterPage={onOpenCenterPage}
      />

      {/* 底部三入口：设置 / 模型 / Agents（全局配置心智）。 */}
      <div
        role="tablist"
        aria-label="全局配置"
        style={{
          display: "flex",
          gap: 2,
          padding: "6px 8px calc(6px + env(safe-area-inset-bottom, 0px))",
          flexShrink: 0,
          borderTop: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        {BOTTOM_ENTRIES.map((entry) => {
          const active = activeConfigPage === entry.kind;
          return (
            <button
              key={entry.kind}
              type="button"
              role="tab"
              aria-selected={active}
              title={entry.title}
              aria-label={entry.label}
              onClick={() => onOpenCenterPage({ kind: entry.kind })}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
                height: 44,
                padding: 0,
                border: 0,
                borderRadius: 8,
                background: active ? "var(--bg-selected)" : "transparent",
                color: active ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                position: "relative",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
            >
              {active && (
                <span aria-hidden style={{ position: "absolute", top: 6, left: 14, right: 14, height: 2, borderRadius: 1, background: "var(--accent)" }} />
              )}
              {entry.icon}
              <span style={{ fontSize: 10, lineHeight: 1 }}>{entry.label}</span>
            </button>
          );
        })}
      </div>
      {/* 「项目＋」菜单（新建工作区/导入目录）——body-portal，钳进可视区。 */}
      {plusOpen && plusRect && createPortal(
        <>
          <div aria-hidden="true" onClick={() => setPlusOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 2000 }} />
          <div
            role="menu"
            aria-label="工作区"
            style={{
              position: "fixed",
              top: plusRect.top,
              right: plusRect.right,
              zIndex: 2001,
              minWidth: 170,
              padding: 4,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => { setPlusOpen(false); onCreateWorkspace(); }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "7px 9px",
                border: 0,
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                textAlign: "left",
              }}
            >
              新建工作区…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setPlusOpen(false); onImportDirectory(); }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "7px 9px",
                border: 0,
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                textAlign: "left",
              }}
            >
              导入目录…
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** 顶部导航行（ZCode 风格安静行）：图标 + 文案左对齐，可选 ⌘ 提示靠右；
 *  整行 hover 圆角底，active = bg-selected 高亮。ariaHasPopup 透传（搜索行
 *  打开的弹框语义）。 */
function NavRow({
  icon,
  label,
  hint,
  title,
  active,
  onClick,
  ariaHasPopup,
}: {
  icon: React.ReactNode;
  label: string;
  /** 右侧快捷键提示（如 ⌘N）；无则不渲染。 */
  hint?: string;
  title: string;
  active?: boolean;
  onClick: () => void;
  ariaHasPopup?: "dialog" | "menu";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? "true" : undefined}
      aria-haspopup={ariaHasPopup}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 10px",
        border: 0,
        borderRadius: 8,
        background: active ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 13,
        textAlign: "left",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = active ? "var(--bg-selected)" : "transparent"; }}
    >
      <span style={{ display: "flex", flexShrink: 0, color: active ? "var(--accent)" : "var(--text-muted)" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {hint && (
        <span style={{ flexShrink: 0, fontSize: 11, lineHeight: 1, color: "var(--text-dim)", letterSpacing: 0.5 }}>
          {hint}
        </span>
      )}
    </button>
  );
}
