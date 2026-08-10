export const WORKSPACE_SCHEMA_VERSION = 1 as const;

/**
 * @deprecated Workspace creation is now capability-driven (see `CreateWorkspaceInput.capabilities`).
 * These template ids remain only so legacy manifests can fall back to a built-in template's
 * capabilities via `effectiveCapabilities`. New workspaces omit `template` entirely.
 */
export const BUILTIN_WORKSPACE_TEMPLATE_IDS = ["empty", "software-development"] as const;
/** @deprecated Legacy built-in template id; retained for `effectiveCapabilities` fallback. */
export type BuiltinWorkspaceTemplateId = (typeof BUILTIN_WORKSPACE_TEMPLATE_IDS)[number];

/**
 * A workspace template id. Either a built-in id ("empty" | "software-development")
 * or a custom template id — any slug defined under `.pi/workspace-templates/<id>/`.
 *
 * @deprecated Template selection has been removed from workspace creation. This type is
 * retained so legacy manifests (which still carry `template.id`) can be parsed and looked up
 * for capability fallback. New workspaces do not set a template.
 */
export type WorkspaceTemplateId = string;
export type WorkspaceCapability =
  | "sessions"
  | "explorer"
  | "work-items"
  | "repositories"
  | "knowledge"
  | "overview"
  | "workflows"
  | "feishu-transport"

  | "loop"
  | "subagent"
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
  /** @deprecated Legacy field. New (capability-driven) workspaces omit `template`;
   *  it is retained for backward compatibility so `effectiveCapabilities` can fall back to a
   *  built-in template's capabilities when a manifest has no cached `capabilities`. */
  template?: {
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
  /** @deprecated Absent for capability-driven workspaces (no `template`); kept for legacy ones. */
  templateId?: WorkspaceTemplateId;
  /** @deprecated Absent for capability-driven workspaces (no `template`); kept for legacy ones. */
  templateVersion?: number;
  capabilities: WorkspaceCapability[];
  available: boolean;
  configStatus: "ready" | "directory-unavailable" | "config-missing" | "config-invalid";
  skills: string[];
  repositories: WorkspaceRepository[];
  repositoryCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * @deprecated Template selection has been removed from workspace creation. Template metadata is
 * still listed (GET /api/workspaces) and used for `effectiveCapabilities` fallback on legacy
 * manifests, but new workspaces are created from a capability checklist instead.
 */
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

/**
 * A custom (user-defined) workspace template, parsed from `.pi/workspace-templates/<id>/template.yaml`.
 *
 * @deprecated Custom templates can no longer seed new workspaces (creation is capability-driven).
 * Discovery/parsing is retained for the legacy `effectiveCapabilities` fallback path only.
 */
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
  /** True for templates shipped with the app (discovered from the bundled
   *  templates directory rather than the user workspaces root). Bundled
   *  templates are read-only and should not be edited through the UI. */
  bundled?: boolean;
}

export interface WorkspaceIndexEntry {
  id: string;
  path: string;
  name: string;
  /** @deprecated Absent for capability-driven workspaces; kept for legacy ones. */
  templateId?: string;
  /** @deprecated Absent for capability-driven workspaces; kept for legacy ones. */
  templateVersion?: number;
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
