"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileExplorer } from "./FileExplorer";
import type { SessionInfo } from "@/lib/types";
import type { WorkItemRecord, WorkItemType } from "@/lib/work-items/types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";

type MobilePane = "work-items" | "conversations" | "explorer";

interface Props {
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  selectedSessionId: string | null;
  selectedWorkItemKey: string | null;
  refreshKey: number;
  explorerRefreshKey: number;
  mobilePane?: MobilePane;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
  onOpenDirectoryMode: () => void;
  onReturnHome: () => void;
  onOpenWorkspaceSettings: () => void;
  onNewSession: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onSelectWorkItem: (item: WorkItemRecord) => void;
  onCreateWorkItem: (type: WorkItemType) => void;
  onOpenFile: (path: string, name: string) => void;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
}

const sectionButtonStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "7px 10px",
  border: 0,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
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
    padding: "6px 12px 6px 22px",
    border: 0,
    background: active ? "var(--bg-selected)" : "transparent",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
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
  mobilePane,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenDirectoryMode,
  onReturnHome,
  onOpenWorkspaceSettings,
  onNewSession,
  onSelectSession,
  onSelectWorkItem,
  onCreateWorkItem,
  onOpenFile,
  onOpenModels,
  onOpenSkills,
  onOpenPlugins,
}: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [workItemsOpen, setWorkItemsOpen] = useState(true);
  const [repositoriesOpen, setRepositoriesOpen] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(false);

  const loadWorkspaceData = useCallback(async () => {
    if (!activeWorkspace) {
      setSessions([]);
      setWorkItems([]);
      setRepositories([]);
      return;
    }
    const [sessionsResponse, itemsResponse, repositoriesResponse] = await Promise.all([
      fetch("/api/sessions"),
      fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/work-items`),
      fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/repositories`),
    ]);
    const sessionsData = sessionsResponse.ok
      ? await sessionsResponse.json() as { sessions?: SessionInfo[] }
      : {};
    const itemsData = itemsResponse.ok
      ? await itemsResponse.json() as { items?: WorkItemRecord[] }
      : {};
    const repositoriesData = repositoriesResponse.ok
      ? await repositoriesResponse.json() as { repositories?: WorkspaceRepositoryState[] }
      : {};
    const prefix = `${activeWorkspace.path.replace(/\/+$/, "")}/`;
    setSessions((sessionsData.sessions ?? []).filter((session) =>
      session.cwd === activeWorkspace.path || session.cwd.startsWith(prefix)
    ));
    setWorkItems(itemsData.items ?? []);
    setRepositories(repositoriesData.repositories ?? []);
  }, [activeWorkspace]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData, refreshKey]);

  const groupedWorkItems = useMemo(() => ({
    requirements: workItems.filter((item) => item.type === "requirement"),
    bugs: workItems.filter((item) => item.type === "bug"),
  }), [workItems]);

  if (!activeWorkspace) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ padding: "14px 12px 10px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 750, color: "var(--text)" }}>Pi Web</div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>选择工作区后开始协作</div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "2px 4px 8px" }}>
            <strong style={{ flex: 1, fontSize: 12, color: "var(--text)" }}>Workspaces</strong>
            <button className="workspace-action" onClick={onCreateWorkspace}>新建</button>
          </div>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
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
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <strong style={{ fontSize: 12 }}>{workspace.name}</strong>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                {workspace.repositoryCount} repositories
              </span>
            </button>
          ))}
          {workspaces.length === 0 && (
            <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11 }}>
              尚未创建 Workspace。
            </div>
          )}
          <button
            onClick={onOpenDirectoryMode}
            style={{ ...rowStyle(), padding: "9px 10px", marginTop: 10 }}
          >
            打开普通目录…
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

  const showConversations = mobilePane === undefined || mobilePane === "conversations";
  const showWorkItems = mobilePane === undefined || mobilePane === "work-items";
  const showExplorer = mobilePane === undefined || mobilePane === "explorer";

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
            <button style={rowStyle()} onClick={onOpenDirectoryMode}>打开普通目录…</button>
            <button style={rowStyle()} onClick={onReturnHome}>返回首页</button>
          </div>
        )}
        <button
          onClick={onNewSession}
          style={{
            width: "100%",
            marginTop: 8,
            padding: "8px 10px",
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
        {showConversations && (
          <>
            <SectionHeader
              label="会话"
              open={sessionsOpen}
              onToggle={() => setSessionsOpen((current) => !current)}
            />
            {sessionsOpen && (
              <div>
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    style={rowStyle(session.id === selectedSessionId)}
                    onClick={() => onSelectSession(session)}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {session.name || session.firstMessage || "未命名会话"}
                    </span>
                  </button>
                ))}
                {sessions.length === 0 && (
                  <div style={{ padding: "7px 22px 10px", color: "var(--text-dim)", fontSize: 10 }}>
                    暂无会话
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {showWorkItems && (
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
                  selectedKey={selectedWorkItemKey}
                  onSelect={onSelectWorkItem}
                  onCreate={() => onCreateWorkItem("requirement")}
                />
                <WorkItemGroup
                  label="Bug"
                  items={groupedWorkItems.bugs}
                  selectedKey={selectedWorkItemKey}
                  onSelect={onSelectWorkItem}
                  onCreate={() => onCreateWorkItem("bug")}
                />
              </div>
            )}
          </>
        )}

        {showExplorer && (
          <>
            <SectionHeader
              label="仓库"
              open={repositoriesOpen}
              onToggle={() => setRepositoriesOpen((current) => !current)}
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
                      <div style={{ padding: "4px 12px 3px 22px", color: "var(--text-dim)", fontSize: 10 }}>
                        {kind === "code" ? "代码" : "知识库"}
                      </div>
                      {items.map((repository) => (
                        <button
                          key={repository.id}
                          style={rowStyle()}
                          onClick={() => setExplorerOpen(true)}
                        >
                          <span style={{ flex: 1 }}>{repository.name}</span>
                          <span style={{ color: "var(--text-dim)", fontSize: 9 }}>
                            {repository.branch || "—"}{repository.dirty ? " · modified" : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {repositories.filter((repository) => repository.status === "active").length === 0 && (
                  <div style={{ padding: "7px 22px 10px", color: "var(--text-dim)", fontSize: 10 }}>
                    暂无仓库
                  </div>
                )}
              </div>
            )}

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
      </div>

      <SettingsBar
        scopeLabel={activeWorkspace.name}
        workspaceScoped
        onOpenModels={onOpenModels}
        onOpenSkills={onOpenSkills}
        onOpenPlugins={onOpenPlugins}
      />
    </div>
  );
}

function WorkItemGroup({
  label,
  items,
  selectedKey,
  onSelect,
  onCreate,
}: {
  label: string;
  items: WorkItemRecord[];
  selectedKey: string | null;
  onSelect: (item: WorkItemRecord) => void;
  onCreate: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", padding: "4px 10px 3px 22px" }}>
        <span style={{ flex: 1, color: "var(--text-dim)", fontSize: 10 }}>{label}</span>
        <button
          onClick={onCreate}
          aria-label={`新建${label}`}
          style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
        >
          +
        </button>
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          style={rowStyle(item.key === selectedKey)}
          onClick={() => onSelect(item)}
        >
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 9 }}>
            {item.key}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.title}
          </span>
        </button>
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
          fontSize: 9,
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
              minHeight: 30,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 10,
            }}
          >
            {label as string}
          </button>
        ))}
      </div>
    </div>
  );
}
