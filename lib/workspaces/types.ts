export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type WorkspaceCapability =
  | "sessions"
  | "explorer"
  | "work-items"
  | "repositories"
  | "knowledge"
  | "overview"
  | "workflows"
  | "feishu-transport"
  | "requirement-sources"

  | "loop"
  | "subagent"
  | "feishu-channel";
export type WorkspaceRepositoryKind = "code" | "knowledge";
export type WorkspaceRepositoryStatus = "active" | "removed";

export interface WorkspaceRepository {
  id: string;
  alias: string;
  name: string;
  kind: WorkspaceRepositoryKind;
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
  mode: "clone" | "init";
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
  /** Enabled capabilities for this workspace (capability-driven). Written explicitly
   *  by `createWorkspace`/`updateWorkspace`; `effectiveCapabilities` falls back to
   *  `["sessions", "explorer"]` when absent. */
  capabilities?: WorkspaceCapability[];
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
