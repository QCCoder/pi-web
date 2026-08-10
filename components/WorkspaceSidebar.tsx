"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileExplorer } from "./FileExplorer";
import { ActivityBar, visibleActivityViews, type SidebarView } from "./ActivityBar";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useGitStatus } from "@/hooks/useGitStatus";
import { ChangesPanel } from "./ChangesPanel";
import type { SessionInfo } from "@/lib/types";
import type { GitFileStatus } from "@/lib/git-types";
import type { WorkItemRecord, WorkItemType } from "@/lib/work-items/types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";

interface Props {
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  selectedSessionId: string | null;
  selectedWorkItemKey: string | null;
  runningSessionIds: Set<string>;
  completedSessionIds: Set<string>;
  allSessions: SessionInfo[];
  refreshKey: number;
  explorerRefreshKey: number;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onOpenWorkspaceSettings: () => void;
  onOpenLoops: () => void;
  loopsActive: boolean;
  onAddRepository: () => void;
  onNewSession: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onSelectWorkItem: (item: WorkItemRecord) => void;
  onCreateWorkItem: (type: WorkItemType) => void;
  onOpenFile: (path: string, name: string) => void;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
  onOpenArchive: () => void;
  onSessionRemoved?: (id: string) => void;
}

// Knowledge repos are browsed with a FileExplorer that has no git overlay in the
// MVP (OKF directory tree only). Use stable empty collections so FileExplorer's
// internal effects don't re-run every render.
const EMPTY_GIT_STATUS_BY_PATH = new Map<string, GitFileStatus>();
const EMPTY_CHANGED_DIRECTORY_PATHS = new Set<string>();

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

/** Slim header for a focused view: label + optional add/action button. */
function ViewHeader({
  label,
  meta,
  action,
  actionLabel,
}: {
  label: string;
  meta?: ReactNode;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px 6px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <strong style={{ flex: 1, fontSize: "var(--pi-sidebar-fs)", color: "var(--text)" }}>{label}</strong>
      {meta}
      {action && (
        <button
          onClick={action}
          title={actionLabel}
          aria-label={actionLabel}
          style={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border)",
            borderRadius: 5,
            background: "var(--bg)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
          }}
        >
          +
        </button>
      )}
    </div>
  );
}

/** Explorer view internal [ 文件 | 改动(N) ] segmented switch.
 *  Changes is merged into Explorer (decision 8): the changes list follows the
 *  Explorer's current cwd scope. Only rendered inside a git directory. */
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
        margin: "6px 8px",
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

export function WorkspaceSidebar({
  activeWorkspace,
  workspaces,
  selectedSessionId,
  selectedWorkItemKey,
  runningSessionIds,
  completedSessionIds,
  allSessions,
  refreshKey,
  explorerRefreshKey,
  onSelectWorkspace,
  onCreateWorkspace,
  onImportDirectory,
  onOpenWorkspaceSettings,
  onOpenLoops,
  loopsActive,
  onAddRepository,
  onNewSession,
  onSelectSession,
  onSelectWorkItem,
  onCreateWorkItem,
  onOpenFile,
  onOpenModels,
  onOpenSkills,
  onOpenPlugins,
  onOpenArchive,
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
      return owner?.id === activeWorkspace.id && !session.subagentChild;
    });
  }, [allSessions, activeWorkspace, workspaces]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [requirementsOpen, setRequirementsOpen] = useState(true);
  const [bugsOpen, setBugsOpen] = useState(true);
  const [explorerTab, setExplorerTab] = useState<"files" | "changes">("files");
  const [activeView, setActiveView] = useState<SidebarView>("sessions");
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

  const isMobile = useIsMobile();

  // The views available for this workspace, in canonical Activity Bar order
  // (sessions/explorer always on; rest gated by capability).
  const visibleViews = useMemo(
    () => visibleActivityViews(activeWorkspace?.capabilities ?? []),
    [activeWorkspace],
  );

  const loadWorkspaceData = useCallback(async () => {
    if (!activeWorkspace) {
      setWorkItems([]);
      setRepositories([]);
      setArchivedCount(0);
      return;
    }
    const [itemsResponse, repositoriesResponse, archivedSessionsResponse, archivedItemsResponse] = await Promise.all([
      hasCapability("work-items")
        ? fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/work-items`)
        : null,
      hasCapability("repositories")
        ? fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/repositories`)
        : null,
      fetch("/api/sessions?archived"),
      hasCapability("work-items")
        ? fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/work-items?archived`)
        : null,
    ]);
    const itemsData = itemsResponse?.ok
      ? await itemsResponse.json() as { items?: WorkItemRecord[] }
      : {};
    const repositoriesData = repositoriesResponse?.ok
      ? await repositoriesResponse.json() as { repositories?: WorkspaceRepositoryState[] }
      : {};
    const archivedSessionsData = archivedSessionsResponse?.ok
      ? await archivedSessionsResponse.json() as { sessions?: { cwd: string }[] }
      : { sessions: [] };
    const archivedItemsData = archivedItemsResponse?.ok
      ? await archivedItemsResponse.json() as { items?: unknown[] }
      : { items: [] };
    const wsPrefix = `${activeWorkspace.path.replace(/\/+$/, "")}/`;
    const archivedSessionsInWs = (archivedSessionsData.sessions ?? []).filter((session) =>
      session.cwd === activeWorkspace.path || session.cwd.startsWith(wsPrefix));
    setArchivedCount(archivedSessionsInWs.length + (archivedItemsData.items ?? []).length);
    setWorkItems(itemsData.items ?? []);
    setRepositories(repositoriesData.repositories ?? []);
  }, [activeWorkspace, hasCapability]);

  const archiveWorkItem = useCallback(async (item: WorkItemRecord) => {
    if (!activeWorkspace) return;
    await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/work-items/${encodeURIComponent(item.key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: item.revision, archived: true }),
    });
    await loadWorkspaceData();
  }, [activeWorkspace, loadWorkspaceData]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData, refreshKey]);

  useEffect(() => {
    if (!activeWorkspace) return;
    const prefix = `pi-work-item-groups:${activeWorkspace.id}:`;
    setRequirementsOpen(localStorage.getItem(`${prefix}requirements`) !== "closed");
    setBugsOpen(localStorage.getItem(`${prefix}bugs`) !== "closed");
  }, [activeWorkspace]);

  // Explorer 内部 [ 文件 | 改动 ] 分段选择，按工作区持久化。
  useEffect(() => {
    if (!activeWorkspace) return;
    const stored = localStorage.getItem(`pi-explorer-tab:${activeWorkspace.id}`);
    setExplorerTab(stored === "changes" ? "changes" : "files");
  }, [activeWorkspace]);

  // Single-focus Activity Bar view, persisted per workspace. On workspace switch
  // (or capability change) re-derive the stored view, falling back to "sessions".
  useEffect(() => {
    if (!activeWorkspace) return;
    const stored = localStorage.getItem(`pi-active-view:${activeWorkspace.id}`);
    const candidate = stored as SidebarView | null;
    const valid = candidate && visibleViews.includes(candidate) ? candidate : "sessions";
    setActiveView(valid);
  }, [activeWorkspace, visibleViews]);

  const handleSwitchView = useCallback((view: SidebarView) => {
    setActiveView(view);
    if (activeWorkspace) localStorage.setItem(`pi-active-view:${activeWorkspace.id}`, view);
  }, [activeWorkspace]);

  const handleSelectExplorerTab = useCallback((tab: "files" | "changes") => {
    setExplorerTab(tab);
    if (activeWorkspace) {
      localStorage.setItem(`pi-explorer-tab:${activeWorkspace.id}`, tab);
    }
  }, [activeWorkspace]);

  const toggleWorkItemGroup = useCallback((
    group: "requirements" | "bugs",
    current: boolean,
  ) => {
    const next = !current;
    if (activeWorkspace) {
      localStorage.setItem(
        `pi-work-item-groups:${activeWorkspace.id}:${group}`,
        next ? "open" : "closed",
      );
    }
    if (group === "requirements") setRequirementsOpen(next);
    else setBugsOpen(next);
  }, [activeWorkspace]);

  const groupedWorkItems = useMemo(() => ({
    requirements: workItems.filter((item) => item.type === "requirement" && !item.archivedAt),
    bugs: workItems.filter((item) => item.type === "bug" && !item.archivedAt),
  }), [workItems]);

  // Repositories split by kind: "仓库" view shows only code (decision 3),
  // "知识库" view shows only knowledge (decision 3/4).
  const codeRepositories = useMemo(
    () => repositories.filter((repository) => repository.kind === "code" && repository.status === "active"),
    [repositories],
  );
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

  if (!activeWorkspace) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ padding: "14px 12px 10px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: "var(--pi-sidebar-fs-title)", fontWeight: 750, color: "var(--text)" }}>Pi Web</div>
          <div style={{ marginTop: 4, fontSize: "var(--pi-sidebar-fs)", color: "var(--text-dim)" }}>选择工作区后开始协作</div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "2px 4px 8px" }}>
            <strong style={{ flex: 1, fontSize: "var(--pi-sidebar-fs)", color: "var(--text)" }}>Workspaces</strong>
            <button className="workspace-action" onClick={onCreateWorkspace}>新建</button>
          </div>
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
                  ? `${workspace.templateId ?? "自定义"} · ${workspace.repositoryCount} repositories`
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
        <SettingsBar
          scopeLabel="全局"
          workspaceScoped={false}
          onOpenModels={onOpenModels}
          onOpenSkills={onOpenSkills}
          onOpenPlugins={onOpenPlugins}
        />
      </div>
    );
  }

  const renderActiveView = (): ReactNode => {
    switch (activeView) {
      case "sessions":
        return (
          <div>
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
        );

      case "explorer":
        return (
          <div>
            {isGitRepo && (
              <ExplorerSegmentedTabs
                active={effectiveExplorerTab}
                changesCount={changesCount}
                onSelect={handleSelectExplorerTab}
              />
            )}
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
        );

      case "repositories":
        return (
          <div>
            <ViewHeader label="仓库" action={onAddRepository} actionLabel="添加仓库" />
            {codeRepositories.map((repository) => (
              <button
                key={repository.id}
                style={rowStyle()}
                onClick={() => handleSwitchView("explorer")}
                title="在 Explorer 中浏览"
              >
                <span style={{ flex: 1 }}>{repository.name}</span>
                <span style={{ color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                  {repository.branch || "—"}{repository.dirty ? " · modified" : ""}
                </span>
              </button>
            ))}
            {codeRepositories.length === 0 && (
              <div style={{ padding: "7px 22px 10px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                暂无代码仓库
              </div>
            )}
          </div>
        );

      case "knowledge":
        return (
          <div>
            <ViewHeader label="知识库" action={onAddRepository} actionLabel="添加知识库" />
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
                  <FileExplorer
                    cwd={effectiveKnowledgeRepo.path}
                    onOpenFile={onOpenFile}
                    refreshKey={explorerRefreshKey}
                    gitStatusByPath={EMPTY_GIT_STATUS_BY_PATH}
                    changedDirectoryPaths={EMPTY_CHANGED_DIRECTORY_PATHS}
                  />
                )}
              </>
            )}
          </div>
        );

      case "loop":
        return (
          <div>
            <ViewHeader label="Loop" />
            <div style={{ padding: "12px" }}>
              <button
                onClick={onOpenLoops}
                style={{
                  width: "100%",
                  padding: "var(--pi-sidebar-section-py) 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: loopsActive ? "var(--bg-selected)" : "var(--bg)",
                  color: loopsActive ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: "var(--pi-sidebar-fs)",
                }}
              >
                管理 Loops
              </button>
              <div style={{ marginTop: 8, color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)", lineHeight: 1.6 }}>
                自动化 maker/checker 运行编排。点击上方按钮在主区配置、触发或审批一轮。
              </div>
            </div>
          </div>
        );

      case "work-items":
        return (
          <div>
            <ViewHeader
              label="工作项"
              action={() => onCreateWorkItem("requirement")}
              actionLabel="新建工作项"
            />
            <WorkItemGroup
              label="需求"
              items={groupedWorkItems.requirements}
              open={requirementsOpen}
              selectedKey={selectedWorkItemKey}
              onSelect={onSelectWorkItem}
              onToggle={() => toggleWorkItemGroup("requirements", requirementsOpen)}
              onArchive={archiveWorkItem}
            />
            <WorkItemGroup
              label="Bug"
              items={groupedWorkItems.bugs}
              open={bugsOpen}
              selectedKey={selectedWorkItemKey}
              onSelect={onSelectWorkItem}
              onToggle={() => toggleWorkItemGroup("bugs", bugsOpen)}
              onArchive={archiveWorkItem}
            />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "10px", borderBottom: "1px solid var(--border)", position: "relative" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setWorkspaceMenuOpen((current) => !current)}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "7px 9px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg)",
              color: "var(--text)",
              cursor: "pointer",
              fontWeight: 700,
              textAlign: "left",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activeWorkspace.name}
            </span>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setCreateMenuOpen((current) => !current)}
              title="新建 / 导入"
              aria-label="新建 / 导入"
              style={{
                width: 34,
                height: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid var(--border)",
                borderRadius: 7,
                background: "var(--bg)",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              ＋
            </button>
            {createMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: 40,
                  right: 0,
                  zIndex: 20,
                  minWidth: 168,
                  padding: 5,
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "var(--bg)",
                  boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
                }}
              >
                <button
                  style={rowStyle()}
                  onClick={() => { setCreateMenuOpen(false); onCreateWorkspace(); }}
                >
                  ＋ 新建 Workspace
                </button>
                <button
                  style={rowStyle()}
                  onClick={() => { setCreateMenuOpen(false); onImportDirectory(); }}
                >
                  ＋ 导入目录…
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onOpenWorkspaceSettings}
            title="Workspace 设置"
            aria-label="Workspace 设置"
            style={{
              width: 34,
              height: 34,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            ⚙
          </button>
        </div>
        {workspaceMenuOpen && (
          <div
            style={{
              position: "absolute",
              top: 48,
              left: 10,
              right: 10,
              zIndex: 20,
              padding: 5,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
            }}
          >
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                disabled={!workspace.available}
                style={rowStyle(workspace.id === activeWorkspace.id)}
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  onSelectWorkspace(workspace);
                }}
              >
                {workspace.name}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={onNewSession}
          style={{
            width: "100%",
            marginTop: 8,
            padding: "var(--pi-sidebar-section-py) 10px",
            border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
            borderRadius: 7,
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            color: "var(--accent)",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          ＋ 新建会话
        </button>
      </div>

      {/* Middle: Activity Bar (left icon strip on desktop / bottom tab bar on
          mobile) + the single focused view. Only one view renders at a time. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isMobile ? "column" : "row" }}>
        {!isMobile && (
          <ActivityBar
            variant="vertical"
            activeView={activeView}
            capabilities={activeWorkspace.capabilities}
            onSwitch={handleSwitchView}
            highlightView={loopsActive ? "loop" : null}
          />
        )}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
          {renderActiveView()}
        </div>
      </div>

      <ArchiveBarButton count={archivedCount} onOpen={onOpenArchive} />

      <SettingsBar
        scopeLabel={activeWorkspace.name}
        workspaceScoped
        onOpenModels={onOpenModels}
        onOpenSkills={onOpenSkills}
        onOpenPlugins={onOpenPlugins}
      />

      {isMobile && (
        <ActivityBar
          variant="horizontal"
          activeView={activeView}
          capabilities={activeWorkspace.capabilities}
          onSwitch={handleSwitchView}
          highlightView={loopsActive ? "loop" : null}
        />
      )}
    </div>
  );
}

function WorkItemGroup({
  label,
  items,
  open,
  selectedKey,
  onSelect,
  onToggle,
  onArchive,
}: {
  label: string;
  items: WorkItemRecord[];
  open: boolean;
  selectedKey: string | null;
  onSelect: (item: WorkItemRecord) => void;
  onToggle: () => void;
  onArchive?: (item: WorkItemRecord) => void;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "calc(var(--pi-sidebar-row-py) - 2px) 10px calc(var(--pi-sidebar-row-py) - 2px) 22px",
          border: 0,
          background: "transparent",
          color: "var(--text-dim)",
          fontSize: "var(--pi-sidebar-fs-meta)",
          fontWeight: 500,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          aria-hidden="true"
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          ›
        </span>
        <span style={{ flex: 1 }}>{label}</span>
        <span>{items.length}</span>
      </button>
      {open && items.map((item) => (
        <WorkItemRow
          key={item.id}
          item={item}
          isSelected={item.key === selectedKey}
          onSelect={() => onSelect(item)}
          onArchive={onArchive ? () => onArchive(item) : undefined}
        />
      ))}
    </div>
  );
}

function SettingsBar({
  scopeLabel,
  workspaceScoped,
  onOpenModels,
  onOpenSkills,
  onOpenPlugins,
}: {
  scopeLabel: string;
  workspaceScoped: boolean;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
}) {
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "7px 8px 8px" }}>
      <div
        title={scopeLabel}
        style={{
          padding: "0 3px 5px",
          color: "var(--text-dim)",
          fontSize: "var(--pi-sidebar-fs-meta)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {workspaceScoped
          ? `模型：全局 · Skills / 插件：${scopeLabel}`
          : "设置作用域：全局"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
        {[
          ["模型", onOpenModels],
          ["Skills", onOpenSkills],
          ["插件", onOpenPlugins],
        ].map(([label, action]) => (
          <button
            key={label as string}
            onClick={action as () => void}
            style={{
              minHeight: "var(--pi-sidebar-btn-h)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: "var(--pi-sidebar-btn-fs)",
            }}
          >
            {label as string}
          </button>
        ))}
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

function ArchiveBarButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "7px 12px",
        border: 0,
        borderTop: "1px solid var(--border)",
        background: "transparent",
        color: "var(--text-muted)",
        cursor: "pointer",
        fontSize: "var(--pi-sidebar-fs)",
        textAlign: "left",
      }}
    >
      <span>归档</span>
      {count > 0 && (
        <span style={{
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg-hover)",
          borderRadius: 10,
          padding: "1px 8px",
        }}>{count}</span>
      )}
    </button>
  );
}

function WorkItemRow({
  item,
  isSelected,
  onSelect,
  onArchive,
}: {
  item: WorkItemRecord;
  isSelected: boolean;
  onSelect: () => void;
  onArchive?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...rowStyle(isSelected) }}
    >
      <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "var(--pi-sidebar-fs-meta)", flexShrink: 0 }}>
        {item.key}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {item.title}
      </span>
      {hovered && onArchive && (
        <button title="归档" onClick={(e) => { e.stopPropagation(); onArchive(); }} style={hoverActionBtn}>归档</button>
      )}
    </div>
  );
}

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
