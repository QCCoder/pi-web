"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { groupSessionsByWorkspace } from "@/lib/home-quick-switch";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { computeMenuLayout, readViewportWindow, type MenuLayout } from "@/lib/dropdown-layout";
import { useI18n } from "@/hooks/useI18n";
import type { CenterPage, SettingsPage } from "./shell/useAppShellState";
import { SessionRow } from "./SessionRow";
import { SearchPalette } from "./SearchPalette";

/**
 * 项目树侧栏（2026-09 ZCode 风格导航改版：顶部三行安静导航 + 项目树 + 底部
 * 配置入口）。结构：
 *
 *   [⊕ 新建任务      ⌘N]  ← 新会话 composer 入口（复用现有行为）；⌘/Ctrl+N
 *                          全局快捷键。折叠由 ChatToolbar 的 ☰ 开关承担
 *   [🔍 搜索         ⌘K]  ← 打开搜索弹框（SearchPalette：全文检索深跳转 +
 *                          最近任务/建议/操作，ZCode 命令面板同款）；⌘/Ctrl+K
 *   [🧩 插件&技能]        ← 设置页（预选插件分区；Skills 经设置页左索引切换）
 *   项目             ＋   ← 分区标题；＋ → 新建/导入工作区
 *   📂 pi     🏠 🗑      ← 节点（缩进一级）：整行 = 展开/折叠；hover 右侧
 *                           出现 工作区首页/归档 两个快捷按钮
 *      · 会话行…（默认 5 条，更多收进「显示更多」）
 *   …暗淡行（已停用工作区 hover ⚙ 去设置重启用 / 不可用工作区）
 *   ─────────────────
 *   设置 模型 Agents      ← 底部入口（全局配置心智）→ 中央区设置整页
 *
 * 作用域即位置：树 = 工作区资源（会话/归档），顶部+底部 = 全局入口（打开时
 * 可带工作区上下文）。工作项/Loops/知识库/文件不进树（右坞 + 总览 hub 不变）。
 * 折叠状态（哪些工作区节点收起）持久化在 localStorage。
 */

const COLLAPSED_KEY = "pi-tree-collapsed";

/** 会话列表每组默认展示条数；超出收进「显示更多」（会话内临时展开，不持久化）。 */
const SESSION_PREVIEW_COUNT = 5;

interface Props {
  workspaces: WorkspaceSummary[];
  allSessions: SessionInfo[];
  runningSessionIds: Set<string>;
  completedSessionIds: Set<string>;
  selectedSessionId: string | null;
  /** 当前打开的中央区整页（底部入口高亮）。 */
  centerPage: CenterPage | null;
  /** 设置页当前分区（live settingsPage，仅在设置页打开时非 null）——底部入口
   *  的高亮跟随设置页内左索引列的实时切换，而非打开时的入口。 */
  settingsSection: Exclude<SettingsPage, "index"> | null;
  /** 方案二骨架门控：未加载时渲染骨架，不渲染假空态。 */
  workspacesLoaded: boolean;
  sessionsLoaded: boolean;
  onNewSession: () => void;
  /** 节点行 hover 的「工作区首页」按钮 → 开/激活该工作区总览（家 tab）。 */
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
  /** 节点行 hover 的「归档」按钮 → 中央区归档页（工作区作用域就地）。 */
  onOpenArchive: (workspace: WorkspaceSummary) => void;
  /** 树底暗淡行（已停用工作区）的 ⚙ → 设置›工作区预选（重启用路径，
   *  2026-09 修复：停用的工作区从树/选择器全部消失后，设置是唯一入口）。 */
  onOpenWorkspaceSettings?: (workspace: WorkspaceSummary) => void;
  onSelectSession: (session: SessionInfo) => void;
  /** 搜索结果命中行：带 entryId/blockIndex 的深跳转（打开会话并定位到具体消息）。 */
  onSelectSearchHit: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  /** 会话列表版本（跨窗口同步）：变化时让进行中的搜索重新执行。 */
  sessionListVersion: number | null;
  onOpenSessionInNewTab: (session: SessionInfo) => void;
  onSessionRemoved: (id: string) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onOpenCenterPage: (page: CenterPage) => void;
  /** 工作区拖拽排序（2026-09）：drop 后上报全量期望序（重排后的分组 + 隐藏项
   *  垫底）→ shell PATCH /api/workspaces { order } 并重拉。 */
  onReorderWorkspaces?: (ids: string[]) => void;
  /** 工作区级聚合活动（running/completed）——节点上的状态点。 */
  workspaceActivity: Record<string, "running" | "completed" | undefined>;
  /** 移动端抽屉变体（docs/mobile-drawer-design.md §3）：展开的工作区节点下、
   *  会话行上方渲染模块行（文件/工作项/知识库/Loops，capability 门控），节点
   *  快捷动作改为常显 ＋/🗑（触屏无 hover）。桌面不传，零改动。 */
  showModuleRows?: boolean;
  onOpenModule?: (workspace: WorkspaceSummary, module: "files" | "work-items" | "knowledge" | "loops") => void;
  onNewSessionInWorkspace?: (workspace: WorkspaceSummary) => void;
}

/** 底部三入口（sidebar 底部一条 strip）。2026-09 ZCode 风格导航改版：插件/
 *  Skills 上移为顶部「插件&技能」导航行，底部只留 设置/模型/Agents；入口统一
 *  路由到设置页并预选对应分区（设置 → 工作区分区，即设置页默认落地）；同分区
 *  再点 = 关闭，异分区 = 原地切换。 */
const BOTTOM_ENTRIES: {
  section: Exclude<SettingsPage, "index">;
  label: string;
  title: string;
  icon: React.ReactNode;
}[] = [
  {
    section: "workspace",
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
    section: "models",
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
    section: "agents",
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

export function ProjectSidebar({
  workspaces,
  allSessions,
  runningSessionIds,
  completedSessionIds,
  selectedSessionId,
  centerPage,
  settingsSection,
  workspacesLoaded,
  sessionsLoaded,
  onNewSession,
  onOpenWorkspace,
  onOpenArchive,
  onSelectSession,
  onSelectSearchHit,
  sessionListVersion,
  onOpenSessionInNewTab,
  onSessionRemoved,
  onCreateWorkspace,
  onImportDirectory,
  onOpenCenterPage,
  onOpenWorkspaceSettings,
  onReorderWorkspaces,
  workspaceActivity,
  showModuleRows,
  onOpenModule,
  onNewSessionInWorkspace,
}: Props) {
  const { t } = useI18n();
  // 搜索弹框（SearchPalette，ZCode 命令面板同款）：⌘K 或「搜索」行开合。
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  // 折叠状态：SSR 先空（服务端无 localStorage），挂载后读取持久化值——避免
  // 服务端/客户端首帧不一致的 hydration mismatch（同 sidebarWidth 的模式）。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setCollapsed(loadCollapsed());
    setHydrated(true);
  }, []);
  const persistCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    if (!hydrated) setHydrated(true);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
  };
  const toggleGroup = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    persistCollapsed(next);
  };

  // 全局快捷键（ZCode 同款，导航行右侧有对应 ⌘ 提示）：⌘/Ctrl+N 新建任务、
  // ⌘/Ctrl+K 会话搜索。浏览器可能保留 ⌘N（拦不下就交还浏览器），Ctrl+N/K、
  // PWA 与桌面包装环境仍可命中。
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

  // ＋ 菜单（新建工作区 / 导入目录）与「新建任务 ▾」工作区菜单——body-portal，
  // computeMenuLayout 钳进可视区。
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [plusRect, setPlusRect] = useState<MenuLayout | null>(null);
  // 「显示更多」展开的工作区（会话内临时态，不持久化）。
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!plusOpen) return;
    const rect = plusRef.current?.getBoundingClientRect();
    if (rect) {
      setPlusRect(computeMenuLayout({ anchor: rect, menuMinWidth: 170, maxMenuHeight: 200 }, readViewportWindow()));
    }
  }, [plusOpen]);

  // 工作区分组保持传入列表顺序（= 手动排序；discover：手动序在前 + 未设
  // 置条目 MRU 垫底）——树不按活跃度自动重排，用户拖过之后全列表固定。
  const groups = groupSessionsByWorkspace(workspaces, allSessions, { orderBy: "workspaces" });
  // 树底暗淡行：不在树形分组里的工作区 = 用户停用的 + 目录/配置不可用的。
  // 停用的工作区在首页/选择器全部隐藏，但「能找回」是硬要求——暗淡行 +
  // hover ⚙ 直达设置›工作区（预选该工作区，重新启用一键可达，2026-09 修复）。
  const hiddenWorkspaces = workspaces.filter(
    (workspace) => !workspace.available || workspace.disabled,
  );

  // ---- 工作区拖拽排序（同设置›工作区 rail 的 HTML5 DnD 模式）---------------
  // drop 到目标节点上 = 插到它前面；drop 到列表尾空区 = 移到末尾；一次拖放 =
  // PATCH 全量期望序。只重排树内可见（可选用）工作区，隐藏项保持现序垫底。
  // dropHint：拖动时的插入指示线（节点上半 = 插到它前面、下半 = 插到它后面；
  // targetId null = 列表尾），带入场动画——没有它拖动时看不出会落在哪。
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string | null; position: "before" | "after" } | null>(null);
  const clearDrag = () => {
    setDraggedWorkspaceId(null);
    setDropHint(null);
  };
  const moveDraggedWorkspace = (targetId: string | null, position: "before" | "after") => {
    if (!draggedWorkspaceId || !onReorderWorkspaces) return;
    if (targetId === draggedWorkspaceId) return;
    const groupIds = groups.map((group) => group.workspace.id);
    const next = groupIds.filter((id) => id !== draggedWorkspaceId);
    if (targetId === null) {
      next.push(draggedWorkspaceId);
    } else {
      const at = next.indexOf(targetId);
      if (at < 0) return;
      next.splice(position === "after" ? at + 1 : at, 0, draggedWorkspaceId);
    }
    // 全量：重排后的可见序 + 未入树（停用/不可用）保持现序垫底——
    // updateWorkspaceOrder 会删掉未提及条目的 sortOrder，不能只传部分。
    const visible = new Set(groupIds);
    const tail = workspaces.filter((workspace) => !visible.has(workspace.id)).map((workspace) => workspace.id);
    onReorderWorkspaces([...next, ...tail]);
  };

  const renderBody = () => {
    // 骨架门控：未加载时绝不渲染「尚无工作区」假空态。
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
    if (groups.length === 0 && hiddenWorkspaces.length === 0) {
      return (
        <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
          尚无项目——点右上 ＋ 新建或导入。
        </div>
      );
    }
    return (
      <div
        style={{ padding: "4px 8px 12px" }}
        onDragOver={(event) => {
          if (draggedWorkspaceId) {
            event.preventDefault();
            setDropHint({ targetId: null, position: "after" });
          }
        }}
        onDrop={(event) => {
          // 列表尾空区 = 移到末位（行内 drop 会 stopPropagation，不会到这里）。
          if (!draggedWorkspaceId) return;
          event.preventDefault();
          moveDraggedWorkspace(null, "after");
          clearDrag();
        }}
      >
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.workspace.id);
          const activity = workspaceActivity[group.workspace.id];
          return (
            <section key={group.workspace.id} style={{ marginBottom: 4 }}>
              {/* 工作区节点（不选中高亮——树只是组织结构，选中的是会话）：
                  整行 = 展开/折叠开关；hover 时右侧出现 工作区首页/归档 两个
                  快捷按钮（取代徽章/计数，SessionRow 同款模式）。左缩进一级。 */}
              <div style={{ paddingLeft: 8 }}>
                <WorkspaceNodeRow
                  workspace={group.workspace}
                  sessionCount={group.sessions.length}
                  isCollapsed={isCollapsed}
                  activity={activity}
                  dragging={draggedWorkspaceId === group.workspace.id}
                  reorderable={Boolean(onReorderWorkspaces)}
                  dropHint={dropHint?.targetId === group.workspace.id ? dropHint.position : null}
                  onDragStart={() => setDraggedWorkspaceId(group.workspace.id)}
                  onDragEnd={clearDrag}
                  onDragOverPosition={(position) => setDropHint({ targetId: group.workspace.id, position })}
                  onDropOn={(position) => {
                    moveDraggedWorkspace(group.workspace.id, position);
                    clearDrag();
                  }}
                  onToggle={() => toggleGroup(group.workspace.id)}
                  onOpenHome={onOpenWorkspace}
                  onOpenArchive={onOpenArchive}
                  mobileActions={showModuleRows && onNewSessionInWorkspace ? {
                    onNewSession: () => onNewSessionInWorkspace(group.workspace),
                    onOpenArchive: () => onOpenArchive(group.workspace),
                  } : undefined}
                />
              </div>

              {!isCollapsed && (
                <div style={{ paddingLeft: 8 }}>
                  {showModuleRows && onOpenModule && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, padding: "1px 2px 3px 12px" }}>
                      <ModuleRow
                        label="文件"
                        title={`文件（${group.workspace.name}）`}
                        icon={
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                        }
                        onClick={() => onOpenModule(group.workspace, "files")}
                      />
                      {group.workspace.capabilities.includes("work-items") && (
                        <ModuleRow
                          label="工作项"
                          title={`工作项（${group.workspace.name}）`}
                          icon={
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                            </svg>
                          }
                          onClick={() => onOpenModule(group.workspace, "work-items")}
                        />
                      )}
                      {group.workspace.capabilities.includes("knowledge") && (
                        <ModuleRow
                          label="知识库"
                          title={`知识库（${group.workspace.name}）`}
                          icon={
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                            </svg>
                          }
                          onClick={() => onOpenModule(group.workspace, "knowledge")}
                        />
                      )}
                      <ModuleRow
                        label="Loops"
                        title={`Loops（${group.workspace.name}）`}
                        icon={
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M21 12a9 9 0 1 1-3.8-7.4" /><path d="M21 3v5h-5" />
                          </svg>
                        }
                        onClick={() => onOpenModule(group.workspace, "loops")}
                      />
                    </div>
                  )}
                  {group.sessions.length === 0 ? (
                    <div style={{ padding: "4px 10px 4px 14px", color: "var(--text-dim)", fontSize: 11 }}>
                      暂无会话
                    </div>
                  ) : (
                    <>
                      {(expandedGroups.has(group.workspace.id)
                        ? group.sessions
                        : group.sessions.slice(0, SESSION_PREVIEW_COUNT)
                      ).map((session) => {
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
                      })}
                      {group.sessions.length > SESSION_PREVIEW_COUNT && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedGroups((prev) => new Set([...prev, group.workspace.id]))
                          }
                          title={`展开全部 ${group.sessions.length} 条会话`}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "5px 12px 5px 22px",
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
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                            <circle cx="12" cy="5" r="1" />
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="12" cy="19" r="1" />
                          </svg>
                          显示更多（共 {group.sessions.length}）
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {/* 列表尾指示线：拖到尾空区 = 移到末位。 */}
        {draggedWorkspaceId && dropHint?.targetId === null && (
          <div aria-hidden className="workspace-drop-line" style={{ height: 2, margin: "0 2px 4px", borderRadius: 2, background: "var(--accent)" }} />
        )}
        {/* 树底暗淡行：与树行同构（flat 行 + hover 动作，不再卡片盒子——
            2026-09 反馈：卡片式与树样式不统一）。已停用：整行可点 + hover ⚙
            深链设置›工作区重启用；目录不可用：纯展示。 */}
        {hiddenWorkspaces.map((workspace) => (
          <div key={workspace.id} style={{ paddingLeft: 8 }}>
            <HiddenWorkspaceRow
              workspace={workspace}
              onOpenSettings={workspace.disabled && workspace.available && onOpenWorkspaceSettings ? onOpenWorkspaceSettings : undefined}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 顶部导航（2026-09 ZCode 风格改版）：三行安静导航行——图标 + 文案 +
          右侧 ⌘ 提示，整行 hover 圆角底；激活态（bg-selected）= 搜索展开中 /
          设置页停在插件或 Skills 分区。取代原 accent 大按钮 + 方形搜索开关。 */}
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
          title="插件 & Skills 配置"
          active={centerPage?.kind === "settings" && (settingsSection === "plugins" || settingsSection === "skills")}
          onClick={() => onOpenCenterPage({ kind: "settings", section: "plugins" })}
          icon={
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
            </svg>
          }
        />
      </nav>

      {/* 分区标题：项目（ZCode 同名心智——会话按项目分组）+ ＋（新建工作区 /
          导入目录）。左缩进 18px = 导航行图标列（8px 容器 + 10px 行内边距），
          与上下图标同列对齐（2026-09 用户反馈「项目缩进对齐」）。 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px 2px 18px",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", userSelect: "none" }}>项目</span>
        <button
          ref={plusRef}
          type="button"
          title="新建 / 导入工作区"
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
          }}
        >
          ＋
        </button>
      </div>

      {/* 树主体（原 SessionSearch children 容器语义：搜索弹框化后直接常驻）。 */}
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

      {/* 底部三入口：设置 / 模型 / Agents（全局配置心智，统一 = 打开设置页
          并预选分区；插件/Skills 已上移为顶部「插件&技能」导航行）。圆角按钮 +
          内缩，hover/选中有圆角底。 */}
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
          const active = centerPage?.kind === "settings" && settingsSection === entry.section;
          return (
            <button
              key={entry.section}
              type="button"
              role="tab"
              aria-selected={active}
              title={entry.title}
              aria-label={entry.label}
              onClick={() => onOpenCenterPage({ kind: "settings", section: entry.section })}
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

/** 工作区节点行：整行点击 = 展开/折叠（文件夹开/合两态）；hover 时右侧出现
 *  工作区首页（🏠 开/激活总览家 tab）与 归档（回收站，中央区整页）两个快捷
 *  按钮（取代徽章/计数，SessionRow 的 hover-action 同款模式；两按钮
 *  stopPropagation，不触发折叠）。 */
/** 树底暗淡行（已停用/目录不可用）：与工作区节点行同构——flat 圆角行、
 *  同 padding/字号、文件夹图标、右侧徽章，只是整体暗淡；已停用行整行可点
 *  （hover 出 ⚙，同节点行的 hover 动作模式）深链设置›工作区重启用。
 *  2026-09 反馈收敛：不再用边框卡片盒子（与树样式不统一）。 */
function HiddenWorkspaceRow({
  workspace,
  onOpenSettings,
}: {
  workspace: WorkspaceSummary;
  onOpenSettings?: (workspace: WorkspaceSummary) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const actionable = Boolean(onOpenSettings);
  const unavailable = !workspace.available;
  return (
    <button
      type="button"
      disabled={!actionable}
      aria-label={actionable ? `已停用：${workspace.name}，前往设置重新启用` : `${workspace.name}（目录或配置不可用）`}
      title={actionable
        ? `${workspace.name}（已停用——点击前往设置重新启用）`
        : `${workspace.name}（目录或配置不可用）`}
      onClick={() => onOpenSettings?.(workspace)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 6px 5px 2px",
        border: 0,
        borderRadius: 8,
        background: hovered && actionable ? "var(--bg-hover)" : "transparent",
        color: "var(--text-muted)",
        cursor: actionable ? "pointer" : "default",
        textAlign: "left",
        opacity: 0.72,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", flexShrink: 0, color: "var(--text-dim)" }}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {workspace.name}
      </span>
      {hovered && actionable ? (
        <span
          aria-hidden
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, borderRadius: 6, flexShrink: 0,
            background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
      ) : (
        <span
          aria-hidden
          style={{
            padding: "1px 6px",
            borderRadius: 6,
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-dim)",
            background: "var(--bg-hover)",
            flexShrink: 0,
            lineHeight: 1.6,
          }}
        >
          {unavailable ? "不可用" : "已停用"}
        </span>
      )}
    </button>
  );
}

function WorkspaceNodeRow({
  workspace,
  sessionCount,
  isCollapsed,
  activity,
  dragging,
  reorderable,
  dropHint,
  onDragStart,
  onDragEnd,
  onDragOverPosition,
  onDropOn,
  onToggle,
  onOpenHome,
  onOpenArchive,
  mobileActions,
}: {
  workspace: WorkspaceSummary;
  sessionCount: number;
  isCollapsed: boolean;
  activity: "running" | "completed" | undefined;
  /** 拖拽排序态（2026-09）：拖动中的行半透明（带过渡）；reorderable 时整行
   *  可拖；drop 位置按上下半判定（上半 = 插到它前面、下半 = 插到它后面），
   *  入场动画指示线落在对应边缘（globals.css 的 workspace-drop-line）。 */
  dragging?: boolean;
  reorderable?: boolean;
  dropHint?: "before" | "after" | null;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOverPosition?: (position: "before" | "after") => void;
  onDropOn?: (position: "before" | "after") => void;
  onToggle: () => void;
  onOpenHome: (workspace: WorkspaceSummary) => void;
  onOpenArchive: (workspace: WorkspaceSummary) => void;
  /** 移动端抽屉变体：触屏无 hover——快捷动作从「hover 出现 🏠/🗑」换为
   *  常显 ＋（在该工作区新建会话）/🗑（归档），不再渲染 🏠（移动端无总览
   *  目的地，抽屉树即工作区全貌）。 */
  mobileActions?: {
    onNewSession: () => void;
    onOpenArchive: () => void;
  };
}) {
  const [hovered, setHovered] = useState(false);
  const dropPositionOf = (event: React.DragEvent): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  };
  return (
    <button
      type="button"
      aria-label={isCollapsed ? "展开会话" : "折叠会话"}
      aria-expanded={!isCollapsed}
      onClick={onToggle}
      title={`${workspace.name}（${isCollapsed ? "展开" : "折叠"}会话列表${reorderable ? "；可拖拽调整工作区顺序" : ""}）`}
      draggable={reorderable ? true : undefined}
      onDragStart={() => {
        if (!reorderable) return;
        onDragStart?.();
      }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={(event) => {
        // 允许 drop 并上报插入位（上下半判定；有没有有效拖动由容器/drop 侧守卫）。
        if (!reorderable || !onDropOn) return;
        event.preventDefault();
        event.stopPropagation(); // 不冒泡到列表尾空区（= 移到末位）
        onDragOverPosition?.(dropPositionOf(event));
      }}
      onDrop={(event) => {
        if (!reorderable || !onDropOn) return;
        event.preventDefault();
        event.stopPropagation();
        onDropOn(dropPositionOf(event));
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 6px 5px 2px",
        border: 0,
        borderRadius: 8,
        background: hovered ? "var(--bg-hover)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        opacity: dragging ? 0.5 : 1,
        transition: "opacity 0.15s ease",
        position: "relative",
      }}
    >
      {dropHint && (
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
            ...(dropHint === "before" ? { top: -2 } : { bottom: -2 }),
          }}
        />
      )}
      {isCollapsed ? (
        /* 合上的文件夹 */
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", flexShrink: 0, color: "var(--accent)" }}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      ) : (
        /* 打开的文件夹 */
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", flexShrink: 0, color: "var(--accent)" }}>
          <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
        </svg>
      )}
      <strong style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {workspace.name}
      </strong>
      {mobileActions ? (
        <span style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <span
            role="button"
            tabIndex={0}
            title={`新建会话（${workspace.name}）`}
            aria-label={`新建会话（${workspace.name}）`}
            onClick={(e) => { e.stopPropagation(); mobileActions.onNewSession(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); mobileActions.onNewSession(); } }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, borderRadius: 6,
              background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14" /><path d="M5 12h14" />
            </svg>
          </span>
          <span
            role="button"
            tabIndex={0}
            title={`归档（${workspace.name} 回收站）`}
            aria-label={`归档（${workspace.name}）`}
            onClick={(e) => { e.stopPropagation(); mobileActions.onOpenArchive(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); mobileActions.onOpenArchive(); } }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, borderRadius: 6,
              background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </span>
        </span>
      ) : hovered ? (
        <span style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <span
            role="button"
            tabIndex={0}
            title={`工作区首页（${workspace.name} 总览）`}
            aria-label={`工作区首页（${workspace.name}）`}
            onClick={(e) => { e.stopPropagation(); onOpenHome(workspace); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onOpenHome(workspace); } }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 6,
              background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
            </svg>
          </span>
          <span
            role="button"
            tabIndex={0}
            title={`归档（${workspace.name} 回收站）`}
            aria-label={`归档（${workspace.name}）`}
            onClick={(e) => { e.stopPropagation(); onOpenArchive(workspace); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onOpenArchive(workspace); } }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 6,
              background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </span>
        </span>
      ) : (
        <>
          {activity === "running" && (
            <span title="工作区有会话正在运行" style={{ display: "inline-flex", flexShrink: 0, color: "var(--text)" }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
                <g>
                  <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                </g>
              </svg>
            </span>
          )}
          {activity === "completed" && (
            <span title="工作区有会话已完成" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: "var(--accent)" }} />
          )}
          <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)" }}>
            {sessionCount}
          </span>
        </>
      )}
    </button>
  );
}

/** 模块行（移动端抽屉变体，docs/mobile-drawer-design.md §3）：紧凑图标+文案
 *  的 flat 按钮，两列网格排在展开的工作区节点下、会话行上方——把「文件/
 *  工作项/知识库/Loops」压进「打开抽屉一次、必到」的范围。 */
function ModuleRow({
  label,
  title,
  icon,
  onClick,
}: {
  label: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 8px",
        border: 0,
        borderRadius: 6,
        background: "transparent",
        color: "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12,
        textAlign: "left",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ display: "flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}
