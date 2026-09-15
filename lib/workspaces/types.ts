export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type WorkspaceCapability =
  | "sessions"
  | "explorer"
  | "work-items"
  | "repositories"
  | "knowledge"
  | "workflows"
  | "subagent";
export type WorkspaceRepositoryKind = "code" | "knowledge";
export type WorkspaceRepositoryStatus = "active" | "removed";

export interface WorkspaceRepository {
  id: string;
  alias: string;
  name: string;
  kind: WorkspaceRepositoryKind;
  /** Relative POSIX path from the workspace root where this repository lives
   *  (2026-09 path-registration convention — no fixed `repositories/` layout;
   *  the root hosts the user's own project directories). REQUIRED. */
  path: string;
  status: WorkspaceRepositoryStatus;
  removedAt?: string;
}

export interface WorkspaceRepositoryState extends WorkspaceRepository {
  path: string;
  remote?: string;
  exists: boolean;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  error?: string;
}

export interface AddWorkspaceRepositoryInput {
  alias: string;
  name?: string;
  kind: WorkspaceRepositoryKind;
  /** `clone` = git-clone a remote into the (new) path; `init` = git-init a fresh
   *  repo there; `register` = register an EXISTING directory at `path` as a
   *  repository (the path-registration flow for dirs the user already has). */
  mode: "clone" | "init" | "register";
  /** Relative POSIX path from the workspace root. Defaults to `alias` (root-level
   *  directory) when omitted; REQUIRED for `register`. */
  path?: string;
  remote?: string;
}

export interface WorkspaceAgentSettings {
  defaultModel?: string;
  thinkingLevel?: string;
}

export interface WorkspaceGitSettings {
  branchRules: {
    requirement: string;
    bug: string;
  };
  createAfter: "plan_approved";
}

export interface WorkspaceManifest {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  slug: string;
  name: string;
  skills: string[];
  repositories: WorkspaceRepository[];
  agent: WorkspaceAgentSettings;
  /** Enabled capabilities for this workspace (capability-driven). REQUIRED —
   *  always written explicitly by `createWorkspace`/`updateWorkspace`/the v2
   *  index migration; a manifest without it is config-invalid. */
  capabilities: WorkspaceCapability[];
  git?: WorkspaceGitSettings;
  /** Temporarily disabled by the user (2026-09 设置可停用): pickers (home
   *  selectors, tab-bar/workspace-switcher dropdowns, home grouping) hide the
   *  workspace, but open tabs, loop heartbeats and session assembly are
   *  untouched — re-enabling happens from the settings detail. Omitted/absent
   *  means enabled (old manifests stay valid without migration). */
  disabled?: boolean;
  workItems: {
    nextRequirementNumber: number;
    nextBugNumber: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  path: string;
  capabilities: WorkspaceCapability[];
  available: boolean;
  configStatus: "ready" | "directory-unavailable" | "config-missing" | "config-invalid";
  /** User-disabled (manifest `disabled: true`). Distinct from `available`
   *  (directory health): a disabled workspace can still be selected in the
   *  settings list to re-enable or edit it. */
  disabled: boolean;
  skills: string[];
  repositories: WorkspaceRepository[];
  repositoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceIndexEntry {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  lastOpenedAt: string;
  /** 手动排序位（2026-09，可选）：升序在前，未设置的条目按 MRU 排在其后。
   *  存在全局索引而非各 manifest —— 重排 = 一次索引写入，不触发工作区 git 提交；
   *  `registerWorkspacePath` 重建条目时透传保留。 */
  sortOrder?: number;
}

export interface WorkspaceIndex {
  schemaVersion: 2;
  workspaces: WorkspaceIndexEntry[];
}

/** Workspace-selection predicate for every picker surface (home selectors,
 *  tab-bar/workspace-switcher dropdowns, home grouping): directory must be
 *  healthy AND not user-disabled. Pure so client components share it. */
export function isWorkspaceSelectable(workspace: WorkspaceSummary): boolean {
  return workspace.available && !workspace.disabled;
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  /** Capabilities to enable. `sessions` + `explorer` are always force-included (mandatory);
   *  any unknown value is rejected by `parseCapabilities`. See `INIT_CAPABILITY_CHECKLIST`. */
  capabilities: WorkspaceCapability[];
}

export interface ImportWorkspaceInput {
  path: string;
  asCopy?: boolean;
}

export interface UpdateWorkspaceInput {
  expectedUpdatedAt?: string;
  name?: string;
  skills?: string[];
  /** Replace the workspace's capability set. Used to toggle modules on/off. */
  capabilities?: WorkspaceCapability[];
  /** Temporarily disable/enable the workspace (picker visibility only — see
   *  `WorkspaceManifest.disabled`). */
  disabled?: boolean;
}
