"use client";

import { useEffect, useState } from "react";
import type { WorkItemRecord, WorkItemType } from "@/lib/work-items/types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";

interface Props {
  workspace: WorkspaceSummary;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenWorkItems: () => void;
  onCreateWorkItem: (type: WorkItemType) => void;
}

export function WorkspaceOverview({
  workspace,
  onNewSession,
  onOpenSettings,
  onOpenWorkItems,
  onCreateWorkItem,
}: Props) {
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/work-items`, {
        signal: controller.signal,
      }),
      fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories`, {
        signal: controller.signal,
      }),
    ]).then(async ([itemsResponse, repositoriesResponse]) => {
      if (itemsResponse.ok) {
        const data = await itemsResponse.json() as { items?: WorkItemRecord[] };
        setWorkItems(data.items ?? []);
      }
      if (repositoriesResponse.ok) {
        const data = await repositoriesResponse.json() as {
          repositories?: WorkspaceRepositoryState[];
        };
        setRepositories(data.repositories ?? []);
      }
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("Failed to load workspace overview:", error);
      }
    });
    return () => controller.abort();
  }, [workspace.id]);

  const openItems = workItems.filter((item) =>
    item.status !== "done" && item.status !== "cancelled"
  );
  const activeRepositories = repositories.filter((repository) => repository.status === "active");

  return (
    <main
      aria-label={`${workspace.name} overview`}
      style={{ height: "100%", overflow: "auto", padding: "clamp(20px, 4vw, 48px)" }}
    >
      <div style={{ width: "min(920px, 100%)", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>WORKSPACE</div>
            <h1 style={{ margin: "6px 0 5px", fontSize: 28, color: "var(--text)" }}>
              {workspace.name}
            </h1>
            <code style={{ color: "var(--text-muted)", fontSize: 11 }}>{workspace.path}</code>
          </div>
          <button className="workspace-action" onClick={onOpenSettings}>工作区设置</button>
          <button className="workspace-action" onClick={onNewSession}>新建会话</button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 12,
            marginTop: 28,
          }}
        >
          <OverviewCard
            label="待处理工作项"
            value={String(openItems.length)}
            detail={`${workItems.filter((item) => item.type === "requirement").length} 个需求 · ${workItems.filter((item) => item.type === "bug").length} 个 Bug`}
            onClick={onOpenWorkItems}
          />
          <OverviewCard
            label="Repositories"
            value={String(activeRepositories.length)}
            detail={`${activeRepositories.filter((repository) => repository.kind === "code").length} code · ${activeRepositories.filter((repository) => repository.kind === "knowledge").length} knowledge`}
            onClick={onOpenSettings}
          />
          <OverviewCard
            label="Skills"
            value={String(workspace.skills.length)}
            detail={workspace.skills.length > 0 ? workspace.skills.join(" · ") : "尚未选择工作区技能"}
            onClick={onOpenSettings}
          />
        </div>

        <section style={{ marginTop: 30 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ flex: 1, margin: 0, fontSize: 15, color: "var(--text)" }}>快速创建</h2>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="workspace-action" onClick={() => onCreateWorkItem("requirement")}>
              + 需求
            </button>
            <button className="workspace-action" onClick={() => onCreateWorkItem("bug")}>
              + Bug
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function OverviewCard({
  label,
  value,
  detail,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        minHeight: 132,
        padding: 16,
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg-panel)",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>{label}</span>
      <strong style={{ display: "block", margin: "8px 0", fontSize: 30 }}>{value}</strong>
      <span
        style={{
          display: "block",
          overflow: "hidden",
          color: "var(--text-dim)",
          fontSize: 10,
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {detail}
      </span>
    </button>
  );
}
