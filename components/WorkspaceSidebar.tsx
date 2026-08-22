"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileExplorer } from "./FileExplorer";
import { PanelHeader, PanelHeaderButton } from "./PanelHeader";
import type { SidebarView } from "./ActivityBar";
import { useGitStatus } from "@/hooks/useGitStatus";
import { ChangesPanel } from "./ChangesPanel";
import type { SessionInfo } from "@/lib/types";
import type { GitFileStatus } from "@/lib/git-types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";
import type { CronTriggerDefinition, LoopDefinition, LoopRun } from "@/lib/loop/types";
import { joinFilePath } from "@/lib/file-paths";

/**
 * The middle-column panel content for the three-column layout. Renders exactly
 * ONE module view (workbench / knowledge / loop) under a unified PanelHeader —
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
  /** Open the LoopConfig editor as the middle-column content (temporarily
   *  widened) — the loop panel's ＋/⚙ action. */
  onOpenLoops: () => void;
  /** Open a Loop orchestrator/execution session by id (run record rows). */
  onOpenLoopSession: (sessionId: string) => void;
  /** Manual-trigger a loop definition (AppShell opens the chat tab + status bar). */
  onTriggerLoop: (loop: LoopDefinition) => void;
  /** Knowledge panel ＋ — switches to settings › workspace › repository form. */
  onAddRepository: () => void;
  onNewSession: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onOpenFile: (path: string, name: string) => void;
  onSessionRemoved?: (id: string) => void;
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

const WORKBENCH_SECTIONS_DEFAULT: WorkbenchSectionState = { sessions: true, files: true };

/** Read `pi-workbench-sections:<wsId>` defensively: bad JSON or missing keys fall
 *  back to the per-key default (both sections open). */
function readWorkbenchSections(workspaceId: string): WorkbenchSectionState {
  try {
    const raw = localStorage.getItem(`pi-workbench-sections:${workspaceId}`);
    if (!raw) return WORKBENCH_SECTIONS_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<Record<keyof WorkbenchSectionState, unknown>>;
    return {
      sessions: typeof parsed.sessions === "boolean" ? parsed.sessions : true,
      files: typeof parsed.files === "boolean" ? parsed.files : true,
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

/** Workbench [ 文件 | 改动(N) ] segmented switch. Lives in the 文件 section
 *  header of the workbench view: the changes list follows the Explorer's
 *  current cwd scope. Only rendered inside a git directory. Margin is 0 — the
 *  enclosing section header provides the spacing. */
function ExplorerSegmentedTabs({
  active,
  changesCount,
  onSelect,
}: {
  active: "files" | "changes";
  changesCount: number;
  onSelect: (tab: "files" | "changes") => void;
}) {
  const tabBase: React.CSSProperties = {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "4px 8px",
    border: 0,
    borderRadius: 5,
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: "var(--pi-sidebar-fs-meta)",
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
  const activeStyle: React.CSSProperties = {
    background: "var(--bg-panel)",
    color: "var(--text)",
    boxShadow: "0 1px 2px rgba(0,0,0,0.12)",
  };
  return (
    <div
      role="tablist"
      aria-label="Explorer 视图"
      style={{
        display: "flex",
        gap: 3,
        padding: 3,
        background: "var(--bg-hover)",
        borderRadius: 7,
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === "files"}
        style={active === "files" ? { ...tabBase, ...activeStyle } : tabBase}
        onClick={() => onSelect("files")}
      >
        文件
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "changes"}
        style={active === "changes" ? { ...tabBase, ...activeStyle } : tabBase}
        onClick={() => onSelect("changes")}
      >
        改动
        {changesCount > 0 && (
          <span
            title={`${changesCount} 个改动`}
            style={{
              minWidth: 16,
              height: 16,
              padding: "0 5px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 8,
              background: "var(--accent)",
              color: "var(--bg-panel)",
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            {changesCount}
          </span>
        )}
      </button>
    </div>
  );
}

/** Collapsible section header for the workbench view (会话 / 文件).
 *  Chevron + label + count on the left; `children` (e.g. the segmented
 *  文件|改动 tabs) fill the remaining header space. */
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

function WorkbenchSectionHeader({
  label,
  count,
  open,
  onToggle,
  collapsible = true,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  /** false = fixed-open header (no chevron / no toggle) — e.g. the 文件
   *  section is always expanded in the workbench. */
  collapsible?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 8px 5px 6px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        ...(collapsible ? undefined : { paddingLeft: 10 }),
      }}
    >
      {collapsible && (
        <button
          onClick={onToggle}
          aria-expanded={open}
          title={open ? `收起${label}` : `展开${label}`}
          aria-label={open ? `收起${label}` : `展开${label}`}
          style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer", width: 16, fontSize: 11, padding: 0, flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          ›
        </button>
      )}
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
  onOpenLoops,
  onOpenLoopSession,
  onTriggerLoop,
  onAddRepository,
  onNewSession,
  onSelectSession,
  onOpenFile,
  onSessionRemoved,
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
      // Loop orchestrators of IDLE runs (no work-item link) are hidden too —
      // their entry point is the Loop run record; runs that picked an item
      // stay listed like any development session.
      return owner?.id === activeWorkspace.id
        && !session.subagentChild
        && !session.loopOrchestrator;
    });
  }, [allSessions, activeWorkspace, workspaces]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  // Loop 视图：定义列表 + 展开中的 loop 运行记录（run records 直读 RUNS.jsonl）。
  const [loops, setLoops] = useState<LoopDefinition[]>([]);
  const [expandedLoopId, setExpandedLoopId] = useState<string | null>(null);
  const [loopRuns, setLoopRuns] = useState<Record<string, LoopRun[]>>({});
  const [explorerTab, setExplorerTab] = useState<"files" | "changes">("files");
  // 工作台分段（会话/文件）折叠状态，按工作区持久化；默认两个都展开。
  const [workbenchSections, setWorkbenchSections] = useState<WorkbenchSectionState>({
    sessions: true,
    files: true,
  });
  const [selectedKnowledgeRepoId, setSelectedKnowledgeRepoId] = useState<string | null>(null);

  const hasCapability = useCallback(
    (capability: WorkspaceSummary["capabilities"][number]) =>
      activeWorkspace?.capabilities.includes(capability) ?? false,
    [activeWorkspace],
  );
  const { status: gitStatus, gitStatusByPath, changedDirectoryPaths } = useGitStatus(
    activeWorkspace?.path ?? null,
    explorerRefreshKey,
  );
  const changesCount = gitStatus ? gitStatus.groups.reduce((total, group) => total + group.files.length, 0) : 0;
  const isGitRepo = Boolean(gitStatus?.isGitRepository);
  // 非 git 目录隐藏"改动"分段，强制回落到"文件"。
  const effectiveExplorerTab: "files" | "changes" =
    isGitRepo && explorerTab === "changes" ? "changes" : "files";

  const loadWorkspaceData = useCallback(async () => {
    if (!activeWorkspace) {
      setRepositories([]);
      setLoops([]);
      return;
    }
    const [repositoriesResponse, loopsResponse] = await Promise.all([
      hasCapability("repositories")
        ? fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/repositories`)
        : null,
      hasCapability("loop")
        ? fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/loop/loops`)
        : null,
    ]);
    const repositoriesData = repositoriesResponse?.ok
      ? await repositoriesResponse.json() as { repositories?: WorkspaceRepositoryState[] }
      : {};
    const loopsData = loopsResponse?.ok
      ? await loopsResponse.json() as { loops?: LoopDefinition[] }
      : {};
    setRepositories(repositoriesData.repositories ?? []);
    setLoops(loopsData.loops ?? []);
  }, [activeWorkspace, hasCapability]);

  // 运行记录：展开某 loop 时拉取一次；有非终态 run 时每 5s 轮询刷新，全部终态即停。
  const loadLoopRuns = useCallback(async (loopId: string) => {
    if (!activeWorkspace) return;
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/loop/runs?loopId=${encodeURIComponent(loopId)}`,
      );
      if (!response.ok) return;
      const data = await response.json() as { runs?: LoopRun[] };
      setLoopRuns((current) => ({ ...current, [loopId]: data.runs ?? [] }));
    } catch { /* 下轮重试 */ }
  }, [activeWorkspace]);

  const toggleLoopExpanded = useCallback((loopId: string) => {
    setExpandedLoopId((current) => {
      const next = current === loopId ? null : loopId;
      if (next) void loadLoopRuns(next);
      return next;
    });
  }, [loadLoopRuns]);

  const expandedLoopRuns = expandedLoopId ? loopRuns[expandedLoopId] : undefined;
  const hasActiveLoopRun = Boolean(expandedLoopRuns?.some((run) =>
    run.status === "queued" || run.status === "running"));
  useEffect(() => {
    if (!expandedLoopId || !hasActiveLoopRun) return;
    const timer = setTimeout(() => void loadLoopRuns(expandedLoopId), 5000);
    return () => clearTimeout(timer);
  }, [expandedLoopId, hasActiveLoopRun, loopRuns, loadLoopRuns]);

  // 切换工作区时收起运行记录，避免上个工作区的记录残留在新 loop 下。
  useEffect(() => {
    setExpandedLoopId(null);
  }, [activeWorkspace?.id]);

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
      setWorkbenchSections({ sessions: true, files: true });
      return;
    }
    setWorkbenchSections(readWorkbenchSections(activeWorkspace.id));
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
  const renderActiveView = (): ReactNode => {
    switch (activeView) {
      case "workbench":
        // 工作台：会话（上，固定 40% 占比内部滚动——不随内容伸缩，保证两段高度稳定）
        // + 文件（下，占余下 60%）两个可折叠分段。
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <WorkbenchSectionHeader
              label="会话"
              count={sessions.length}
              open={workbenchSections.sessions}
              onToggle={() => toggleWorkbenchSection("sessions", workbenchSections.sessions)}
            />
            {workbenchSections.sessions && (
              <div style={{ flex: "0 0 40%", minHeight: 0, overflowY: "auto" }}>
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
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {/* 文件区不折叠：常驻展开（占比余下 ~60%，会话区上限 40%）。头部仅保留
                  [ 文件 | 改动 ] 分段。 */}
              <WorkbenchSectionHeader
                label="文件"
                open
                onToggle={() => {}}
                collapsible={false}
              >
                {isGitRepo && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ExplorerSegmentedTabs
                      active={effectiveExplorerTab}
                      changesCount={changesCount}
                      onSelect={handleSelectExplorerTab}
                    />
                  </div>
                )}
              </WorkbenchSectionHeader>
              {(
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
                      refreshKey={explorerRefreshKey}
                      gitStatusByPath={gitStatusByPath}
                      changedDirectoryPaths={changedDirectoryPaths}
                    />
                  )}
                </div>
              )}
            </div>
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
                      refreshKey={explorerRefreshKey}
                      gitStatusByPath={EMPTY_GIT_STATUS_BY_PATH}
                      changedDirectoryPaths={EMPTY_CHANGED_DIRECTORY_PATHS}
                    />
                  </>
                )}
              </>
            )}
          </div>
        );

      case "loop":
        return (
          <div>
            {loops.length === 0 ? (
              <div style={{ padding: "7px 22px 10px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                暂无 Loop。点击头部「管理」新建。
              </div>
            ) : loops.map((loop) => {
              const expanded = expandedLoopId === loop.id;
              const runs = loopRuns[loop.id];
              const cron = loop.triggers.find((trigger): trigger is CronTriggerDefinition => trigger.type === "cron" && trigger.enabled);
              const summary = !loop.enabled
                ? "已停用"
                : cron ? cron.expression
                : loop.triggers.some((trigger) => trigger.type === "manual" && trigger.enabled) ? "手动"
                : "—";
              return (
                <div key={loop.id}>
                  <div style={{ display: "flex", alignItems: "center", padding: "4px 12px 4px 10px" }}>
                    <button
                      onClick={() => toggleLoopExpanded(loop.id)}
                      title={expanded ? "收起运行记录" : "展开运行记录"}
                      style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer", width: 18, fontSize: 10, padding: 0, flexShrink: 0, transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "none" }}
                    >
                      ▶
                    </button>
                    <button
                      onClick={() => toggleLoopExpanded(loop.id)}
                      style={{ ...rowStyle(), padding: "6px 4px", flex: 1, minWidth: 0 }}
                    >
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: loop.enabled ? "var(--text)" : "var(--text-dim)" }}>{loop.name}</span>
                      <span style={{ color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)", flexShrink: 0 }}>{summary}</span>
                    </button>
                    <button
                      onClick={() => onTriggerLoop(loop)}
                      title="手动触发一轮"
                      style={{ border: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", width: 22, fontSize: 12, padding: 0, flexShrink: 0 }}
                    >
                      ▶
                    </button>
                    <button
                      onClick={onOpenLoops}
                      title="配置 / 编辑定义"
                      style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer", width: 22, fontSize: 12, padding: 0, flexShrink: 0 }}
                    >
                      ⚙
                    </button>
                  </div>
                  {expanded && (
                    <div>
                      {!runs ? (
                        <div style={{ padding: "4px 22px 8px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>加载中…</div>
                      ) : runs.length === 0 ? (
                        <div style={{ padding: "4px 22px 8px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>暂无运行记录</div>
                      ) : runs.map((run) => {
                        const dotColor = run.status === "failed" ? "#e5484d"
                          : run.status === "running" || run.status === "queued" ? "#22c55e"
                          : "#16a34a";
                        const started = new Date(run.startedAt);
                        const time = `${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")} ${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
                        // v3: a seeded run opens its EXECUTION session (the
                        // contract run — where gates/answers live); only
                        // unseeded runs open the selection orchestrator.
                        const openTarget = run.seededSessionId ?? run.sessionId;
                        return (
                          <button
                            key={run.id}
                            onClick={() => openTarget && onOpenLoopSession(openTarget)}
                            disabled={!openTarget}
                            title={openTarget ? (run.seededSessionId ? "打开执行会话" : "打开选品会话") : "会话尚未创建"}
                            style={{ ...rowStyle(false), padding: "5px 10px 5px 30px", cursor: openTarget ? "pointer" : "default", opacity: openTarget ? 1 : 0.55 }}
                          >
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0, boxShadow: run.status === "running" ? "0 0 0 3px rgba(34,197,94,0.18)" : "none" }} />
                            <span style={{ color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)", flexShrink: 0 }}>{time}</span>
                            {run.seededSessionId && (
                              <span style={{ padding: "1px 6px", borderRadius: 5, border: "1px solid var(--border)", color: "var(--accent)", fontSize: "var(--pi-sidebar-fs-meta)", flexShrink: 0 }}>已播种</span>
                            )}
                            <span style={{ color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                              {run.seedRefused ? `播种被拒：${run.seedRefused}` : (run.verdict || run.progress || "—")}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
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
      case "loop":
        return (
          <PanelHeader
            title="Loop"
            actions={
              <PanelHeaderButton onClick={onOpenLoops} title="新建 / 管理 Loop">
                管理
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
