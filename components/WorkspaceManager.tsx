"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { ImporterConfig } from "./ImporterConfig";
import { LoopConfig } from "./LoopConfig";
import type {
  WorkspaceCapability,
  WorkspaceRepositoryState,
  WorkspaceRepositoryKind,
  WorkspaceSummary,
} from "@/lib/workspaces/types";
import { INIT_CAPABILITY_CHECKLIST, MANDATORY_CAPABILITIES } from "@/lib/workspaces/templates";
import type {
  WorkItemDetail,
  WorkItemPhase,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemStatus,
  WorkItemType,
} from "@/lib/work-items/types";
import type { SkillInfo } from "@/lib/api-types";

interface WorkspaceListResponse {
  root: string;
  workspaces: WorkspaceSummary[];
}

interface WorkItemListResponse {
  items: WorkItemRecord[];
  invalid: Array<{ key: string; path: string; error: string }>;
}

interface RepositoryListResponse {
  repositories: WorkspaceRepositoryState[];
}

type ManagerSection = "workspaces" | "work-items";
type WorkItemFilter = "all" | WorkItemType;

interface Props {
  open: boolean;
  embedded?: boolean;
  initialSection?: ManagerSection;
  activeWorkspacePath?: string | null;
  initialWorkItemKey?: string | null;
  createWorkItemRequest?: { type: WorkItemType; id: number } | null;
  createWorkspaceOnOpen?: boolean;
  openRepositoryFormRequest?: number;
  onClose: () => void;
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
  onOpenWorkItemConversation: (workspace: WorkspaceSummary, item: WorkItemRecord) => void;
  onWorkspaceDeleted?: (workspace: WorkspaceSummary) => void;
  onWorkItemsChanged?: () => void;
  onWorkspaceChanged?: () => void;
  onOpenLoops?: () => void;
}

const STATUS_OPTIONS: WorkItemStatus[] = ["open", "in_progress", "blocked", "done", "cancelled"];
const PHASE_OPTIONS: WorkItemPhase[] = [
  "intake",
  "analysis",
  "requirement_approval",
  "design",
  "plan_approval",
  "implementation",
  "verification",
  "complete",
];
const PRIORITY_OPTIONS: WorkItemPriority[] = ["P0", "P1", "P2", "P3"];

const CAPABILITY_LABELS: Record<string, string> = {
  sessions: "会话",
  explorer: "Explorer",
  repositories: "代码仓库",
  knowledge: "知识库",
  loop: "Loop",
  "work-items": "工作项",
};

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  blocked: "已阻塞",
  done: "已完成",
  cancelled: "已取消",
};

const PHASE_LABELS: Record<WorkItemPhase, string> = {
  intake: "收集",
  analysis: "分析",
  requirement_approval: "需求确认",
  design: "设计",
  plan_approval: "计划确认",
  implementation: "实现",
  verification: "验证",
  complete: "完成",
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function SelectField<T extends string>({
  label,
  value,
  options,
  labels,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels?: Partial<Record<T, string>>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <label className="workspace-field workspace-field-compact">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>{labels?.[option] ?? option}</option>
        ))}
      </select>
    </label>
  );
}

export function WorkspaceManager({
  open,
  embedded = false,
  initialSection = "workspaces",
  activeWorkspacePath,
  initialWorkItemKey,
  createWorkItemRequest,
  createWorkspaceOnOpen = false,
  openRepositoryFormRequest,
  onClose,
  onOpenWorkspace,
  onOpenWorkItemConversation,
  onWorkspaceDeleted,
  onWorkItemsChanged,
  onWorkspaceChanged,
  onOpenLoops,
}: Props) {
  const [section, setSection] = useState<ManagerSection>(initialSection);
  const [workspaceData, setWorkspaceData] = useState<WorkspaceListResponse | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workItemData, setWorkItemData] = useState<WorkItemListResponse>({ items: [], invalid: [] });
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [selectedWorkItem, setSelectedWorkItem] = useState<WorkItemDetail | null>(null);
  const [filter, setFilter] = useState<WorkItemFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<WorkspaceCapability[]>(["repositories", "work-items"]);
  const [repositoryFormOpen, setRepositoryFormOpen] = useState(false);
  const [repositoryMode, setRepositoryMode] = useState<"clone" | "init">("clone");
  const [repositoryKind, setRepositoryKind] = useState<WorkspaceRepositoryKind>("code");
  const [repositoryAlias, setRepositoryAlias] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryRemote, setRepositoryRemote] = useState("");
  const [skillSelectionOpen, setSkillSelectionOpen] = useState(false);
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [createWorkItemOpen, setCreateWorkItemOpen] = useState(false);
  const [workItemType, setWorkItemType] = useState<WorkItemType>("bug");
  const [workItemTitle, setWorkItemTitle] = useState("");
  const [workItemDescription, setWorkItemDescription] = useState("");
  const [workItemPriority, setWorkItemPriority] = useState<WorkItemPriority>("P2");
  const [workItemRepositories, setWorkItemRepositories] = useState<string[]>([]);
  const [contentDraft, setContentDraft] = useState("");
  const [contentEditing, setContentEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedWorkspace = workspaceData?.workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  ) ?? null;

  const openCreateWorkItem = useCallback((type?: WorkItemType) => {
    if (type) setWorkItemType(type);
    setWorkItemRepositories(
      selectedWorkspace?.repositories
        .filter((repository) => repository.status === "active" && repository.kind === "code")
        .map((repository) => repository.id) ?? [],
    );
    setCreateWorkItemOpen(true);
  }, [selectedWorkspace]);

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await responseJson<WorkspaceListResponse>(await fetch("/api/workspaces"));
      setWorkspaceData(data);
      setSelectedWorkspaceId((current) => {
        if (current && data.workspaces.some((workspace) => workspace.id === current)) return current;
        const active = data.workspaces.find((workspace) => workspace.path === activeWorkspacePath);
        return active?.id ?? data.workspaces[0]?.id ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [activeWorkspacePath]);

  const loadWorkItems = useCallback(async (workspaceId: string) => {
    setItemsLoading(true);
    setError(null);
    try {
      const data = await responseJson<WorkItemListResponse>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-items`),
      );
      setWorkItemData(data);
      setSelectedWorkItem((current) => (
        current && data.items.some((item) => item.key === current.item.key) ? current : null
      ));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const loadRepositories = useCallback(async (workspaceId: string) => {
    try {
      const data = await responseJson<RepositoryListResponse>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/repositories`),
      );
      setRepositories(data.repositories);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const loadWorkItem = useCallback(async (workspaceId: string, key: string) => {
    setItemsLoading(true);
    setError(null);
    try {
      const detail = await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(key)}`,
        ),
      );
      setSelectedWorkItem(detail);
      setContentDraft(detail.content);
      setContentEditing(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setItemsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open && !embedded) return;
    setSection(initialSection);
    void loadWorkspaces();
  }, [embedded, initialSection, loadWorkspaces, open]);

  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspaceId) {
      setWorkItemData({ items: [], invalid: [] });
      setRepositories([]);
      return;
    }
    if (selectedWorkspace?.capabilities.includes("work-items")) {
      void loadWorkItems(selectedWorkspaceId);
    } else {
      setWorkItemData({ items: [], invalid: [] });
    }
    if (selectedWorkspace?.capabilities.includes("repositories")) {
      void loadRepositories(selectedWorkspaceId);
    } else {
      setRepositories([]);
    }
  }, [
    embedded,
    loadRepositories,
    loadWorkItems,
    open,
    selectedWorkspace,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    setShowArchived(false);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspace) {
      setAvailableSkills([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/skills?cwd=${encodeURIComponent(selectedWorkspace.path)}`)
      .then(async (response) => {
        if (!response.ok) return { skills: [] as SkillInfo[] };
        return response.json() as Promise<{ skills?: SkillInfo[] }>;
      })
      .then((data) => {
        if (!cancelled) setAvailableSkills(data.skills ?? []);
      })
      .catch(() => {
        if (!cancelled) setAvailableSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [embedded, open, selectedWorkspace]);

  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspaceId || !initialWorkItemKey) return;
    setSection("work-items");
    void loadWorkItem(selectedWorkspaceId, initialWorkItemKey);
  }, [embedded, initialWorkItemKey, loadWorkItem, open, selectedWorkspaceId]);

  useEffect(() => {
    if ((!open && !embedded) || !createWorkItemRequest) return;
    setSection("work-items");
    openCreateWorkItem(createWorkItemRequest.type);
  }, [createWorkItemRequest, embedded, open, openCreateWorkItem]);

  useEffect(() => {
    if ((!open && !embedded) || !createWorkspaceOnOpen) return;
    setSection("workspaces");
    setCreateWorkspaceOpen(true);
  }, [createWorkspaceOnOpen, embedded, open]);

  useEffect(() => {
    if ((!open && !embedded) || openRepositoryFormRequest === undefined) return;
    setSection("workspaces");
    setRepositoryFormOpen(true);
  }, [embedded, open, openRepositoryFormRequest]);

  const visibleWorkItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return workItemData.items.filter((item) => {
      if (showArchived !== Boolean(item.archivedAt)) return false;
      if (filter !== "all" && item.type !== filter) return false;
      if (!normalizedQuery) return true;
      return item.key.toLowerCase().includes(normalizedQuery)
        || item.title.toLowerCase().includes(normalizedQuery)
        || item.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));
    });
  }, [filter, query, showArchived, workItemData.items]);

  const createWorkspace = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await responseJson<{ workspace: WorkspaceSummary }>(
        await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: workspaceName,
            slug: slugify(workspaceName),
            capabilities: selectedCapabilities,
          }),
        }),
      );
      setCreateWorkspaceOpen(false);
      setWorkspaceName("");
      await loadWorkspaces();
      setSelectedWorkspaceId(data.workspace.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkspaces, workspaceName, selectedCapabilities]);

  const removeWorkspace = useCallback(async (workspace: WorkspaceSummary) => {
    if (!window.confirm(`从列表移除 ${workspace.name}？目录和 Workspace 配置不会被删除。`)) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" }),
      );
      setSelectedWorkItem(null);
      await loadWorkspaces();
      onWorkspaceDeleted?.(workspace);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkspaces, onWorkspaceDeleted]);

  const addRepository = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/repositories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            alias: repositoryAlias,
            name: repositoryName || repositoryAlias,
            kind: repositoryKind,
            mode: repositoryMode,
            ...(repositoryRemote.trim() ? { remote: repositoryRemote.trim() } : {}),
          }),
        }),
      );
      setRepositoryFormOpen(false);
      setRepositoryAlias("");
      setRepositoryName("");
      setRepositoryRemote("");
      await Promise.all([loadRepositories(selectedWorkspaceId), loadWorkspaces()]);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setSaving(false);
    }
  }, [
    loadRepositories,
    loadWorkspaces,
    repositoryAlias,
    repositoryKind,
    repositoryMode,
    repositoryName,
    repositoryRemote,
    selectedWorkspaceId,
  ]);

  const removeRepository = useCallback(async (repository: WorkspaceRepositoryState) => {
    if (!selectedWorkspaceId) return;
    if (!window.confirm(`停用 ${repository.alias}？仓库文件会保留在原目录。`)) return;
    setSaving(true);
    setError(null);
    try {
      const search = new URLSearchParams({ repositoryId: repository.id });
      await responseJson(
        await fetch(
          `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/repositories?${search}`,
          { method: "DELETE" },
        ),
      );
      await Promise.all([loadRepositories(selectedWorkspaceId), loadWorkspaces()]);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSaving(false);
    }
  }, [loadRepositories, loadWorkspaces, selectedWorkspaceId]);

  const restoreRepository = useCallback(async (repository: WorkspaceRepositoryState) => {
    if (!selectedWorkspaceId) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/repositories`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repositoryId: repository.id, action: "restore" }),
        }),
      );
      await Promise.all([loadRepositories(selectedWorkspaceId), loadWorkspaces()]);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : String(restoreError));
    } finally {
      setSaving(false);
    }
  }, [loadRepositories, loadWorkspaces, selectedWorkspaceId]);

  const saveSkillSelection = useCallback(async () => {
    if (!selectedWorkspace) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspace.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: selectedWorkspace.updatedAt,
            skills: skillDraft,
          }),
        }),
      );
      setSkillSelectionOpen(false);
      await loadWorkspaces();
    } catch (saveSkillsError) {
      setError(saveSkillsError instanceof Error ? saveSkillsError.message : String(saveSkillsError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkspaces, selectedWorkspace, skillDraft]);

  const createWorkItem = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const detail = await responseJson<WorkItemDetail>(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/work-items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: workItemType,
            title: workItemTitle,
            originalDescription: workItemDescription,
            priority: workItemPriority,
            repositories: workItemRepositories,
          }),
        }),
      );
      setCreateWorkItemOpen(false);
      setWorkItemTitle("");
      setWorkItemDescription("");
      setWorkItemRepositories([]);
      setSelectedWorkItem(detail);
      setContentDraft(detail.content);
      await loadWorkItems(selectedWorkspaceId);
      onWorkItemsChanged?.();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }, [
    loadWorkItems,
    selectedWorkspaceId,
    workItemDescription,
    workItemPriority,
    workItemRepositories,
    workItemTitle,
    workItemType,
    onWorkItemsChanged,
  ]);

  const patchWorkItem = useCallback(async (
    patch: Partial<Pick<WorkItemRecord, "status" | "phase" | "priority" | "title" | "repositories">>
      & { archived?: boolean },
  ) => {
    if (!selectedWorkspaceId || !selectedWorkItem) return;
    setSaving(true);
    setError(null);
    try {
      const detail = await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/work-items/${encodeURIComponent(selectedWorkItem.item.key)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRevision: selectedWorkItem.item.revision,
              ...patch,
            }),
          },
        ),
      );
      setSelectedWorkItem(detail);
      setContentDraft(detail.content);
      await loadWorkItems(selectedWorkspaceId);
      onWorkItemsChanged?.();
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkItems, onWorkItemsChanged, selectedWorkItem, selectedWorkspaceId]);

  const toggleWorkItemArchive = useCallback(async () => {
    if (!selectedWorkItem) return;
    const archived = Boolean(selectedWorkItem.item.archivedAt);
    if (!archived && !window.confirm(`归档 ${selectedWorkItem.item.key}？归档后默认列表将不再显示。`)) {
      return;
    }
    await patchWorkItem({ archived: !archived });
  }, [patchWorkItem, selectedWorkItem]);

  const saveContent = useCallback(async () => {
    if (!selectedWorkspaceId || !selectedWorkItem) return;
    setSaving(true);
    setError(null);
    try {
      const detail = await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/work-items/${encodeURIComponent(selectedWorkItem.item.key)}/content`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRevision: selectedWorkItem.item.revision,
              content: contentDraft,
            }),
          },
        ),
      );
      setSelectedWorkItem(detail);
      setContentDraft(detail.content);
      setContentEditing(false);
      await loadWorkItems(selectedWorkspaceId);
      onWorkItemsChanged?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [contentDraft, loadWorkItems, onWorkItemsChanged, selectedWorkItem, selectedWorkspaceId]);

  const trashWorkItem = useCallback(async () => {
    if (!selectedWorkspaceId || !selectedWorkItem) return;
    if (!window.confirm(`将 ${selectedWorkItem.item.key} 移到 Workspace 回收站？`)) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson(
        await fetch(
          `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/work-items/${encodeURIComponent(selectedWorkItem.item.key)}`,
          { method: "DELETE" },
        ),
      );
      setSelectedWorkItem(null);
      await loadWorkItems(selectedWorkspaceId);
      onWorkItemsChanged?.();
    } catch (trashError) {
      setError(trashError instanceof Error ? trashError.message : String(trashError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkItems, onWorkItemsChanged, selectedWorkItem, selectedWorkspaceId]);

  if (!open && !embedded) return null;

  return (
    <div
      className={embedded ? "workspace-manager-page" : "workspace-manager-backdrop"}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-label="Pi Workspace"
    >
      <style>{`
        .workspace-manager-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1000;
          background: rgba(0, 0, 0, 0.48);
          display: grid;
          place-items: center;
          padding: 24px;
        }
        .workspace-manager-page {
          width: 100%;
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }
        .workspace-manager-page .workspace-manager {
          width: 100%;
          height: 100%;
          min-height: 0;
          border: 0;
          border-radius: 0;
          box-shadow: none;
        }
        .workspace-manager {
          width: min(1180px, 100%);
          height: min(780px, 100%);
          min-height: 520px;
          display: grid;
          grid-template-rows: auto 1fr;
          overflow: hidden;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: var(--bg);
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
        }
        .workspace-manager-header {
          min-height: 54px;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 14px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-panel);
        }
        .workspace-manager-title { font-weight: 750; font-size: 15px; }
        .workspace-manager-tabs { display: flex; gap: 4px; margin-left: 12px; }
        .workspace-manager-tab, .workspace-action, .workspace-icon-button {
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-muted);
          cursor: pointer;
          min-height: 32px;
          padding: 0 11px;
          font: inherit;
          font-size: 12px;
        }
        .workspace-manager-tab[data-active="true"] {
          color: var(--accent);
          border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
          background: color-mix(in srgb, var(--accent) 8%, var(--bg));
        }
        .workspace-icon-button { margin-left: auto; width: 34px; padding: 0; font-size: 18px; }
        .workspace-manager-body {
          min-height: 0;
          display: grid;
          grid-template-columns: 280px minmax(0, 1fr);
        }
        .workspace-rail {
          min-height: 0;
          overflow: auto;
          border-right: 1px solid var(--border);
          background: var(--bg-panel);
          padding: 10px;
        }
        .workspace-rail-item {
          width: 100%;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 3px;
          margin-bottom: 6px;
          padding: 10px;
          border: 1px solid transparent;
          border-radius: 9px;
          background: transparent;
          color: var(--text);
          text-align: left;
          cursor: pointer;
        }
        .workspace-rail-item[data-active="true"] {
          background: var(--bg);
          border-color: var(--border);
          box-shadow: 0 1px 2px rgba(0,0,0,.04);
        }
        .workspace-rail-meta { color: var(--text-dim); font-size: 10px; font-family: var(--font-mono); }
        .workspace-content { min-width: 0; min-height: 0; overflow: auto; padding: 18px; }
        .workspace-page-header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
        .workspace-page-header h2 { margin: 0; font-size: 20px; }
        .workspace-page-header .workspace-action:first-of-type { margin-left: auto; }
        .workspace-summary-card, .work-item-detail-card, .workspace-form-card {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--bg-panel);
          padding: 16px;
        }
        .repository-section { margin-top: 16px; }
        .workspace-settings-section { margin-top: 16px; }
        .skill-selection-list {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          max-height: 220px;
          overflow: auto;
          margin-top: 10px;
        }
        .skill-selection-item {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          border: 1px solid var(--border);
          border-radius: 7px;
          padding: 8px;
          background: var(--bg);
          color: var(--text);
          font-size: 11px;
        }
        .skill-selection-item input { margin-top: 2px; }
        .skill-selection-item span { min-width: 0; }
        .capability-checklist {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          margin-top: 6px;
        }
        .capability-check-item {
          display: flex;
          align-items: center;
          gap: 7px;
          border: 1px solid var(--border);
          border-radius: 7px;
          padding: 8px 10px;
          background: var(--bg);
          color: var(--text);
          font-size: 12px;
        }
        .capability-check-item input { margin: 0; }
        .skill-selection-item small {
          display: block;
          margin-top: 2px;
          color: var(--text-dim);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .repository-section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }
        .repository-section-header h3 { margin: 0; font-size: 14px; }
        .repository-list { display: grid; gap: 7px; }
        .repository-row {
          display: grid;
          grid-template-columns: minmax(120px, .8fr) minmax(160px, 1.2fr) auto auto;
          align-items: center;
          gap: 9px;
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 9px 10px;
          background: var(--bg);
          font-size: 11px;
        }
        .repository-row code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .repository-actions { display: flex; gap: 5px; }
        .repository-state {
          display: inline-flex;
          gap: 5px;
          align-items: center;
          color: var(--text-dim);
          white-space: nowrap;
        }
        .workspace-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .workspace-field { display: flex; flex-direction: column; gap: 6px; color: var(--text-muted); font-size: 11px; }
        .workspace-field input, .workspace-field textarea, .workspace-field select, .workspace-search {
          width: 100%;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text);
          padding: 8px 10px;
          font: inherit;
          font-size: 13px;
          outline: none;
        }
        .workspace-field textarea { min-height: 120px; resize: vertical; }
        .workspace-field-compact select { min-width: 118px; }
        .workspace-error {
          margin: 0 0 12px;
          border: 1px solid color-mix(in srgb, #ef4444 40%, var(--border));
          border-radius: 8px;
          background: color-mix(in srgb, #ef4444 7%, var(--bg));
          color: #dc2626;
          padding: 9px 11px;
          font-size: 12px;
        }
        .work-item-toolbar { display: flex; align-items: center; gap: 7px; margin-bottom: 12px; }
        .work-item-filter { display: flex; gap: 4px; }
        .workspace-search { max-width: 260px; margin-left: auto; }
        .work-item-list { display: grid; gap: 7px; }
        .work-item-row {
          display: grid;
          grid-template-columns: 88px minmax(0, 1fr) 88px 100px 70px;
          align-items: center;
          gap: 10px;
          width: 100%;
          border: 1px solid var(--border);
          border-radius: 9px;
          background: var(--bg);
          color: var(--text);
          padding: 10px 12px;
          text-align: left;
          cursor: pointer;
        }
        .work-item-key { color: var(--accent); font-family: var(--font-mono); font-size: 11px; }
        .work-item-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .work-item-badge {
          display: inline-flex;
          justify-content: center;
          border-radius: 999px;
          background: var(--bg-panel);
          color: var(--text-muted);
          padding: 3px 7px;
          font-size: 10px;
        }
        .work-item-detail-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; }
        .work-item-detail-header h2 { margin: 2px 0 0; font-size: 20px; }
        .work-item-fields { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
        .work-item-content {
          border: 1px solid var(--border);
          border-radius: 9px;
          background: var(--bg);
          padding: 14px;
          min-height: 180px;
        }
        .work-item-editor {
          width: 100%;
          min-height: 330px;
          resize: vertical;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg);
          color: var(--text);
          padding: 12px;
          font: 12px/1.6 var(--font-mono);
        }
        .work-item-events { margin-top: 16px; }
        .work-item-events-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .work-item-repositories {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 14px;
        }
        .work-item-repository {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 5px 9px;
          background: var(--bg);
          color: var(--text-muted);
          font-size: 11px;
        }
        .work-item-event { display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
        .work-item-event time { color: var(--text-dim); }
        @media (max-width: 640px) {
          .workspace-manager-backdrop { padding: 0; background: var(--bg); }
          .workspace-manager { width: 100%; height: 100dvh; min-height: 0; border: 0; border-radius: 0; }
          .workspace-manager-header { padding: 7px 10px; }
          .workspace-manager-title { display: none; }
          .workspace-manager-tabs { margin-left: 0; flex: 1; }
          .workspace-manager-tab { flex: 1; }
          .workspace-manager-body { display: block; overflow: auto; }
          .workspace-rail { display: ${section === "workspaces" ? "block" : "none"}; height: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 10px; }
          .workspace-content { display: block; height: auto; min-height: 100%; padding: 12px; }
          .workspace-form-grid { grid-template-columns: 1fr; }
          .repository-row { grid-template-columns: minmax(0, 1fr) auto; }
          .skill-selection-list { grid-template-columns: 1fr; }
          .capability-checklist { grid-template-columns: 1fr; }
          .repository-row > code { grid-column: 1 / -1; grid-row: 2; }
          .repository-actions { grid-column: 1 / -1; grid-row: 3; }
          .workspace-page-header h2 { font-size: 17px; }
          .workspace-page-header { flex-wrap: wrap; }
          .work-item-toolbar { flex-wrap: wrap; }
          .workspace-search { max-width: none; order: 3; margin-left: 0; }
          .work-item-row {
            grid-template-columns: auto 1fr auto;
            gap: 7px;
          }
          .work-item-row .work-item-badge:nth-of-type(2) { display: none; }
          .work-item-row time { grid-column: 2; color: var(--text-dim); font-size: 10px; }
          .work-item-fields { display: grid; grid-template-columns: 1fr 1fr; }
          .workspace-field-compact select { min-width: 0; }
          .work-item-event { grid-template-columns: 92px 1fr; }
          .work-item-detail-header {
            display: grid;
            grid-template-columns: auto 1fr auto auto;
            align-items: start;
          }
          .work-item-detail-header > div {
            grid-column: 1 / -1;
            grid-row: 2;
            margin-top: 4px;
          }
          .work-item-detail-header > .workspace-action {
            white-space: nowrap;
          }
          .work-item-detail-header > .workspace-action:nth-of-type(2) {
            grid-column: 3;
            margin-left: 0 !important;
          }
          .work-item-detail-header > .workspace-action:nth-of-type(3) {
            grid-column: 4;
          }
        }
      `}</style>
      <div className="workspace-manager">
        <header className="workspace-manager-header">
          <div className="workspace-manager-title">Pi Workspace</div>
          <nav className="workspace-manager-tabs" aria-label="Workspace views">
            <button
              className="workspace-manager-tab"
              data-active={section === "workspaces"}
              onClick={() => setSection("workspaces")}
            >
              Workspaces
            </button>
            {selectedWorkspace?.capabilities.includes("work-items") && (
              <button
                className="workspace-manager-tab"
                data-active={section === "work-items"}
                onClick={() => setSection("work-items")}
              >
                工作项
              </button>
            )}
          </nav>
          {!embedded && (
            <button className="workspace-icon-button" onClick={onClose} aria-label="Close">×</button>
          )}
        </header>

        <div className="workspace-manager-body">
          <aside className="workspace-rail">
            <div className="workspace-page-header">
              <strong>Workspaces</strong>
              <button className="workspace-action" onClick={() => setCreateWorkspaceOpen(true)}>新建</button>
            </div>
            {loading && <div className="workspace-rail-meta">Loading…</div>}
            {workspaceData?.workspaces.map((workspace) => (
              <button
                key={workspace.id}
                disabled={!workspace.available}
                className="workspace-rail-item"
                data-active={workspace.id === selectedWorkspaceId}
                onClick={() => {
                  setSelectedWorkspaceId(workspace.id);
                  setSelectedWorkItem(null);
                }}
              >
                <strong>{workspace.name}</strong>
                <span className="workspace-rail-meta">{workspace.path}</span>
                <span className="workspace-rail-meta">
                  {workspace.available
                    ? `${workspace.capabilities.length} capabilities · ${workspace.repositoryCount} repos`
                    : "目录或配置不可用"}
                </span>
              </button>
            ))}
            {!loading && workspaceData?.workspaces.length === 0 && (
              <div className="workspace-rail-meta">尚未创建 Workspace。</div>
            )}
          </aside>

          <main className="workspace-content">
            {error && <div className="workspace-error">{error}</div>}

            {section === "workspaces" && (
              <>
                <div className="workspace-page-header">
                  <h2>{selectedWorkspace?.name ?? "Workspaces"}</h2>
                  {selectedWorkspace && (
                    <>
                      <button className="workspace-action" onClick={() => onOpenWorkspace(selectedWorkspace)}>
                        进入 Workspace
                      </button>
                      <button
                        className="workspace-action"
                        disabled={saving}
                        onClick={() => void removeWorkspace(selectedWorkspace)}
                      >
                        从列表移除
                      </button>
                    </>
                  )}
                </div>

                {createWorkspaceOpen ? (
                  <div className="workspace-form-card">
                    <div className="workspace-form-grid">
                      <label className="workspace-field">
                        <span>名称</span>
                        <input
                          value={workspaceName}
                          onChange={(event) => setWorkspaceName(event.target.value)}
                          placeholder="Ecommerce"
                          autoFocus
                        />
                      </label>
                    </div>
                    <div className="workspace-field">
                      <span>能力（Capability）</span>
                      <div className="capability-checklist">
                        {MANDATORY_CAPABILITIES.map((capability) => (
                          <label className="capability-check-item" key={capability}>
                            <input type="checkbox" checked disabled readOnly />
                            {CAPABILITY_LABELS[capability]}（必带）
                          </label>
                        ))}
                        {INIT_CAPABILITY_CHECKLIST.map((capability) => (
                          <label className="capability-check-item" key={capability}>
                            <input
                              type="checkbox"
                              checked={selectedCapabilities.includes(capability)}
                              onChange={(event) => {
                                setSelectedCapabilities((current) => event.target.checked
                                  ? [...new Set([...current, capability])]
                                  : current.filter((value) => value !== capability));
                              }}
                            />
                            {CAPABILITY_LABELS[capability]}
                          </label>
                        ))}
                      </div>
                      <p className="workspace-rail-meta" style={{ marginTop: 6 }}>
                        会话与 Explorer 始终开启；勾选其它能力后，相应目录会在首次使用时自动创建。
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button className="workspace-action" onClick={() => setCreateWorkspaceOpen(false)}>取消</button>
                      <button
                        className="workspace-action"
                        disabled={saving || !slugify(workspaceName)}
                        onClick={() => void createWorkspace()}
                      >
                        {saving ? "创建中…" : "创建 Workspace"}
                      </button>
                    </div>
                  </div>
                ) : selectedWorkspace ? (
                  <>
                    <div className="workspace-summary-card">
                      <div className="workspace-form-grid">
                        <div>
                          <div className="workspace-rail-meta">路径</div>
                          <code>{selectedWorkspace.path}</code>
                        </div>
                        <div>
                          <div className="workspace-rail-meta">能力</div>
                          <div>{selectedWorkspace.capabilities.join(", ")}</div>
                        </div>
                        <div>
                          <div className="workspace-rail-meta">Skills</div>
                          <div>{selectedWorkspace.skills.join(", ") || "未选择"}</div>
                        </div>
                        <div>
                          <div className="workspace-rail-meta">最近更新</div>
                          <div>{formatDate(selectedWorkspace.updatedAt)}</div>
                        </div>
                      </div>
                    </div>
                    <section className="workspace-settings-section">
                      <div className="repository-section-header">
                        <h3>Pi Skills</h3>
                        <button
                          className="workspace-action"
                          onClick={() => {
                            setSkillDraft(selectedWorkspace.skills);
                            setSkillSelectionOpen((value) => !value);
                          }}
                        >
                          {skillSelectionOpen ? "收起" : "选择"}
                        </button>
                      </div>
                      <div className="workspace-summary-card">
                        <div>
                          {selectedWorkspace.skills.length > 0
                            ? selectedWorkspace.skills.join(", ")
                            : "遵循 Pi 默认：使用 ResourceLoader 发现的全部 skills"}
                        </div>
                        <div className="workspace-rail-meta" style={{ marginTop: 6 }}>
                          安装、更新和删除仍由 Pi 原生 Skills / Packages 管理；这里只选择新会话可用的 skills。
                        </div>
                        {skillSelectionOpen && (
                          <>
                            <div className="skill-selection-list">
                              {availableSkills.map((skill) => (
                                <label className="skill-selection-item" key={skill.filePath}>
                                  <input
                                    type="checkbox"
                                    checked={skillDraft.includes(skill.name)}
                                    onChange={(event) => {
                                      setSkillDraft((current) => event.target.checked
                                        ? [...new Set([...current, skill.name])]
                                        : current.filter((name) => name !== skill.name));
                                    }}
                                  />
                                  <span>
                                    <strong>{skill.name}</strong>
                                    <small title={skill.description}>{skill.description}</small>
                                  </span>
                                </label>
                              ))}
                            </div>
                            {availableSkills.length === 0 && (
                              <div className="workspace-rail-meta" style={{ marginTop: 8 }}>
                                Pi 尚未发现可用 skill。可先在侧边栏的“技能”中安装。
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
                              <button
                                className="workspace-action"
                                onClick={() => setSkillDraft([])}
                              >
                                使用 Pi 默认
                              </button>
                              <button
                                className="workspace-action"
                                disabled={saving}
                                onClick={() => void saveSkillSelection()}
                              >
                                {saving ? "保存中…" : "保存选择"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </section>
                    <ImporterConfig
                      workspace={selectedWorkspace}
                      onWorkspaceChanged={() => void loadWorkspaces()}
                    />
                    <LoopConfig
                      workspace={selectedWorkspace}
                      mode="settings"
                      onOpenLoops={onOpenLoops}
                      onWorkspaceChanged={() => {
                        void loadWorkspaces();
                        onWorkspaceChanged?.();
                      }}
                    />
                    {selectedWorkspace.capabilities.includes("repositories") && (
                    <section className="repository-section">
                      <div className="repository-section-header">
                        <h3>Git 仓库</h3>
                        <button
                          className="workspace-action"
                          onClick={() => setRepositoryFormOpen((value) => !value)}
                        >
                          {repositoryFormOpen ? "收起" : "添加仓库"}
                        </button>
                      </div>
                      {repositoryFormOpen && (
                        <div className="workspace-form-card" style={{ marginBottom: 9 }}>
                          <div className="workspace-form-grid">
                            <label className="workspace-field">
                              <span>方式</span>
                              <select
                                value={repositoryMode}
                                onChange={(event) => setRepositoryMode(event.target.value as "clone" | "init")}
                              >
                                <option value="clone">Clone 远程仓库</option>
                                <option value="init">新建空仓库</option>
                              </select>
                            </label>
                            <label className="workspace-field">
                              <span>类型</span>
                              <select
                                value={repositoryKind}
                                onChange={(event) => setRepositoryKind(event.target.value as WorkspaceRepositoryKind)}
                              >
                                <option value="code">代码仓库</option>
                                <option value="knowledge">知识库</option>
                              </select>
                            </label>
                            <label className="workspace-field">
                              <span>别名</span>
                              <input
                                value={repositoryAlias}
                                onChange={(event) => setRepositoryAlias(slugify(event.target.value))}
                                placeholder="web"
                              />
                            </label>
                            <label className="workspace-field">
                              <span>名称（可选）</span>
                              <input
                                value={repositoryName}
                                onChange={(event) => setRepositoryName(event.target.value)}
                                placeholder={repositoryAlias || "Web"}
                              />
                            </label>
                            <label className="workspace-field" style={{ gridColumn: "1 / -1" }}>
                              <span>{repositoryMode === "clone" ? "Git URL" : "Origin URL（可选）"}</span>
                              <input
                                value={repositoryRemote}
                                onChange={(event) => setRepositoryRemote(event.target.value)}
                                placeholder="https://github.com/org/repo.git"
                              />
                            </label>
                          </div>
                          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                            <button
                              className="workspace-action"
                              disabled={
                                saving
                                || !repositoryAlias
                                || (repositoryMode === "clone" && !repositoryRemote.trim())
                              }
                              onClick={() => void addRepository()}
                            >
                              {saving ? "处理中…" : repositoryMode === "clone" ? "Clone 仓库" : "创建仓库"}
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="repository-list">
                        {repositories.map((repository) => (
                          <div className="repository-row" key={repository.id}>
                            <strong>{repository.name}</strong>
                            <code title={repository.path}>{repository.path}</code>
                            <span className="repository-state">
                              {repository.status === "removed"
                                ? `${repository.kind === "code" ? "代码" : "知识库"} · 已停用`
                                : repository.exists
                                ? `${repository.branch || "detached"}${repository.dirty ? " · 有修改" : " · 干净"}`
                                : "路径不可用"}
                            </span>
                            <span className="repository-actions">
                              {repository.status === "active" ? (
                                <button
                                  className="workspace-action"
                                  disabled={saving}
                                  onClick={() => void removeRepository(repository)}
                                >
                                  停用
                                </button>
                              ) : (
                                <button
                                  className="workspace-action"
                                  disabled={saving}
                                  onClick={() => void restoreRepository(repository)}
                                >
                                  恢复
                                </button>
                              )}
                            </span>
                          </div>
                        ))}
                        {repositories.length === 0 && (
                          <div className="workspace-summary-card">
                            尚未配置仓库。可以添加多个代码仓库和知识库。
                          </div>
                        )}
                      </div>
                    </section>
                    )}
                  </>
                ) : (
                  <div className="workspace-summary-card">
                    创建第一个 Workspace，从勾选能力开始（会话与 Explorer 始终必带）。
                  </div>
                )}
              </>
            )}

            {section === "work-items" && selectedWorkspace && (
              selectedWorkItem ? (
                <div className="work-item-detail-card">
                  <div className="work-item-detail-header">
                    <button className="workspace-action" onClick={() => setSelectedWorkItem(null)}>← 返回</button>
                    <div>
                      <div className="work-item-key">{selectedWorkItem.item.key}</div>
                      <h2>{selectedWorkItem.item.title}</h2>
                    </div>
                    <button
                      className="workspace-action"
                      style={{ marginLeft: "auto" }}
                      onClick={() => onOpenWorkItemConversation(selectedWorkspace, selectedWorkItem.item)}
                    >
                      {selectedWorkItem.item.conversations.length > 0 ? "继续会话" : "开始会话"}
                    </button>
                    <button
                      className="workspace-action"
                      onClick={() => setContentEditing((value) => !value)}
                    >
                      {contentEditing ? "预览" : "编辑正文"}
                    </button>
                    <button
                      className="workspace-action"
                      disabled={saving}
                      onClick={() => void toggleWorkItemArchive()}
                    >
                      {selectedWorkItem.item.archivedAt ? "取消归档" : "归档"}
                    </button>
                  </div>
                  <div className="work-item-fields">
                    <SelectField
                      label="状态"
                      value={selectedWorkItem.item.status}
                      options={STATUS_OPTIONS}
                      labels={STATUS_LABELS}
                      disabled={saving}
                      onChange={(status) => void patchWorkItem({ status })}
                    />
                    <SelectField
                      label="阶段"
                      value={selectedWorkItem.item.phase}
                      options={PHASE_OPTIONS}
                      labels={PHASE_LABELS}
                      disabled={saving}
                      onChange={(phase) => void patchWorkItem({ phase })}
                    />
                    <SelectField
                      label="优先级"
                      value={selectedWorkItem.item.priority}
                      options={PRIORITY_OPTIONS}
                      disabled={saving}
                      onChange={(priority) => void patchWorkItem({ priority })}
                    />
                    <div className="workspace-field workspace-field-compact">
                      <span>Revision</span>
                      <div style={{ padding: "9px 0", fontFamily: "var(--font-mono)" }}>
                        {selectedWorkItem.item.revision}
                      </div>
                    </div>
                  </div>
                  {selectedWorkspace.repositories.length > 0 && (
                    <div className="work-item-repositories" aria-label="Repository scope">
                      {selectedWorkspace.repositories.map((repository) => {
                        const checked = selectedWorkItem.item.repositories.includes(repository.id);
                        return (
                          <label className="work-item-repository" key={repository.id}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={saving || repository.status === "removed"}
                              onChange={(event) => {
                                const next = event.target.checked
                                  ? [...new Set([...selectedWorkItem.item.repositories, repository.id])]
                                  : selectedWorkItem.item.repositories.filter((id) => id !== repository.id);
                                void patchWorkItem({ repositories: next });
                              }}
                            />
                            {repository.name}{repository.status === "removed" ? "（已停用）" : ""}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {contentEditing ? (
                    <>
                      <textarea
                        className="work-item-editor"
                        value={contentDraft}
                        onChange={(event) => setContentDraft(event.target.value)}
                      />
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                        <button
                          className="workspace-action"
                          onClick={() => {
                            setContentDraft(selectedWorkItem.content);
                            setContentEditing(false);
                          }}
                        >
                          取消
                        </button>
                        <button className="workspace-action" disabled={saving} onClick={() => void saveContent()}>
                          {saving ? "保存中…" : "保存"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="work-item-content">
                      {/* cwd = work-item dir so relative image refs (e.g. importer-written
                          `attachments/chandao-<id>.png`) resolve to /api/files and actually render;
                          without it the browser 404s the relative src and images vanish. */}
                      <MarkdownBody cwd={selectedWorkItem.path}>{selectedWorkItem.content}</MarkdownBody>
                    </div>
                  )}
                  <section className="work-item-events">
                    <div className="work-item-events-header">
                      <h3>执行里程碑</h3>
                      <button
                        className="workspace-action"
                        disabled={saving}
                        onClick={() => void trashWorkItem()}
                      >
                        移到回收站
                      </button>
                    </div>
                    {selectedWorkItem.events.map((event) => (
                      <div className="work-item-event" key={event.id}>
                        <time>{formatDate(event.at)}</time>
                        <div>
                          <strong>{event.type}</strong>
                          <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>{event.actor}</span>
                          {typeof event.data?.summary === "string" && (
                            <div style={{ color: "var(--text-muted)", marginTop: 3 }}>
                              {event.data.summary}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              ) : (
                <>
                  <div className="workspace-page-header">
                    <h2>{selectedWorkspace.name} · 工作项</h2>
                    <button className="workspace-action" onClick={() => openCreateWorkItem()}>
                      + 新建工作项
                    </button>
                  </div>
                  {createWorkItemOpen && (
                    <div className="workspace-form-card" style={{ marginBottom: 14 }}>
                      <div className="workspace-form-grid">
                        <label className="workspace-field">
                          <span>类型</span>
                          <select
                            value={workItemType}
                            onChange={(event) => setWorkItemType(event.target.value as WorkItemType)}
                          >
                            <option value="requirement">需求</option>
                            <option value="bug">Bug</option>
                          </select>
                        </label>
                        <label className="workspace-field">
                          <span>优先级</span>
                          <select
                            value={workItemPriority}
                            onChange={(event) => setWorkItemPriority(event.target.value as WorkItemPriority)}
                          >
                            {PRIORITY_OPTIONS.map((priority) => (
                              <option key={priority} value={priority}>{priority}</option>
                            ))}
                          </select>
                        </label>
                        <label className="workspace-field" style={{ gridColumn: "1 / -1" }}>
                          <span>标题</span>
                          <input
                            value={workItemTitle}
                            onChange={(event) => setWorkItemTitle(event.target.value)}
                            placeholder="简短描述需要完成或修复的事情"
                            autoFocus
                          />
                        </label>
                        <label className="workspace-field" style={{ gridColumn: "1 / -1" }}>
                          <span>原始描述</span>
                          <textarea
                            value={workItemDescription}
                            onChange={(event) => setWorkItemDescription(event.target.value)}
                            placeholder="保留你最初的描述，Agent 后续分析不会覆盖它。"
                          />
                        </label>
                        {selectedWorkspace.repositories.length > 0 && (
                          <div className="workspace-field" style={{ gridColumn: "1 / -1" }}>
                            <span>关联仓库</span>
                            <div className="work-item-repositories" style={{ marginBottom: 0 }}>
                              {selectedWorkspace.repositories
                                .filter((repository) => repository.status === "active")
                                .map((repository) => (
                                <label className="work-item-repository" key={repository.id}>
                                  <input
                                    type="checkbox"
                                    checked={workItemRepositories.includes(repository.id)}
                                    onChange={(event) => {
                                      setWorkItemRepositories((current) => event.target.checked
                                        ? [...new Set([...current, repository.id])]
                                        : current.filter((id) => id !== repository.id));
                                    }}
                                  />
                                  {repository.name} · {repository.kind === "code" ? "代码" : "知识库"}
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
                        <button className="workspace-action" onClick={() => setCreateWorkItemOpen(false)}>取消</button>
                        <button
                          className="workspace-action"
                          disabled={saving || !workItemTitle.trim() || !workItemDescription.trim()}
                          onClick={() => void createWorkItem()}
                        >
                          {saving ? "创建中…" : "创建工作项"}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="work-item-toolbar">
                    <div className="work-item-filter">
                      {([
                        ["all", "全部"],
                        ["requirement", "需求"],
                        ["bug", "Bug"],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          className="workspace-manager-tab"
                          data-active={filter === value}
                          onClick={() => setFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <input
                      className="workspace-search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索编号、标题或标签"
                    />
                    <button
                      className="workspace-action"
                      data-active={showArchived}
                      onClick={() => setShowArchived((current) => !current)}
                    >
                      {showArchived ? "返回未归档" : "查看归档"}
                    </button>
                  </div>
                  <div className="work-item-list">
                    {visibleWorkItems.map((item) => (
                      <button
                        className="work-item-row"
                        key={item.id}
                        onClick={() => void loadWorkItem(selectedWorkspace.id, item.key)}
                      >
                        <span className="work-item-key">{item.key}</span>
                        <span className="work-item-title">{item.title}</span>
                        <span className="work-item-badge">{STATUS_LABELS[item.status]}</span>
                        <span className="work-item-badge">{PHASE_LABELS[item.phase]}</span>
                        <time>{formatDate(item.updatedAt)}</time>
                      </button>
                    ))}
                    {!itemsLoading && visibleWorkItems.length === 0 && (
                      <div className="workspace-summary-card">
                        {showArchived ? "没有匹配的归档工作项。" : "没有匹配的工作项。"}
                      </div>
                    )}
                    {workItemData.invalid.map((item) => (
                      <div className="workspace-error" key={item.path}>
                        <strong>{item.key}</strong>：{item.error}
                      </div>
                    ))}
                  </div>
                </>
              )
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
