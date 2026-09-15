"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileExplorer } from "./FileExplorer";
import { PanelHeader, PanelHeaderButton } from "./PanelHeader";
import { ExplorerSegmentedTabs } from "./FilesExplorerPanel";
import { useGitStatus } from "@/hooks/useGitStatus";
import { ChangesPanel } from "./ChangesPanel";
import type { SessionInfo } from "@/lib/types";
import { HomeSessionGroups } from "./HomeSessionGroups";
import { SessionRow } from "./SessionRow";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";
import { groupSessionsByWorkspace } from "@/lib/home-quick-switch";
import { computeMenuLayout, readViewportWindow, type MenuLayout } from "@/lib/dropdown-layout";

/**
 * The middle-column panel content for the three-column layout. Renders exactly
 * ONE module view (workbench / knowledge) under a unified PanelHeader —
 * the global panels (archive / settings) and the work-items manager panel are
 * rendered by AppShell directly, and the ActivityBar icon rail lives OUTSIDE
 * this component (a sibling column). At home (no active workspace) it renders
 * the quick-switch panel: workspaces grouped with their full session lists
 * (HomeSessionGroups) — clicking a session jumps straight into it.
 *
 * Retired here (moved elsewhere by the three-column redesign): the workspace
 * switcher header (→ top WorkspaceTabBar), the SettingsBar 模型/Skills/插件
 * buttons (→ settings panel subpages), the archive footer button (→ rail icon
 * / settings row), and the simplified work-items grouping view (→ the
 * full WorkspaceManager work-items panel).
 */
interface Props {
  activeWorkspace: WorkspaceSummary | null;
  /** Which module view to render（W-中后仅剩 workbench；knowledge 已收进家 tab
   *  hub 的 KnowledgeBrowser）。Archive/settings never reach this component
   *  (AppShell intercepts them); at home only the workspace list renders. */
  activeView: "workbench" | "knowledge";
  workspaces: WorkspaceSummary[];
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  completedSessionIds: Set<string>;
  allSessions: SessionInfo[];
  refreshKey: number;
  explorerRefreshKey: number;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  /** W-中：知识库浏览已收进家 tab hub，此面板不再有 ＋ 入口（添加仓库在设置/总览）。 */
  onAddRepository?: () => void;
  /** 工作台 PanelHeader「总览」— Overview 仪表盘的回头路（桌面：主区切 overview；
   *  移动端：工作台 tab 内推入总览栈）。仅在 workbench 视图渲染。 */
  onShowOverview?: () => void;
  onNewSession: () => void;
  onSelectSession: (session: SessionInfo) => void;
  /** C1 并行手势：会话行 Cmd/Ctrl-点击、中键、hover「新 tab」→ 开/聚焦该会话的 tab。 */
  onOpenSessionInNewTab?: (session: SessionInfo) => void;
  onOpenFile: (path: string, name: string) => void;
  onSessionRemoved?: (id: string) => void;
  /** Loops 面板定位信号：透传给工作台 FileExplorer 的 reveal（按祖先路径展开
   *  定位到 `loops/<name>` 等目录；nonce 变化可对同一路径重复触发）。 */
  filesReveal?: { path: string; nonce: number } | null;
  /** 计数器信号：bump 时把文件 section 展开（跨视图「打开文件区」意图，
   *  如 Loops 面板 loop 名点击——文件区默认收起，不展开则看不见 reveal 结果）。 */
  openFilesRequest?: number;
  /** 工作台是否渲染「文件」段。桌面 false（文件树已迁往右栏固定的「文件」
   *  tab，见 FilesExplorerPanel），会话列表占满高度；移动端 true（工作台
   *  tab 内的文件树/折叠/分割逻辑原样保留）。默认 true。 */
  showFilesSection?: boolean;
}

// Knowledge repos are browsed with a FileExplorer that has no git overlay in the
// MVP (OKF directory tree only). Use stable empty collections so FileExplorer's
// internal effects don't re-run every render.

/** Collapse state of the two workbench sections (会话 / 文件). */
interface WorkbenchSectionState {
  sessions: boolean;
  files: boolean;
}

const WORKBENCH_SECTIONS_DEFAULT: WorkbenchSectionState = { sessions: true, files: false };

/** 会话/文件高度分割（占工作台主体高度的百分比）。未拖动过时为 null → 默认 40%。 */
const WORKBENCH_SPLIT_DEFAULT_PCT = 40;
const WORKBENCH_SPLIT_MIN_PCT = 15;
const WORKBENCH_SPLIT_MAX_PCT = 85;

/** Read `pi-workbench-split:<wsId>` defensively: bad values fall back to the
 *  default 40% (null). Dragging the split handle writes the percentage;
 *  double-clicking it clears the key and resets. */
function readWorkbenchSplit(workspaceId: string): number | null {
  const raw = localStorage.getItem(`pi-workbench-split:${workspaceId}`);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(WORKBENCH_SPLIT_MAX_PCT, Math.max(WORKBENCH_SPLIT_MIN_PCT, parsed));
}

function clampWorkbenchSplit(pct: number): number {
  return Math.min(WORKBENCH_SPLIT_MAX_PCT, Math.max(WORKBENCH_SPLIT_MIN_PCT, pct));
}

/** Read `pi-workbench-sections:<wsId>` defensively: bad JSON or missing keys fall
 *  back to the per-key default (会话 open, 文件 collapsed — the file tree is
 *  opt-in and collapsed by default, pinned to the panel bottom). */
function readWorkbenchSections(workspaceId: string): WorkbenchSectionState {
  try {
    const raw = localStorage.getItem(`pi-workbench-sections:${workspaceId}`);
    if (!raw) return WORKBENCH_SECTIONS_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<Record<keyof WorkbenchSectionState, unknown>>;
    return {
      sessions: typeof parsed.sessions === "boolean" ? parsed.sessions : true,
      files: typeof parsed.files === "boolean" ? parsed.files : false,
    };
  } catch {
    return WORKBENCH_SECTIONS_DEFAULT;
  }
}

function rowStyle(active = false): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "var(--pi-sidebar-row-py) 12px var(--pi-sidebar-row-py) 22px",
    border: 0,
    background: active ? "var(--bg-selected)" : "transparent",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: "var(--pi-sidebar-fs)",
    textAlign: "left",
  };
}

/** Workbench [ 文件 | 改动(N) ] segmented switch now lives in FilesExplorerPanel
 *  (shared with the desktop right panel's pinned「文件」tab). */

/** 工作台头部的工作区切换器：当前工作区名 + ▾，点击弹出同列表（本工作区置顶），
 *  选即切；不在弹层里提供新建（顶部 WorkspaceTabBar 的 ＋ 是新建入口）。
 *  菜单是 body-portal 的 fixed 层并用 lib/dropdown-layout 钳进可视区：中栏是
 *  overflow-hidden，绝对定位菜单在贴左锚点上向左生长会被裁剪并伸出屏幕外。 */
function WorkspaceSwitcher({
  workspaces,
  activeWorkspace,
  onSelect,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary;
  onSelect: (workspace: WorkspaceSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuRect, setMenuRect] = useState<MenuLayout | null>(null);
  const available = workspaces.filter(isWorkspaceSelectable);
  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuRect(
        computeMenuLayout(
          { anchor: rect, menuMinWidth: 180, maxMenuHeight: 260 },
          readViewportWindow(),
        ),
      );
    }
  }, [open]);
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        title="切换工作区"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          maxWidth: 140,
          padding: "3px 8px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: open ? "var(--bg-hover)" : "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {activeWorkspace.name}
        </span>
        <span aria-hidden style={{ fontSize: 8, flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▾</span>
      </button>
      {open && menuRect && createPortal(
        <>
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 2000 }}
          />
          <div
            role="menu"
            aria-label="切换工作区"
            style={{
              position: "fixed",
              top: menuRect.top,
              right: menuRect.right,
              zIndex: 2001,
              minWidth: 180,
              maxHeight: menuRect.maxHeight,
              overflowY: "auto",
              padding: 4,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
            }}
          >
            {available.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onSelect(workspace); }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 8px",
                  border: 0,
                  borderRadius: 6,
                  background: workspace.id === activeWorkspace.id ? "var(--bg-selected)" : "transparent",
                  color: workspace.id === activeWorkspace.id ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                  textAlign: "left",
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {workspace.name}
                </span>
                {workspace.id === activeWorkspace.id && (
                  <span aria-hidden style={{ color: "var(--accent)", fontSize: 10, flexShrink: 0 }}>✓</span>
                )}
              </button>
            ))}
            {available.length === 0 && (
              <div style={{ padding: "6px 8px", color: "var(--text-dim)", fontSize: 11 }}>无可用工作区</div>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** Collapsible section header for the workbench view (会话 / 文件).
 *  Chevron + label + count on the left; `children` (e.g. the segmented
 *  文件|改动 tabs) fill the remaining header space. */
function WorkbenchSectionHeader({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 8px 5px 6px",
        minHeight: 38,
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={open ? `收起${label}` : `展开${label}`}
        aria-label={open ? `收起${label}` : `展开${label}`}
        style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer", width: 16, fontSize: 11, padding: 0, flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
      >
        ›
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--text)",
          fontSize: "var(--pi-sidebar-fs-meta)",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {label}
        {typeof count === "number" && (
          <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export function WorkspaceSidebar({
  activeWorkspace,
  activeView,
  workspaces,
  selectedSessionId,
  runningSessionIds,
  completedSessionIds,
  allSessions,
  refreshKey,
  explorerRefreshKey,
  onSelectWorkspace,
  onCreateWorkspace,
  onImportDirectory,
  onShowOverview,
  onNewSession,
  onSelectSession,
  onOpenSessionInNewTab,
  onOpenFile,
  onSessionRemoved,
  filesReveal,
  openFilesRequest,
  showFilesSection = true,
}: Props) {
  // sessions 直接从 AppShell 已加载的全局列表派生（useSessionActivity，含 SSE 实时），
  // 不再自己 fetch /api/sessions——切换 workspace 时瞬时过滤，无重复请求与列表闪烁。
  const sessions = useMemo(() => {
    if (!activeWorkspace) return [];
    return allSessions.filter((session) => {
      const owner = workspaces
        .filter((workspace) => {
          const prefix = `${workspace.path.replace(/\/+$/, "")}/`;
          return workspace.available
            && (session.cwd === workspace.path || session.cwd.startsWith(prefix));
        })
        .sort((left, right) => right.path.length - left.path.length)[0];
      // Hide subagent worker sessions — they stay openable from the parent's
      // subagent result card, but must not clutter the workspace session list.
      return owner?.id === activeWorkspace.id
        && !session.subagentChild;
    });
  }, [allSessions, activeWorkspace, workspaces]);
  const [explorerTab, setExplorerTab] = useState<"files" | "changes">("files");
  // 工作台分段（会话/文件）折叠状态，按工作区持久化；默认两个都展开。
  const [workbenchSections, setWorkbenchSections] = useState<WorkbenchSectionState>({
    sessions: true,
    files: true,
  });
  // 会话/文件分割高度（百分比，null → 默认 40%）与拖拽测量用的两个 ref。
  const [splitPct, setSplitPct] = useState<number | null>(null);
  const workbenchBodyRef = useRef<HTMLDivElement>(null);
  const sessionsBodyRef = useRef<HTMLDivElement>(null);
  // 文件头部 ⟳ 手动刷新：叠加在 shell 驱动的 explorerRefreshKey 上，同时刷
  // 文件树缓存与 git 状态（外部删除/编辑等无事件的变化只能靠它）。
  const [manualExplorerKey, setManualExplorerKey] = useState(0);

  const { status: gitStatus, gitStatusByPath, changedDirectoryPaths } = useGitStatus(
    activeWorkspace?.path ?? null,
    explorerRefreshKey + manualExplorerKey,
  );
  const changesCount = gitStatus ? gitStatus.groups.reduce((total, group) => total + group.files.length, 0) : 0;
  const isGitRepo = Boolean(gitStatus?.isGitRepository);
  // 非 git 目录隐藏"改动"分段，强制回落到"文件"。
  const effectiveExplorerTab: "files" | "changes" =
    isGitRepo && explorerTab === "changes" ? "changes" : "files";

  const loadWorkspaceData = useCallback(async () => {
    // W-中：知识库视图退役后，仓库列表不在此拉取（浏览在文件区/家 tab hub，
    // 管理在设置）；保留空实现以维持 refreshKey 触发链。
    void activeWorkspace;
  }, [activeWorkspace]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData, refreshKey]);

  // Explorer 内部 [ 文件 | 改动 ] 分段选择，按工作区持久化。
  useEffect(() => {
    if (!activeWorkspace) return;
    const stored = localStorage.getItem(`pi-explorer-tab:${activeWorkspace.id}`);
    setExplorerTab(stored === "changes" ? "changes" : "files");
  }, [activeWorkspace]);

  // 工作台分段折叠状态，按工作区持久化（JSON，坏数据防御性回退到默认全展开）。
  useEffect(() => {
    if (!activeWorkspace) {
      setWorkbenchSections(WORKBENCH_SECTIONS_DEFAULT);
      setSplitPct(null);
      return;
    }
    setWorkbenchSections(readWorkbenchSections(activeWorkspace.id));
    setSplitPct(readWorkbenchSplit(activeWorkspace.id));
  }, [activeWorkspace]);

  const handleSelectExplorerTab = useCallback((tab: "files" | "changes") => {
    setExplorerTab(tab);
    if (activeWorkspace) {
      localStorage.setItem(`pi-explorer-tab:${activeWorkspace.id}`, tab);
    }
  }, [activeWorkspace]);

  const toggleWorkbenchSection = useCallback((
    section: "sessions" | "files",
    current: boolean,
  ) => {
    const next = !current;
    if (activeWorkspace) {
      localStorage.setItem(
        `pi-workbench-sections:${activeWorkspace.id}`,
        JSON.stringify({ ...readWorkbenchSections(activeWorkspace.id), [section]: next }),
      );
    }
    setWorkbenchSections((state) => ({ ...state, [section]: next }));
  }, [activeWorkspace]);

  // openFilesRequest（计数器信号，如 Loops 面板 loop 名点击的跨视图定位）：bump 时
  // 无条件 ensure-open 文件 section——不读 workbenchSections（restore 前的初态闭包
  // 恒为 initializer 的 files: true，条件展开会跳过、nonce 守卫又拦掉 restore 后的重跑；
  // toggleWorkbenchSection(_, current=false) → next=true，幂等展开），并切回「文件」
  // 分段（用户停在「改动」时 section 打开也看不见 reveal 结果）。nonce 守卫确保 effect
  // 因 activeWorkspace 变化重跑时，旧意图不会误开新工作区的文件段。
  const lastOpenFilesRequestRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (openFilesRequest === undefined || openFilesRequest === lastOpenFilesRequestRef.current) return;
    lastOpenFilesRequestRef.current = openFilesRequest;
    toggleWorkbenchSection("files", false); // fix(review F1): ensure-open——restore 前初态不可信，幂等翻转
    setExplorerTab("files"); // fix(review F2): 持久化的「改动」分段会吞掉 reveal，联动切回「文件」
  }, [openFilesRequest, toggleWorkbenchSection, setExplorerTab]);

  // —— 会话/文件分割拖拽（pointer 事件，鼠标/触屏同路径；双击重置为默认 40%）——
  // 起拖时实测会话列表当前高度得出起始百分比，拖动中按 ΔY/容器高换算，避免
  // 头部高度换算；结束时才写 localStorage（拖动中只改内存态）。
  const resetWorkbenchSplit = useCallback(() => {
    setSplitPct(null);
    if (activeWorkspace) {
      localStorage.removeItem(`pi-workbench-split:${activeWorkspace.id}`);
    }
  }, [activeWorkspace]);

  const startWorkbenchSplitDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const body = workbenchBodyRef.current;
    const sessionsBody = sessionsBodyRef.current;
    if (!body || !sessionsBody) return;
    event.preventDefault();
    const bodyHeight = body.getBoundingClientRect().height;
    if (bodyHeight <= 0) return;
    const startY = event.clientY;
    const startPct = (sessionsBody.getBoundingClientRect().height / bodyHeight) * 100;
    let latest = clampWorkbenchSplit(startPct);
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (move: PointerEvent) => {
      latest = clampWorkbenchSplit(startPct + ((move.clientY - startY) / bodyHeight) * 100);
      setSplitPct(latest);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      if (activeWorkspace) {
        localStorage.setItem(`pi-workbench-split:${activeWorkspace.id}`, String(Math.round(latest * 10) / 10));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [activeWorkspace]);

  // ---- Global sessions body（2026-09 全局左栏）--------------------------------
  // 桌面中栏的会话面板 = 全局分组列表（HomeSessionGroups + 不可用工作区 + 导入
  // 入口），工作台与首页两个分支同体——左栏不再随 activeWorkspace 换血（痛点
  // a/b/c，docs/global-session-sidebar-design.md）。移动端不消费本 body（工作台
  // 会话段保持工作区作用域，首页用自己的 HomeLanding）。
  const renderGlobalSessionsBody = (): ReactNode => {
    const homeGroups = groupSessionsByWorkspace(workspaces, allSessions);
    const unavailableWorkspaces = workspaces.filter((workspace) => !workspace.available);
    return (
      <div style={{ padding: "10px 8px" }}>
        <HomeSessionGroups
          groups={homeGroups}
          runningSessionIds={runningSessionIds}
          completedSessionIds={completedSessionIds}
          selectedSessionId={selectedSessionId}
          onSelectWorkspace={onSelectWorkspace}
          onSelectSession={onSelectSession}
          onOpenSessionInNewTab={onOpenSessionInNewTab}
          onSessionRemoved={onSessionRemoved}
        />
        {unavailableWorkspaces.map((workspace) => (
          <div
            key={workspace.id}
            style={{
              display: "grid",
              gap: 2,
              padding: "9px 10px",
              marginBottom: 4,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              opacity: 0.6,
            }}
          >
            <strong style={{ fontSize: "var(--pi-sidebar-fs)", color: "var(--text-muted)" }}>{workspace.name}</strong>
            <span style={{ fontSize: "var(--pi-sidebar-fs-meta)", color: "var(--text-dim)" }}>
              目录或配置不可用
            </span>
          </div>
        ))}
        {workspaces.length === 0 && (
          <div style={{ padding: 12, color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs)" }}>
            尚未创建 Workspace。
          </div>
        )}
        <button
          onClick={onImportDirectory}
          style={{ ...rowStyle(), padding: "9px 10px", marginTop: 10 }}
        >
          ＋ 导入目录…
        </button>
      </div>
    );
  };

  // ---- Home panel (no active workspace) ---------------------------------------
  // 首页中栏：头部 Pi Web + 新建工作区；body = 全局分组列表（与工作台同体）。
  if (!activeWorkspace) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <PanelHeader
          title="Pi Web"
          meta="工作区"
          actions={
            <PanelHeaderButton onClick={onCreateWorkspace} title="新建 Workspace" primary>
              ＋ 新建
            </PanelHeaderButton>
          }
        />
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {renderGlobalSessionsBody()}
        </div>
      </div>
    );
  }

  // ---- Module panels ----------------------------------------------------------
  // 文件段可见性：桌面 false（文件树在右栏「文件」tab），会话列表占满高度。
  const filesSectionVisible = showFilesSection !== false;
  const filesOpen = filesSectionVisible && workbenchSections.files;
  const renderActiveView = (): ReactNode => {
    switch (activeView) {
      case "workbench":
        // 桌面（showFilesSection=false，2026-09 全局左栏）：会话区 = 全局分组
        // 列表（与首页同体）——不再有「会话」分段头（组头即结构），文件树在右栏
        // 「文件」tab。移动端（true）：会话（上，工作区作用域）+ 文件（下）两个
        // 可折叠分段照旧——分段都展开时会话占分割高度（默认 40%，可拖中间的
        // 分割手柄调整，双击重置）；文件默认收起，收起时只剩头部贴底，会话列表
        // 占满剩余高度。
        if (!filesSectionVisible) {
          return renderGlobalSessionsBody();
        }
        return (
          <div ref={workbenchBodyRef} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <WorkbenchSectionHeader
              label="会话"
              count={sessions.length}
              open={workbenchSections.sessions}
              onToggle={() => toggleWorkbenchSection("sessions", workbenchSections.sessions)}
            />
            {workbenchSections.sessions && (
              <div
                ref={sessionsBodyRef}
                style={{
                  flex: filesOpen ? `0 0 ${splitPct ?? WORKBENCH_SPLIT_DEFAULT_PCT}%` : "1 1 0",
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                {sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    isSelected={session.id === selectedSessionId}
                    activity={runningSessionIds.has(session.id) ? "running" : completedSessionIds.has(session.id) ? "completed" : undefined}
                    onSelect={() => onSelectSession(session)}
                    onOpenInNewTab={onOpenSessionInNewTab ? () => onOpenSessionInNewTab(session) : undefined}
                    onChanged={() => void loadWorkspaceData()}
                    onRemoved={onSessionRemoved}
                  />
                ))}
                {sessions.length === 0 && (
                  <div style={{ padding: "7px 22px 10px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                    暂无会话
                  </div>
                )}
              </div>
            )}
            {workbenchSections.sessions && filesOpen && (
              <div
                className="workbench-split-handle"
                role="separator"
                aria-orientation="horizontal"
                title="拖动调整会话/文件高度（双击重置）"
                onPointerDown={startWorkbenchSplitDrag}
                onDoubleClick={resetWorkbenchSplit}
              />
            )}
            {filesSectionVisible && (
            <div
              style={{
                flex: filesOpen ? "1 1 0" : "0 0 auto",
                marginTop: "auto",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* 文件段可折叠、默认收起：展开时占余下高度，头部带 [ 文件 | 改动 ]
                  分段（非 git 目录无分段）+ ⟳ 手动刷新（外部删除/编辑无事件，
                  agent 回合结束才会自动刷新一次）。收起时不渲染，只剩标题条贴底。 */}
              <WorkbenchSectionHeader
                label="文件"
                open={filesOpen}
                onToggle={() => toggleWorkbenchSection("files", workbenchSections.files)}
              >
                {filesOpen && (
                  <>
                    {isGitRepo && (
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ExplorerSegmentedTabs
                          active={effectiveExplorerTab}
                          changesCount={changesCount}
                          onSelect={handleSelectExplorerTab}
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setManualExplorerKey((key) => key + 1)}
                      title="刷新文件树与改动状态"
                      aria-label="刷新文件树与改动状态"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 24,
                        height: 24,
                        padding: 0,
                        flexShrink: 0,
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        background: "transparent",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M23 4v6h-6" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                    </button>
                  </>
                )}
              </WorkbenchSectionHeader>
              {filesOpen && (
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  {isGitRepo && effectiveExplorerTab === "changes" ? (
                    <ChangesPanel
                      groups={gitStatus?.groups ?? []}
                      cwd={activeWorkspace.path}
                      onOpenFile={onOpenFile}
                    />
                  ) : (
                    <FileExplorer
                      cwd={activeWorkspace.path}
                      onOpenFile={onOpenFile}
                      refreshKey={explorerRefreshKey + manualExplorerKey}
                      gitStatusByPath={gitStatusByPath}
                      changedDirectoryPaths={changedDirectoryPaths}
                      reveal={filesReveal ?? undefined}
                    />
                  )}
                </div>
              )}
            </div>
            )}
          </div>
        );

      case "knowledge":
        // W-中后不再从 WorkspaceSidebar 渲染（知识库已收进家 tab hub 的
        // KnowledgeBrowser）；防御性返回空。
        return null;
      default:
        return null;
    }
  };

  const panelHeader = (() => {
    switch (activeView) {
      case "workbench":
        return (
          <PanelHeader
            title="工作台"
            actions={
              <>
                {/* 工作区切换：点击弹同列表（复用中栏同款交互），选即切。 */}
                <WorkspaceSwitcher
                  workspaces={workspaces}
                  activeWorkspace={activeWorkspace}
                  onSelect={onSelectWorkspace}
                />
                {onShowOverview && (
                  <PanelHeaderButton onClick={onShowOverview} title="工作区总览（活跃工作项 / 仓库 / Loops 管理）">
                    总览
                  </PanelHeaderButton>
                )}
                <PanelHeaderButton onClick={onNewSession} title="新建会话" primary>
                  ＋ 新建会话
                </PanelHeaderButton>
              </>
            }
          />
        );
      default:
        return null;
    }
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {panelHeader}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        {renderActiveView()}
      </div>
    </div>
  );
}

