"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
 * 组头整行可点收起/展开该项目会话（无 chevron，2026-10 用户反馈去箭头；行高
 * 与会话行同高——共享 --pi-sidebar-row-py/--pi-sidebar-fs）——工作区切换只走顶部面板（2026-09-27 用户确认）；长按 300ms 拖拽
 * 排序项目（上半/下半 = 插前/插后，全量 PATCH，onReorderWorkspaces 在场时）。
 * 归档行 = 当前工作区回收站。
 */

/** 会话列表默认展示条数（分组模式每组 / 平铺模式整列）；超出收进「显示更多」。 */
const SESSION_PREVIEW_COUNT = 5;
const FLAT_PREVIEW_COUNT = 20;

/** 「分组」开关持久化键：缺省 = 分组开（用户默认心智）。 */
const GROUPED_KEY = "pi-sidebar-grouped";

/** 「项目」分区收起持久化键：缺省 = 展开。 */
const PROJECTS_COLLAPSED_KEY = "pi-projects-collapsed";

/** 分组折叠持久化键（组头点击收起/展开该项目会话）：值 = 已收起的工作区 id
 * 数组，缺省 = 全展开。沿用树时代的键，老用户的折叠偏移自动延续。 */
const COLLAPSED_KEY = "pi-tree-collapsed";

/** 项目分组行长按进入拖拽排序的等待时长（ms）；按下后位移超过 6px 视为点击/
 * 滚动意图，取消长按。 */
const DRAG_LONG_PRESS_MS = 300;
const DRAG_MOVE_SLOP_PX = 6;

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
  /** 项目分组行长按拖拽排序（全量 PATCH 期望序；组件内拼好停用/不可用项的
   *  现序垫底）。缺省不传 = 不启用长按排序。 */
  onReorderWorkspaces?: (ids: string[]) => void;
  /** 分组头项目头像点击 → 打开该项目首页（桌面 = 工作区家 tab；移动端 =
   *  ensureWorkspaceContext + 总览目的地页）。缺省不传 = 头像不可点（点击
   *  落到整行 = 收起/展开，行为同旧）。 */
  onOpenWorkspaceHome?: (workspace: WorkspaceSummary) => void;
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
  /** 手机壳会话首页宿主（MobileTabShell，2026-10 底部 tab 改版）：只渲染「项目」
   *  分区头 + 分组/平铺会话体——顶部导航三行、内置 SearchPalette、组尾归档行、
   *  底部 设置/模型/Agents 条全部不渲染（手机由 tab 栏 / 首页顶栏 / 工作区页
   *  承担这些入口）。桌面与平板常驻树缺省 = 全量。 */
  phoneHome?: boolean;
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
 *  撞色），半透明同系底 + 饱和同系字色——明暗主题都可读。（导出供
 *  WorkspaceOverview 头像复用同一份配色。） */
export function workspaceAvatarStyle(name: string): React.CSSProperties {
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

/** 项目头像：名字首字（拉丁字符大写）+ 稳定配色的小圆角块。尺寸跟会话行
 *  字号走（fs+3px，桌面 16 / ≤640px 17）——不超出文本行盒，分组头高度由
 *  共享的 --pi-sidebar-row-py 驱动，与会话行保持同高。 */
function WorkspaceAvatar({ name }: { name: string }) {
  const first = [...name][0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "calc(var(--pi-sidebar-fs) + 3px)",
        height: "calc(var(--pi-sidebar-fs) + 3px)",
        borderRadius: 5,
        fontSize: "calc(var(--pi-sidebar-fs) - 2.5px)",
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
  onReorderWorkspaces,
  onOpenWorkspaceHome,
  onSelectSession,
  onSelectSearchHit,
  sessionListVersion,
  onOpenSessionInNewTab,
  onSessionRemoved,
  onCreateWorkspace,
  onImportDirectory,
  onOpenCenterPage,
  phoneHome = false,
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

  // ---- 项目分组行长按拖拽排序（2026-10 用户反馈）：长按 300ms 进入拖拽（拖
  //  动前位移超 6px 即取消——不抢点击/滚动），拖到目标行上半/下半 = 插前/插后
  //（与顶部工作区切换面板同语义）；松手 onReorderWorkspaces 全量序（停用/
  //  不可用项保持现序垫底）。指针捕获保证拖出列表仍收事件；touch 拖拽中以
  //  非 passive 文档级 touchmove preventDefault 锁滚动；窗口级 backstop 兜底
  //  捕获失败/中途卸载的收尾（teardownDrag 幂等）。 ----------------------------
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string; position: "before" | "after" } | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressRef = useRef<{ id: string; x: number; y: number; pointerId: number } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragYRef = useRef<number | null>(null);
  const dropHintRef = useRef<{ targetId: string; position: "before" | "after" } | null>(null);
  const suppressClickRef = useRef(false);
  const headerElsRef = useRef(new Map<string, HTMLElement>());
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);
  const touchBlockRef = useRef<((event: TouchEvent) => void) | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const clearPress = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    pressRef.current = null;
  }, []);

  const updateDropHint = (next: { targetId: string; position: "before" | "after" } | null) => {
    const prev = dropHintRef.current;
    if (prev && next && prev.targetId === next.targetId && prev.position === next.position) return;
    dropHintRef.current = next;
    setDropHint(next);
  };

  /** 最近行命中：行内按上半/下半定插前/插后，行外取最近一端（拖到会话行上也能落）。 */
  const headerHitTest = (clientY: number): { targetId: string; position: "before" | "after" } | null => {
    let best: { targetId: string; position: "before" | "after" } | null = null;
    let bestDist = Infinity;
    for (const group of groups) {
      const el = headerElsRef.current.get(group.workspace.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      let position: "before" | "after";
      let dist: number;
      if (clientY < rect.top) {
        position = "before";
        dist = rect.top - clientY;
      } else if (clientY > rect.bottom) {
        position = "after";
        dist = clientY - rect.bottom;
      } else {
        position = clientY > rect.top + rect.height / 2 ? "after" : "before";
        dist = 0;
      }
      if (dist < bestDist) {
        bestDist = dist;
        best = { targetId: group.workspace.id, position };
      }
    }
    return best;
  };

  /** 拖拽中每帧：指针停在滚动容器边缘时自动滚 + 重算落点（内容在指针下移动）。 */
  const autoScrollStep = () => {
    autoScrollRafRef.current = null;
    const y = dragYRef.current;
    const el = listScrollRef.current;
    if (!dragIdRef.current || y == null || !el) return;
    const rect = el.getBoundingClientRect();
    const edge = 48;
    if (y < rect.top + edge) el.scrollTop -= Math.max(2, (rect.top + edge - y) / 4);
    else if (y > rect.bottom - edge) el.scrollTop += Math.max(2, (y - (rect.bottom - edge)) / 4);
    updateDropHint(headerHitTest(y));
    if (dragIdRef.current) autoScrollRafRef.current = window.requestAnimationFrame(autoScrollStep);
  };

  const commitReorder = (targetId: string, position: "before" | "after") => {
    const dragged = dragIdRef.current;
    if (!dragged || !onReorderWorkspaces || targetId === dragged) return;
    const visibleIds = groups.map((group) => group.workspace.id);
    const next = visibleIds.filter((id) => id !== dragged);
    const at = next.indexOf(targetId);
    if (at < 0) return;
    next.splice(position === "after" ? at + 1 : at, 0, dragged);
    // 全量序：未入分组清单的停用/不可用项保持现序垫底（updateWorkspaceOrder
    // 对未提及条目会删 sortOrder，不能传部分列表）。
    const visible = new Set(visibleIds);
    const tail = workspaces.filter((w) => !visible.has(w.id)).map((w) => w.id);
    onReorderWorkspaces([...next, ...tail]);
  };

  const teardownDrag = useCallback(() => {
    clearPress();
    dragIdRef.current = null;
    dragYRef.current = null;
    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    if (touchBlockRef.current) {
      document.removeEventListener("touchmove", touchBlockRef.current);
      touchBlockRef.current = null;
    }
    if (dragCleanupRef.current) {
      dragCleanupRef.current();
      dragCleanupRef.current = null;
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, [clearPress]);

  const endDrag = () => {
    teardownDrag();
    updateDropHint(null);
    setDragId(null);
    // click 在 pointerup 之后同步派发；宏任务复位，避免长按后误吞下一次点击。
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  const startDrag = (id: string, pointerId: number) => {
    dragIdRef.current = id;
    suppressClickRef.current = true; // 长按语义：随后的 click 不触发组折叠
    setDragId(id);
    try { headerElsRef.current.get(id)?.setPointerCapture(pointerId); } catch { /* 元素已卸载则忽略 */ }
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    if (!touchBlockRef.current) {
      const block = (event: TouchEvent) => { if (dragIdRef.current) event.preventDefault(); };
      document.addEventListener("touchmove", block, { passive: false });
      touchBlockRef.current = block;
    }
    // 捕获失败兜底：窗口级 pointerup/pointercancel 收尾。
    const backstop = () => {
      if (!dragIdRef.current) return;
      const hint = dropHintRef.current;
      if (hint) commitReorder(hint.targetId, hint.position);
      endDrag();
    };
    const cancelBackstop = () => { if (dragIdRef.current) endDrag(); };
    window.addEventListener("pointerup", backstop);
    window.addEventListener("pointercancel", cancelBackstop);
    dragCleanupRef.current = () => {
      window.removeEventListener("pointerup", backstop);
      window.removeEventListener("pointercancel", cancelBackstop);
    };
    if (autoScrollRafRef.current === null) autoScrollRafRef.current = window.requestAnimationFrame(autoScrollStep);
  };

  // 卸载兜底：清计时器/rAF/文档级监听（不 setState）。
  useEffect(() => () => { teardownDrag(); }, [teardownDrag]);

  const onGroupHeaderPointerDown = (event: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (!onReorderWorkspaces) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearPress();
    pressRef.current = { id, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    pressTimerRef.current = window.setTimeout(() => {
      const press = pressRef.current;
      if (press) startDrag(press.id, press.pointerId);
    }, DRAG_LONG_PRESS_MS);
  };

  const onGroupHeaderPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragIdRef.current) {
      dragYRef.current = event.clientY;
      updateDropHint(headerHitTest(event.clientY));
      return;
    }
    const press = pressRef.current;
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (dx * dx + dy * dy > DRAG_MOVE_SLOP_PX * DRAG_MOVE_SLOP_PX) clearPress();
  };

  const onGroupHeaderPointerUp = () => {
    if (!dragIdRef.current) {
      clearPress();
      return;
    }
    const hint = dropHintRef.current;
    if (hint) commitReorder(hint.targetId, hint.position);
    endDrag();
  };

  const onGroupHeaderPointerCancel = () => {
    if (dragIdRef.current) endDrag();
    else clearPress();
  };

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
            字号 13px）整体可点 = 收起/展开项目列表（无 chevron——2026-10 用户
            反馈去箭头，行高稍增）+ 「# 分组」开关 chip；右侧 ＋ = 新建工作区/
            导入目录。左缩进 10px（+容器 8px = 18px）：与导航行图标列、组头
            图标同列对齐。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px 7px 10px" }}>
          <button
            type="button"
            onClick={toggleProjectsCollapsed}
            title={projectsCollapsed ? "展开项目列表" : "收起项目列表"}
            aria-label={projectsCollapsed ? "展开项目列表" : "收起项目列表"}
            aria-expanded={!projectsCollapsed}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "2px 4px 2px 0",
              border: 0,
              borderRadius: 4,
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-muted)" }}>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", userSelect: "none", flexShrink: 0 }}>
              项目
            </span>
          </button>
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
                    collapsed；无 chevron——2026-10 用户反馈去箭头；行高与会话
                    行同高 = 共享 --pi-sidebar-row-py/--pi-sidebar-fs，桌面/窄
                    屏两档密度自动一致）：项目首字头像（名字哈希稳定配色）+
                    项目名 + 会话数；长按 300ms 拖拽排序项目
                    （onReorderWorkspaces 在场时）。 */}
                <button
                  type="button"
                  ref={(el) => {
                    if (el) headerElsRef.current.set(group.workspace.id, el);
                    else headerElsRef.current.delete(group.workspace.id);
                  }}
                  onClick={() => {
                    if (suppressClickRef.current) return; // 长按/拖拽松手不吃组折叠
                    toggleGroup(group.workspace.id);
                  }}
                  onPointerDown={(event) => onGroupHeaderPointerDown(event, group.workspace.id)}
                  onPointerMove={onGroupHeaderPointerMove}
                  onPointerUp={onGroupHeaderPointerUp}
                  onPointerCancel={onGroupHeaderPointerCancel}
                  onPointerLeave={() => { if (!dragIdRef.current) clearPress(); }}
                  aria-expanded={!groupCollapsed}
                  aria-label={`${groupCollapsed ? "展开" : "收起"} ${group.workspace.name} 的会话`}
                  title={`${groupCollapsed ? "展开" : "收起"} ${group.workspace.name} 的会话${onReorderWorkspaces ? "（长按可拖动排序）" : ""}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "var(--pi-sidebar-row-py) 10px var(--pi-sidebar-row-py)",
                    border: 0,
                    borderRadius: 6,
                    background: dragId === group.workspace.id ? "var(--bg-selected)" : "transparent",
                    cursor: dragId ? "grabbing" : "pointer",
                    textAlign: "left",
                    transition: "background 0.1s, opacity 0.15s ease",
                    opacity: dragId === group.workspace.id ? 0.55 : 1,
                    position: "relative",
                    userSelect: "none",
                    WebkitTouchCallout: "none",
                  }}
                  onMouseEnter={(e) => { if (dragId !== group.workspace.id) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = dragId === group.workspace.id ? "var(--bg-selected)" : "transparent"; }}
                >
                  {dragId && dropHint && dropHint.targetId === group.workspace.id && dropHint.targetId !== dragId && (
                    <span
                      aria-hidden
                      className="workspace-drop-line"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        height: 2,
                        borderRadius: 2,
                        background: "var(--accent)",
                        boxShadow: "0 0 4px color-mix(in srgb, var(--accent) 45%, transparent)",
                        ...(dropHint.position === "before" ? { top: -3 } : { bottom: -3 }),
                      }}
                    />
                  )}
                  {/* 项目头像 = 打开项目首页的入口（2026-10 用户反馈）：点击
                      stopPropagation 不触发整行收起/展开；长按仍可起拖拽
                      （pointerdown 冒泡到组头按钮）。 */}
                  <span
                    role="button"
                    tabIndex={onOpenWorkspaceHome ? 0 : undefined}
                    aria-label={`打开 ${group.workspace.name} 首页`}
                    title={`打开 ${group.workspace.name} 首页`}
                    onClick={(event) => {
                      if (!onOpenWorkspaceHome) return;
                      event.stopPropagation();
                      onOpenWorkspaceHome(group.workspace);
                    }}
                    onKeyDown={(event) => {
                      if (!onOpenWorkspaceHome) return;
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenWorkspaceHome(group.workspace);
                    }}
                    onMouseEnter={(e) => { if (onOpenWorkspaceHome) e.currentTarget.style.boxShadow = "0 0 0 2px var(--accent)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.boxShadow = ""; }}
                    style={{ display: "flex", flexShrink: 0, borderRadius: 6, cursor: onOpenWorkspaceHome ? "pointer" : undefined }}
                  >
                    <WorkspaceAvatar name={group.workspace.name} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: "var(--pi-sidebar-fs)", fontWeight: 600, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", userSelect: "none" }}>
                    {group.workspace.name}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: "var(--pi-sidebar-fs-meta)", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
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
            时归档跟随）。手机首页不渲染（归档住工作区页底部）。 */}
        {activeWorkspace && !phoneHome && (
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

      {/* 顶部导航（2026-09 ZCode 风格改版）：三行安静导航行。手机首页不渲染
          （新建 = FAB，搜索 = 首页顶栏，插件&技能 = Skill tab / 设置 tab）。 */}
      {!phoneHome && (
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
      )}

      {/* 会话主体：「# 分组」chip + 分组（项目静态组头）/平铺（最近活跃）两
          形态 + 组尾归档行（当前工作区）。滚动容器兼作长按拖拽排序的自动滚
          边界（listScrollRef）。 */}
      <div ref={listScrollRef} style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", paddingBottom: phoneHome ? 88 : 0 }}>{renderBody()}</div>

      {/* 搜索弹框（⌘K / 搜索行开合）：全文检索命中行支持 entryId/blockIndex
          深跳转（onSelectSearchHit）；无词时展示最近任务 + 建议操作。手机首页
          由壳自己挂 SearchPalette（顶栏搜索按钮）。 */}
      {!phoneHome && (
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
      )}

      {/* 底部三入口：设置 / 模型 / Agents（全局配置心智）。手机首页不渲染
          （设置 tab 承担）。 */}
      {!phoneHome && (
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
                <span aria-hidden style={{ position: "absolute", bottom: 4, left: 14, right: 14, height: 2, borderRadius: 1, background: "var(--accent)" }} />
              )}
              {entry.icon}
              <span style={{ fontSize: 10, lineHeight: 1 }}>{entry.label}</span>
            </button>
          );
        })}
      </div>
      )}
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
