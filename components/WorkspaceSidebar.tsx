"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileExplorer } from "./FileExplorer";
import { PanelHeader, PanelHeaderButton } from "./PanelHeader";
import { ExplorerSegmentedTabs } from "./FilesExplorerPanel";
import type { SidebarView } from "./ActivityBar";
import { useGitStatus } from "@/hooks/useGitStatus";
import { ChangesPanel } from "./ChangesPanel";
import type { SessionInfo } from "@/lib/types";
import type { GitFileStatus } from "@/lib/git-types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";
import { joinFilePath } from "@/lib/file-paths";

/**
 * The middle-column panel content for the three-column layout. Renders exactly
 * ONE module view (workbench / knowledge) under a unified PanelHeader —
 * the global panels (archive / settings) and the work-items manager panel are
 * rendered by AppShell directly, and the ActivityBar icon rail lives OUTSIDE
 * this component (a sibling column). At home (no active workspace) it renders
 * the workspace-list panel.
 *
 * Retired here (moved elsewhere by the three-column redesign): the workspace
 * switcher header (→ top WorkspaceTabBar), the SettingsBar 模型/Skills/插件
 * buttons (→ settings panel subpages), the archive footer button (→ rail icon
 * / settings row), and the simplified work-items grouping view (→ the
 * full WorkspaceManager work-items panel).
 */
interface Props {
  activeWorkspace: WorkspaceSummary | null;
  /** Which module view to render. Archive/settings never reach this component
   *  (AppShell intercepts them); at home only the workspace list renders. */
  activeView: SidebarView;
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
  /** Knowledge panel ＋ — switches to settings › workspace › repository form. */
  onAddRepository: () => void;
  /** 工作台 PanelHeader「总览」— Overview 仪表盘的回头路（桌面：主区切 overview；
   *  移动端：工作台 tab 内推入总览栈）。仅在 workbench 视图渲染。 */
  onShowOverview?: () => void;
  onNewSession: () => void;
  onSelectSession: (session: SessionInfo) => void;
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
const EMPTY_GIT_STATUS_BY_PATH = new Map<string, GitFileStatus>();
const EMPTY_CHANGED_DIRECTORY_PATHS = new Set<string>();

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
 *  选即切；不在弹层里提供新建（顶部 WorkspaceTabBar 的 ＋ 是新建入口）。 */
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
  const available = workspaces.filter((workspace) => workspace.available);
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
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
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 30,
            minWidth: 180,
            maxHeight: 260,
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
  onAddRepository,
  onShowOverview,
  onNewSession,
  onSelectSession,
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
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [explorerTab, setExplorerTab] = useState<"files" | "changes">("files");
  // 工作台分段（会话/文件）折叠状态，按工作区持久化；默认两个都展开。
  const [workbenchSections, setWorkbenchSections] = useState<WorkbenchSectionState>({
    sessions: true,
    files: true,
  });
  const [selectedKnowledgeRepoId, setSelectedKnowledgeRepoId] = useState<string | null>(null);
  // 会话/文件分割高度（百分比，null → 默认 40%）与拖拽测量用的两个 ref。
  const [splitPct, setSplitPct] = useState<number | null>(null);
  const workbenchBodyRef = useRef<HTMLDivElement>(null);
  const sessionsBodyRef = useRef<HTMLDivElement>(null);
  // 文件头部 ⟳ 手动刷新：叠加在 shell 驱动的 explorerRefreshKey 上，同时刷
  // 文件树缓存与 git 状态（外部删除/编辑等无事件的变化只能靠它）。
  const [manualExplorerKey, setManualExplorerKey] = useState(0);

  const hasCapability = useCallback(
    (capability: WorkspaceSummary["capabilities"][number]) =>
      activeWorkspace?.capabilities.includes(capability) ?? false,
    [activeWorkspace],
  );
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
    if (!activeWorkspace) {
      setRepositories([]);
      return;
    }
    const [repositoriesResponse] = await Promise.all([
      hasCapability("repositories")
        ? fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/repositories`)
        : null,
    ]);
    const repositoriesData = repositoriesResponse?.ok
      ? await repositoriesResponse.json() as { repositories?: WorkspaceRepositoryState[] }
      : {};
    setRepositories(repositoriesData.repositories ?? []);
  }, [activeWorkspace, hasCapability]);

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


  // Knowledge bundles are the panel-facing repo list — code repos have no
  // standalone view anymore (browse in the workbench file tree, manage in
  // settings / dashboard).
  const knowledgeRepositories = useMemo(
    () => repositories.filter((repository) => repository.kind === "knowledge" && repository.status === "active"),
    [repositories],
  );
  const effectiveKnowledgeRepo = useMemo(
    () => knowledgeRepositories.find((repository) => repository.id === selectedKnowledgeRepoId)
      ?? knowledgeRepositories[0]
      ?? null,
    [knowledgeRepositories, selectedKnowledgeRepoId],
  );

  // ---- Home panel (no active workspace) ---------------------------------------
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
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px" }}>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              disabled={!workspace.available}
              onClick={() => onSelectWorkspace(workspace)}
              style={{
                width: "100%",
                display: "grid",
                gap: 2,
                padding: "9px 10px",
                marginBottom: 4,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg)",
                color: "var(--text)",
                cursor: workspace.available ? "pointer" : "default",
                opacity: workspace.available ? 1 : 0.6,
                textAlign: "left",
              }}
            >
              <strong style={{ fontSize: "var(--pi-sidebar-fs)" }}>{workspace.name}</strong>
              <span style={{ fontSize: "var(--pi-sidebar-fs-meta)", color: "var(--text-dim)" }}>
                {workspace.available
                  ? `${workspace.capabilities.length} capabilities · ${workspace.repositoryCount} repositories`
                  : "目录或配置不可用"}
              </span>
            </button>
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
        // 工作台（移动端 / showFilesSection=true）：会话（上）+ 文件（下）两个可
        // 折叠分段。两段都展开时会话占分割高度（默认 40%，可拖中间的分割手柄
        // 调整，双击重置）内部滚动（不随内容伸缩，保证两段高度稳定）；文件默认
        // 收起——收起时只剩头部贴在面板底部（marginTop:auto 吸收剩余空间），
        // 会话列表占满剩余高度。桌面 showFilesSection=false：文件段不渲染，
        // 会话占满（文件树在右栏「文件」tab）。
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
        return (
          <div>
            {knowledgeRepositories.length === 0 ? (
              <div style={{ padding: "7px 22px 10px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                暂无知识库
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 8px" }}>
                  {knowledgeRepositories.map((repository) => {
                    const selected = repository.id === effectiveKnowledgeRepo?.id;
                    return (
                      <button
                        key={repository.id}
                        onClick={() => setSelectedKnowledgeRepoId(repository.id)}
                        style={{
                          padding: "3px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: selected ? "var(--bg-selected)" : "var(--bg)",
                          color: selected ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer",
                          fontSize: "var(--pi-sidebar-fs-meta)",
                        }}
                      >
                        {repository.name}
                      </button>
                    );
                  })}
                </div>
                {effectiveKnowledgeRepo && (
                  <>
                    <div style={{ padding: "4px 12px 6px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                      OKF bundle —{" "}
                      <button
                        type="button"
                        onClick={() => onOpenFile(`${joinFilePath(activeWorkspace.path, effectiveKnowledgeRepo.path)}/index.md`, "index.md")}
                        style={{ border: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline" }}
                      >
                        open index.md
                      </button>
                      {" "}to traverse (L0: read/ls/grep).
                    </div>
                    <FileExplorer
                      cwd={joinFilePath(activeWorkspace.path, effectiveKnowledgeRepo.path)}
                      onOpenFile={onOpenFile}
                      refreshKey={explorerRefreshKey + manualExplorerKey}
                      gitStatusByPath={EMPTY_GIT_STATUS_BY_PATH}
                      changedDirectoryPaths={EMPTY_CHANGED_DIRECTORY_PATHS}
                    />
                  </>
                )}
              </>
            )}
          </div>
        );

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
      case "knowledge":
        return (
          <PanelHeader
            title="知识库"
            actions={
              <PanelHeaderButton onClick={onAddRepository} title="添加知识库">
                ＋ 知识库
              </PanelHeaderButton>
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

const hoverActionBtn: React.CSSProperties = {
  flexShrink: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-hover)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  padding: "2px 8px",
};

function SessionRow({
  session,
  isSelected,
  activity,
  onSelect,
  onChanged,
  onRemoved,
}: {
  session: SessionInfo;
  isSelected: boolean;
  activity?: "running" | "completed";
  onSelect: () => void;
  onChanged: () => void;
  onRemoved?: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = session.name || session.firstMessage || "未命名会话";

  const archive = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
      onRemoved?.(session.id);
      onChanged();
    } finally { setBusy(false); }
  }, [session.id, onChanged, onRemoved]);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...rowStyle(isSelected),
        justifyContent: "space-between",
        opacity: busy ? 0.5 : 1,
        background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{label}</span>
      {activity === "running" && !hovered && (
        <span
          title="运行中"
          aria-label="运行中"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 12,
            height: 12,
            flexShrink: 0,
            color: "var(--text)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 12 12"
                to="360 12 12"
                dur="0.9s"
                repeatCount="indefinite"
              />
            </g>
          </svg>
        </span>
      )}
      {activity === "completed" && !hovered && (
        <span
          title="完成，尚未查看"
          aria-label="完成"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flexShrink: 0,
            background: "var(--accent)",
          }}
        />
      )}
      {hovered && !busy && (
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <button title="归档" onClick={() => void archive()} style={hoverActionBtn}>归档</button>
        </div>
      )}
    </div>
  );
}
