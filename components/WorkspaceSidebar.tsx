"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileExplorer } from "./FileExplorer";
import { DirectoryPicker } from "./DirectoryPicker";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionInfo } from "@/lib/types";
import type { WorkItemRecord, WorkItemType } from "@/lib/work-items/types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";

interface Props {
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  selectedSessionId: string | null;
  selectedWorkItemKey: string | null;
  refreshKey: number;
  explorerRefreshKey: number;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onImportWorkspace: (workspace: WorkspaceSummary) => void;
  onReturnHome: () => void;
  onOpenWorkspaceSettings: () => void;
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

const sectionButtonStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "var(--pi-sidebar-section-py) 10px",
  border: 0,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: "var(--pi-sidebar-fs)",
  fontWeight: 700,
  textAlign: "left",
};

function SectionHeader({
  label,
  open,
  onToggle,
  action,
  actionLabel,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", borderTop: "1px solid var(--border)" }}>
      <button style={sectionButtonStyle} onClick={onToggle}>
        <span
          aria-hidden="true"
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          ›
        </span>
        <span style={{ flex: 1 }}>{label}</span>
      </button>
      {action && (
        <button
          onClick={action}
          title={actionLabel}
          aria-label={actionLabel}
          style={{
            width: 28,
            height: 28,
            marginRight: 6,
            border: 0,
            borderRadius: 6,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 18,
          }}
        >
          +
        </button>
      )}
    </div>
  );
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

export function WorkspaceSidebar({
  activeWorkspace,
  workspaces,
  selectedSessionId,
  selectedWorkItemKey,
  refreshKey,
  explorerRefreshKey,
  onSelectWorkspace,
  onCreateWorkspace,
  onImportWorkspace,
  onReturnHome,
  onOpenWorkspaceSettings,
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
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [workItemsOpen, setWorkItemsOpen] = useState(true);
  const [requirementsOpen, setRequirementsOpen] = useState(true);
  const [bugsOpen, setBugsOpen] = useState(true);
  const [repositoriesOpen, setRepositoriesOpen] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const hasCapability = useCallback(
    (capability: WorkspaceSummary["capabilities"][number]) =>
      activeWorkspace?.capabilities.includes(capability) ?? false,
    [activeWorkspace],
  );

  const loadWorkspaceData = useCallback(async () => {
    if (!activeWorkspace) {
      setSessions([]);
      setWorkItems([]);
      setRepositories([]);
      setArchivedCount(0);
      return;
    }
    const [sessionsResponse, itemsResponse, repositoriesResponse, archivedSessionsResponse, archivedItemsResponse] = await Promise.all([
      fetch("/api/sessions"),
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
    const sessionsData = sessionsResponse.ok
      ? await sessionsResponse.json() as { sessions?: SessionInfo[] }
      : {};
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
    setSessions((sessionsData.sessions ?? []).filter((session) => {
      const owner = workspaces
        .filter((workspace) => {
          const prefix = `${workspace.path.replace(/\/+$/, "")}/`;
          return workspace.available
            && (session.cwd === workspace.path || session.cwd.startsWith(prefix));
        })
        .sort((left, right) => right.path.length - left.path.length)[0];
      return owner?.id === activeWorkspace.id;
    }));
    setWorkItems(itemsData.items ?? []);
    setRepositories(repositoriesData.repositories ?? []);
  }, [activeWorkspace, hasCapability, workspaces]);

  const archiveWorkItem = useCallback(async (item: WorkItemRecord) => {
    if (!activeWorkspace) return;
    await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/work-items/${encodeURIComponent(item.key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: item.revision, archived: true }),
    });
    await loadWorkspaceData();
  }, [activeWorkspace, loadWorkspaceData]);

  const importDirectory = useCallback(async (path: string) => {
    setImportBusy(true);
    setImportError(null);
    try {
      let asCopy = false;
      let workspace: WorkspaceSummary | undefined;
      while (!workspace) {
        const response = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, ...(asCopy ? { asCopy: true } : {}) }),
        });
        const data = await response.json() as { workspace?: WorkspaceSummary; error?: string };
        if (response.ok && data.workspace) {
          workspace = data.workspace;
          break;
        }
        const message = data.error ?? `HTTP ${response.status}`;
        if (
          !asCopy
          && response.status === 409
          && message.includes("already registered")
          && window.confirm("这个目录是现有 Workspace 的副本。要生成新的 Workspace ID 并作为副本导入吗？")
        ) {
          asCopy = true;
          continue;
        }
        throw new Error(message);
      }
      setImportOpen(false);
      onImportWorkspace(workspace);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(false);
    }
  }, [onImportWorkspace]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData, refreshKey]);

  useEffect(() => {
    if (!activeWorkspace) return;
    const prefix = `pi-work-item-groups:${activeWorkspace.id}:`;
    setRequirementsOpen(localStorage.getItem(`${prefix}requirements`) !== "closed");
    setBugsOpen(localStorage.getItem(`${prefix}bugs`) !== "closed");
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

  const isMobile = useIsMobile();
  const collapsedSecondaryOnMobileRef = useRef(false);
  useEffect(() => {
    // On mobile the drawer is narrow; default-collapse the secondary sections
    // (work items, repositories) so 会话 is prominent on first open. Runs once.
    if (isMobile && !collapsedSecondaryOnMobileRef.current) {
      collapsedSecondaryOnMobileRef.current = true;
      setWorkItemsOpen(false);
      setRepositoriesOpen(false);
    }
  }, [isMobile]);

  const groupedWorkItems = useMemo(() => ({
    requirements: workItems.filter((item) => item.type === "requirement" && !item.archivedAt),
    bugs: workItems.filter((item) => item.type === "bug" && !item.archivedAt),
  }), [workItems]);

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
                  ? `${workspace.templateId} · ${workspace.repositoryCount} repositories`
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
            onClick={() => setImportOpen(true)}
            style={{ ...rowStyle(), padding: "9px 10px", marginTop: 10 }}
          >
            导入目录…
          </button>
        </div>
        <SettingsBar
          scopeLabel="全局"
          workspaceScoped={false}
          onOpenModels={onOpenModels}
          onOpenSkills={onOpenSkills}
          onOpenPlugins={onOpenPlugins}
        />
        {importOpen && (
          <DirectoryPicker
            onCancel={() => setImportOpen(false)}
            onSelect={(path) => void importDirectory(path)}
            busy={importBusy}
            error={importError}
          />
        )}
      </div>
    );
  }

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
            <span aria-hidden="true">⌄</span>
          </button>
          <button
            onClick={onOpenWorkspaceSettings}
            title="Workspace 设置"
            aria-label="Workspace 设置"
            style={{
              width: 34,
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
            <button style={rowStyle()} onClick={onCreateWorkspace}>＋ 新建 Workspace</button>
            <button style={rowStyle()} onClick={() => setImportOpen(true)}>导入目录…</button>
            <button style={rowStyle()} onClick={onReturnHome}>返回首页</button>
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

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {(
          <>
            <SectionHeader
              label="会话"
              open={sessionsOpen}
              onToggle={() => setSessionsOpen((current) => !current)}
            />
            {sessionsOpen && (
              <div>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    isSelected={session.id === selectedSessionId}
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
          </>
        )}

        {hasCapability("work-items") && (
          <>
            <SectionHeader
              label="工作项"
              open={workItemsOpen}
              onToggle={() => setWorkItemsOpen((current) => !current)}
              action={() => onCreateWorkItem("requirement")}
              actionLabel="新建工作项"
            />
            {workItemsOpen && (
              <div>
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
            )}
          </>
        )}

        {(
          <>
            {hasCapability("repositories") && (
              <>
            <SectionHeader
              label="仓库"
              open={repositoriesOpen}
              onToggle={() => setRepositoriesOpen((current) => !current)}
              action={onAddRepository}
              actionLabel="添加仓库"
            />
            {repositoriesOpen && (
              <div>
                {(["code", "knowledge"] as const).map((kind) => {
                  const items = repositories.filter((repository) =>
                    repository.kind === kind && repository.status === "active"
                  );
                  if (items.length === 0) return null;
                  return (
                    <div key={kind}>
                      <div style={{ padding: "4px 12px 3px 22px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                        {kind === "code" ? "代码" : "知识库"}
                      </div>
                      {items.map((repository) => (
                        <button
                          key={repository.id}
                          style={rowStyle()}
                          onClick={() => setExplorerOpen(true)}
                        >
                          <span style={{ flex: 1 }}>{repository.name}</span>
                          <span style={{ color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                            {repository.branch || "—"}{repository.dirty ? " · modified" : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {repositories.filter((repository) => repository.status === "active").length === 0 && (
                  <div style={{ padding: "7px 22px 10px", color: "var(--text-dim)", fontSize: "var(--pi-sidebar-fs-meta)" }}>
                    暂无仓库
                  </div>
                )}
              </div>
            )}
              </>
            )}

            {hasCapability("explorer") && (
              <>
                <SectionHeader
                  label="Explorer"
                  open={explorerOpen}
                  onToggle={() => setExplorerOpen((current) => !current)}
                />
                {explorerOpen && (
                  <div style={{ minHeight: 220 }}>
                    <FileExplorer
                      cwd={activeWorkspace.path}
                      onOpenFile={onOpenFile}
                      refreshKey={explorerRefreshKey}
                      changesCollapsed={false}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      <ArchiveBarButton count={archivedCount} onOpen={onOpenArchive} />

      <SettingsBar
        scopeLabel={activeWorkspace.name}
        workspaceScoped
        onOpenModels={onOpenModels}
        onOpenSkills={onOpenSkills}
        onOpenPlugins={onOpenPlugins}
      />
      {importOpen && (
        <DirectoryPicker
          onCancel={() => setImportOpen(false)}
          onSelect={(path) => void importDirectory(path)}
          busy={importBusy}
          error={importError}
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
          ...sectionButtonStyle,
          padding: "calc(var(--pi-sidebar-row-py) - 2px) 10px calc(var(--pi-sidebar-row-py) - 2px) 22px",
          color: "var(--text-dim)",
          fontSize: "var(--pi-sidebar-fs-meta)",
          fontWeight: 500,
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
  onSelect,
  onChanged,
  onRemoved,
}: {
  session: SessionInfo;
  isSelected: boolean;
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
      {hovered && !busy && (
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <button title="归档" onClick={() => void archive()} style={hoverActionBtn}>归档</button>
        </div>
      )}
    </div>
  );
}
