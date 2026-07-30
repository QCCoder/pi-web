export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type WorkspaceTemplateId = "empty" | "software-development";
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
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  templateId: WorkspaceTemplateId;
}

export interface UpdateWorkspaceInput {
  expectedUpdatedAt?: string;
  name?: string;
  skills?: string[];
}
