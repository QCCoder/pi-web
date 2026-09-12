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
}

export interface WorkspaceIndex {
  schemaVersion: 2;
  workspaces: WorkspaceIndexEntry[];
}

/** Legacy on-disk index shape; migrated in place to v2 on first read. */
export interface WorkspaceIndexV1 {
  schemaVersion: 1;
  workspaces: WorkspaceIndexEntry[];
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
}
