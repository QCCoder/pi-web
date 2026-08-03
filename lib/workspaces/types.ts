export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export const BUILTIN_WORKSPACE_TEMPLATE_IDS = ["empty", "software-development"] as const;
export type BuiltinWorkspaceTemplateId = (typeof BUILTIN_WORKSPACE_TEMPLATE_IDS)[number];

/**
 * A workspace template id. Either a built-in id ("empty" | "software-development")
 * or a custom template id — any slug defined under `.pi/workspace-templates/<id>/`.
 */
export type WorkspaceTemplateId = string;
export type WorkspaceCapability =
  | "sessions"
  | "explorer"
  | "work-items"
  | "repositories"
  | "overview"
  | "workflows"
  | "feishu-transport"
  // Forward-declared module toggles. The capabilities are registered so
  // templates can declare them today; the matching extensions/services are
  // wired in later branches and stay inert (no factory attached) until then.
  | "loop"
  | "feishu-channel";
export type WorkspaceTemplateSource = "built-in" | "custom";
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
  template: {
    id: WorkspaceTemplateId;
    version: number;
  };
  skills: string[];
  repositories: WorkspaceRepository[];
  agent: WorkspaceAgentSettings;
  /** Cached capabilities snapshot, synced from the template definition on edit.
   *  Absent for legacy manifests (derived from the built-in template lookup). */
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
  templateId: WorkspaceTemplateId;
  templateVersion: number;
  capabilities: WorkspaceCapability[];
  available: boolean;
  configStatus: "ready" | "directory-unavailable" | "config-missing" | "config-invalid";
  skills: string[];
  repositories: WorkspaceRepository[];
  repositoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTemplateInfo {
  id: WorkspaceTemplateId;
  name: string;
  description: string;
  version: number;
  capabilities: WorkspaceCapability[];
  source: WorkspaceTemplateSource;
  skills: string[];
  /** Whether this template can be edited through the UI (custom only). */
  editable: boolean;
}

/** A custom (user-defined) workspace template, parsed from `.pi/workspace-templates/<id>/template.yaml`. */
export interface WorkspaceCustomTemplate {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  version: number;
  capabilities: WorkspaceCapability[];
  skills: string[];
  agent: WorkspaceAgentSettings;
  /** Absolute path to the template directory (holds `template.yaml` + `seed/`). */
  path: string;
}

export interface WorkspaceIndexEntry {
  id: string;
  path: string;
  name: string;
  templateId: string;
  templateVersion: number;
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
  templateId: WorkspaceTemplateId;
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
