"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownBody } from "./MarkdownBody";
import { ImporterConfig } from "./ImporterConfig";
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
import { sourceLabel } from "@/lib/work-items/importers/source-labels";
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
  /** Narrow (middle-column panel) variant: hides the workspace rail AND the
   *  manager chrome header (the enclosing PanelHeader already titles the
   *  panel) and stacks the body single-column — the panel is too narrow for
   *  the 280px rail + content grid. Rows/toolbars compact below a 480px
   *  container width (the middle column is drag-resizable 200–560px). */
  panel?: boolean;
  /** Split (three-column) mode: the workspace LIST (rail) renders inline in
   *  the middle column while the selected workspace's settings DETAIL portals
   *  into the right column's config area (`portalTarget` = AppShell's
   *  configPortalNode — same pattern as the 模型/Skills/插件 split views). One
   *  instance keeps every bit of state (selection, drafts, save flow); only
   *  the layout splits. The manager chrome (header/tabs) is skipped — the
   *  middle column already renders its own PanelHeader. A null portal target
   *  renders nothing for the detail (the frame arrives in the next commit). */
  split?: { portalTarget: HTMLElement | null };
  initialSection?: ManagerSection;
  /** Desktop work-items split (the 工作项 middle-column panel): the LIST
   *  stays mounted in the middle column while the selected work item's
   *  DETAIL portals into the right column's config area (same mechanism as
   *  the 模型/Skills/插件 split views — `portalTarget` is AppShell's
   *  configPortalNode; null renders nothing until the frame mounts). Omitted
   *  on mobile — the detail replaces the list in place there. */
  workItemSplit?: { portalTarget: HTMLElement | null };
  /** Reports the selection up (the right-column PanelHeader shows key/title;
   *  the shell clears its mirror when it hands the right column elsewhere). */
  onSelectedWorkItemChange?: (item: { key: string; title: string } | null) => void;
  /** Increment to clear the selection (the right column's × — request-counter
   *  pattern, same as createWorkItemRequest). */
  closeWorkItemDetailRequest?: number;
  activeWorkspacePath?: string | null;
  initialWorkItemKey?: string | null;
  createWorkItemRequest?: { type: WorkItemType; id: number } | null;
  createWorkspaceOnOpen?: boolean;
  openRepositoryFormRequest?: number;
  onClose: () => void;
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
  onOpenWorkItemConversation: (workspace: WorkspaceSummary, item: WorkItemRecord) => void;
  /** Kit 时代「按合同执行」（D11）：客户端预填——把 `/skill:<loop> 执行|收养
   *  <KEY>` 写进该 workspace 新会话 composer 的草稿并切过去，人按发送才起会话。
   *  恒返回 null（预填不会失败；保留 string|null 签名以兼容拒绝横幅约定）。 */
  onRunContract?: (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
    mode: "execute" | "adopt",
  ) => Promise<string | null>;
  /** Open one of the item's linked conversation sessions by id (locate
   *  pipeline) — renders the `conversations` list as clickable entries. */
  onOpenConversation?: (sessionId: string) => void;
  onWorkspaceDeleted?: (workspace: WorkspaceSummary) => void;
  onWorkItemsChanged?: () => void;
  /** Reports the rail's current selection up (e.g. the right-column
   *  工作区设置 header shows the selected name in split mode). */
  onSelectedWorkspaceChange?: (workspace: WorkspaceSummary | null) => void;
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

export const STATUS_LABELS: Record<WorkItemStatus, string> = {
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
  panel = false,
  split,
  initialSection = "workspaces",
  workItemSplit,
  onSelectedWorkItemChange,
  closeWorkItemDetailRequest,
  activeWorkspacePath,
  initialWorkItemKey,
  createWorkItemRequest,
  createWorkspaceOnOpen = false,
  openRepositoryFormRequest,
  onClose,
  onOpenWorkspace,
  onOpenWorkItemConversation,
  onRunContract,
  onOpenConversation,
  onWorkspaceDeleted,
  onWorkItemsChanged,
  onSelectedWorkspaceChange,
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
  // Whether the selected workspace declares at least one kit loop
  // (loops/<name>/LOOP.md with a cron — D5 文件即声明). Gates the
  // 开始对话/收养续跑 buttons (D11: the retired `loop` capability no longer
  // decides this). Fetched once per selected workspace, no polling — loops
  // are authored rarely.
  const [hasKitLoops, setHasKitLoops] = useState(false);

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

  // Split mode: report the rail's selection up so the owner (AppShell's
  // right-column 工作区设置 header) can show the selected workspace's name.
  useEffect(() => {
    onSelectedWorkspaceChange?.(selectedWorkspace);
  }, [onSelectedWorkspaceChange, selectedWorkspace]);

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

  // Kit-declared loops of the selected workspace (read-only GET /loops —
  // pure file discovery, no capability involved). Drives only the
  // contract-execution button gate; failure or offline → no loops (buttons hidden).
  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspaceId) {
      setHasKitLoops(false);
      return;
    }
    let cancelled = false;
    void fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/loops`)
      .then(async (response) => {
        if (!response.ok) return { loops: [] as Array<{ pattern: string }> };
        return response.json() as Promise<{ loops?: Array<{ pattern: string }> }>;
      })
      .then((data) => {
        if (!cancelled) setHasKitLoops((data.loops?.length ?? 0) > 0);
      })
      .catch(() => {
        if (!cancelled) setHasKitLoops(false);
      });
    return () => {
      cancelled = true;
    };
  }, [embedded, open, selectedWorkspaceId]);

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

  // Work-item detail split (desktop): report selection changes up (the
  // right-column header + shell mirror), and honor the right column's ×
  // (request counter — clearing here unmounts the portaled detail).
  useEffect(() => {
    if (!onSelectedWorkItemChange) return;
    onSelectedWorkItemChange(selectedWorkItem
      ? { key: selectedWorkItem.item.key, title: selectedWorkItem.item.title }
      : null);
  }, [selectedWorkItem, onSelectedWorkItemChange]);
  useEffect(() => {
    if (!closeWorkItemDetailRequest) return;
    setSelectedWorkItem(null);
  }, [closeWorkItemDetailRequest]);

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

  /** 「按合同执行」/「收养续跑」（D11 客户端预填）：onRunContract 写入新会话
   *  composer 草稿并切到该 workspace 的 chat 视图，恒返回 null（预填不会
   *  失败）；这里仅刷新详情，保持列表/详情一致（无新会话产生——.jsonl 到首条
   *  消息才建）。 */
  const runContract = useCallback(async (mode: "execute" | "adopt") => {
    if (!selectedWorkspace || !selectedWorkItem || !onRunContract) return;
    setSaving(true);
    setError(null);
    try {
      const refusal = await onRunContract(selectedWorkspace, selectedWorkItem.item, mode);
      if (refusal) {
        setError(`未播种：${refusal}`);
        return;
      }
      if (selectedWorkspaceId) {
        const detail = await responseJson<WorkItemDetail>(
          await fetch(
            `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/work-items/${encodeURIComponent(selectedWorkItem.item.key)}`,
          ),
        );
        setSelectedWorkItem(detail);
        setContentDraft(detail.content);
        await loadWorkItems(selectedWorkspaceId);
        onWorkItemsChanged?.();
      }
    } catch (contractError) {
      setError(contractError instanceof Error ? contractError.message : String(contractError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkItems, onRunContract, onWorkItemsChanged, selectedWorkspace, selectedWorkspaceId, selectedWorkItem]);

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

  const splitMode = split != null;
  const portalTarget = split?.portalTarget ?? null;
  const workItemSplitMode = workItemSplit != null;

  // Shared narrow-layout compaction (single-column form grids, wrapping
  // toolbars, 2-line work-item rows, stacked detail header). Used by BOTH the
  // mobile media query and — in `panel` mode — a container query, because the
  // desktop middle column is drag-resizable (200–560px) while the full
  // work-item grid alone needs ~410px.
  const compactStyles = `
          .workspace-form-grid { grid-template-columns: 1fr; }
          .repository-row { grid-template-columns: minmax(0, 1fr) auto; }
          .skill-selection-list { grid-template-columns: 1fr; }
          .capability-checklist { grid-template-columns: 1fr; }
          .repository-row > code { grid-column: 1 / -1; grid-row: 2; }
          .repository-actions { grid-column: 1 / -1; grid-row: 3; }
          .workspace-page-header h2 { font-size: 17px; }
          .workspace-page-header { flex-wrap: wrap; }
          .work-item-toolbar { flex-wrap: wrap; }
          .work-item-filter { flex: 1 1 auto; min-width: 0; }
          .work-item-filter .workspace-manager-tab { flex: 0 0 auto; }
          .work-item-toolbar > .workspace-action { flex: 0 0 auto; }
          .workspace-search { max-width: none; order: 3; margin-left: 0; flex: 1 1 100%; }
          .work-item-row {
            grid-template-columns: auto minmax(0, 1fr) auto;
            gap: 7px;
          }
          .work-item-row .work-item-badge + .work-item-badge { display: none; }
          .work-item-row time { grid-column: 2; color: var(--text-dim); font-size: 10px; }
          .work-item-fields { display: grid; grid-template-columns: 1fr 1fr; }
          .workspace-field-compact select { min-width: 0; }
          .work-item-event { grid-template-columns: 92px 1fr; }
          /* Detail header: robust to button count (返回/继续会话/编辑正文/归档…)
             — key+title takes its own full-width line, buttons wrap below.
             (The old :nth-of-type grid placements silently mis-laid-out every
             button past the third.) */
          .work-item-detail-header { display: flex; flex-wrap: wrap; gap: 8px; }
          .work-item-detail-header > div { order: -1; flex: 1 1 100%; }
          .work-item-detail-header h2 { font-size: 15px; }
          .work-item-detail-header > .workspace-action { flex: 0 0 auto; white-space: nowrap; }
  `;

  const managerStyles = `
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
        .work-item-key { color: var(--accent); font-family: var(--font-mono); font-size: 11px; display: flex; align-items: center; gap: 4px; }
        .work-item-source {
          font-size: 9px;
          line-height: 1;
          color: var(--text-muted);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 2px 3px;
          white-space: nowrap;
        }
        .work-item-row[data-active="true"] {
          border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
          background: color-mix(in srgb, var(--accent) 6%, var(--bg));
        }
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
        /* Long unbreakable tokens (file paths, SPEC refs) must not blow out the
           1fr track — min-width:0 lets the track shrink, overflow-wrap breaks
           the token (inherited by the summary div). */
        .work-item-event > div { min-width: 0; overflow-wrap: anywhere; }
        ${panel ? `
        /* Narrow middle-column variant — MUST stay AFTER the base rules above:
           these are same-specificity overrides, and when this block lived
           before the base rules the cascade silently reverted every one of
           them (body kept the 280px rail track + 0px content column, content
           kept 18px padding — the whole pane overflowed the column). The
           manager chrome header is hidden entirely: the enclosing PanelHeader
           (工作项 panel / settings subpage) already titles the panel, and the
           Workspaces tab was a dead-end in this context. */
        .workspace-manager-page { container-type: inline-size; }
        .workspace-manager-header { display: none; }
        .workspace-manager-body { grid-template-columns: minmax(0, 1fr); }
        .workspace-rail { display: none; }
        .workspace-content { padding: 12px; }
        .work-item-toolbar { flex-wrap: wrap; }
        .work-item-filter { flex: 1 1 auto; min-width: 0; }
        .work-item-filter .workspace-manager-tab { flex: 0 0 auto; }
        .work-item-toolbar > .workspace-action { flex: 0 0 auto; }
        .workspace-search { max-width: none; order: 3; margin-left: 0; flex: 1 1 100%; }
        @container (max-width: 480px) {
          ${compactStyles}
        }
        ` : ""}
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
          ${compactStyles}
        }
  `;

  // Work-items panes. In the default (modal / mobile / settings-split)
  // contexts the detail replaces the list in place. In `workItemSplit` mode
  // (desktop 工作项 panel) the LIST stays mounted in the middle column while
  // the DETAIL portals into the right column's config area — one instance
  // keeps every bit of state (selection, drafts, save flow).
  const workItemDetailPane = selectedWorkItem && selectedWorkspace ? (
    <div className="work-item-detail-card">
                  <div className="work-item-detail-header">
                    {!workItemSplitMode && (
                      <button className="workspace-action" onClick={() => setSelectedWorkItem(null)}>← 返回</button>
                    )}
                    <div>
                      <div className="work-item-key">{selectedWorkItem.item.key}</div>
                      <h2>{selectedWorkItem.item.title}</h2>
                    </div>
                    {selectedWorkItem.item.status !== "done" && selectedWorkItem.item.status !== "cancelled" && selectedWorkItem.item.phase !== "complete" && selectedWorkItem.events.length > 0
                      && [...selectedWorkItem.events].reverse().find((event) => event.type === "loop.gate" || event.type.startsWith("loop."))?.type === "loop.gate" && (
                      <span
                        style={{ padding: "2px 8px", borderRadius: 5, background: "rgba(245,158,11,0.15)", color: "#b45309", fontSize: 12, fontWeight: 700, alignSelf: "center" }}
                        title="执行会话已提问并等待答复——去关联会话里回答即可继续"
                      >
                        待裁决
                      </span>
                    )}
                    {/* D11: the buttons exist when the workspace declares kit
                        loops (a loops directory entry with a LOOP.md cron —
                        file-is-declaration, no capability), regardless of the
                        retired `loop` string. */}
                    {onRunContract && hasKitLoops && selectedWorkItem.item.phase !== "complete" && selectedWorkItem.item.status !== "done" && selectedWorkItem.item.status !== "cancelled" ? (
                      selectedWorkItem.item.conversations.length === 0 ? (
                        <button
                          className="workspace-action"
                          style={{ marginLeft: "auto" }}
                          disabled={saving}
                          onClick={() => void runContract("execute")}
                          title="预填 /skill:<loop> 执行合同到新会话 composer（发送后才起会话；开场判定→SPEC→maker/checker→合并→验证）"
                        >
                          开始对话
                        </button>
                      ) : (
                        <>
                          <button
                            className="workspace-action"
                            style={{ marginLeft: "auto" }}
                            onClick={() => onOpenWorkItemConversation(selectedWorkspace, selectedWorkItem.item)}
                            title="打开最新的合同执行会话（skill 已在其上下文中，直接继续聊/gate 答复）"
                          >
                            继续对话
                          </button>
                          {selectedWorkItem.events.some((event) => event.type === "loop.started") && (
                            <button
                              className="workspace-action"
                              disabled={saving}
                              onClick={() => void runContract("adopt")}
                              title="预填收养提示到新会话 composer：从派发计划+里程碑缺口续跑（不重做开场判定）——旧会话僵死/重开时用"
                            >
                              收养续跑
                            </button>
                          )}
                        </>
                      )
                    ) : (
                      <button
                        className="workspace-action"
                        style={{ marginLeft: "auto" }}
                        onClick={() => onOpenWorkItemConversation(selectedWorkspace, selectedWorkItem.item)}
                      >
                        {selectedWorkItem.item.conversations.length > 0 ? "继续会话" : "开始会话"}
                      </button>
                    )}
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
                  {onOpenConversation && selectedWorkItem.item.conversations.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                      <span style={{ fontSize: 12, color: "var(--text-dim)", flexShrink: 0 }}>关联会话：</span>
                      {selectedWorkItem.item.conversations.map((conversationId) => (
                        <button
                          key={conversationId}
                          className="workspace-action"
                          onClick={() => onOpenConversation(conversationId)}
                          title={conversationId}
                        >
                          {(conversationId.slice(0, 8))}
                        </button>
                      ))}
                    </div>
                  )}
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
                    {selectedWorkItem.item.external && (
                      <div className="workspace-field workspace-field-compact">
                        <span>来源</span>
                        <div style={{ padding: "9px 0", fontSize: 13 }}>
                          {selectedWorkItem.item.external.url ? (
                            <a
                              href={selectedWorkItem.item.external.url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: "var(--accent)" }}
                            >
                              {sourceLabel(selectedWorkItem.item.external.source)} #{selectedWorkItem.item.external.sourceId} ↗
                            </a>
                          ) : (
                            <span>
                              {sourceLabel(selectedWorkItem.item.external.source)} #{selectedWorkItem.item.external.sourceId}
                            </span>
                          )}
                          {selectedWorkItem.item.external.lastSyncedAt && (
                            <span style={{ color: "var(--text-dim)", marginLeft: 8, fontSize: 11 }}>
                              同步于 {formatDate(selectedWorkItem.item.external.lastSyncedAt)}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
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
  ) : null;
  const workItemListPane = selectedWorkspace ? (
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
                        data-active={selectedWorkItem?.item.key === item.key}
                      >
                        <span className="work-item-key">
                          {item.key}
                          {item.external && (
                            <span className="work-item-source" title={`来自${sourceLabel(item.external.source)} #${item.external.sourceId}`}>
                              {sourceLabel(item.external.source)}
                            </span>
                          )}
                        </span>
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
  ) : null;

  const railPane = (
    <aside
      className="workspace-rail"
      style={splitMode ? { width: "100%", flex: 1, minHeight: 0, borderRight: "none" } : undefined}
    >
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
  );

  const contentPane = (
    <main
      className="workspace-content"
      style={splitMode ? { flex: 1, minHeight: 0 } : undefined}
    >
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
                        <h3>工作区可用 Skills</h3>
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
                    <ImporterConfig
                      workspace={selectedWorkspace}
                      onWorkspaceChanged={() => void loadWorkspaces()}
                    />
                  </>
                ) : (
                  <div className="workspace-summary-card">
                    创建第一个 Workspace，从勾选能力开始（会话与 Explorer 始终必带）。
                  </div>
                )}
              </>
            )}

            {section === "work-items" && selectedWorkspace && (
              workItemSplitMode ? workItemListPane : selectedWorkItem ? workItemDetailPane : workItemListPane
            )}
    </main>
  );

  if (splitMode) {
    // Split (three-column) mode: the workspace LIST (rail) fills the middle
    // column — no manager chrome, the column's own PanelHeader (via
    // SettingsPanel) already titles the panel — while the selected
    // workspace's settings DETAIL portals into the right column's config
    // area (the container under the 工作区设置 PanelHeader). The detail keeps
    // `.workspace-content` styling with full-height scroll; work-items
    // content flows through the same pane so every section keeps working.
    // A null portal target renders nothing for the detail — the frame
    // arrives in the next commit (same guard as the config components).
    return (
      <div
        className="workspace-manager-page"
        style={{ display: "flex", flexDirection: "column" }}
      >
        <style>{managerStyles}</style>
        {railPane}
        {portalTarget ? createPortal(contentPane, portalTarget) : null}
      </div>
    );
  }

  return (
    <div
      className={embedded ? "workspace-manager-page" : "workspace-manager-backdrop"}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-label="Pi Workspace"
    >
      <style>{managerStyles}</style>
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
          {railPane}
          {contentPane}
        </div>
      </div>
      {workItemSplitMode && workItemDetailPane && workItemSplit.portalTarget
        ? createPortal(workItemDetailPane, workItemSplit.portalTarget)
        : null}
    </div>
  );
}
