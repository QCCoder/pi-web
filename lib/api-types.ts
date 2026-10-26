import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "./subagents";

export interface SubagentProfilesResponse {
  profiles: SubagentProfile[];
}

export interface SubagentSettingsResponse {
  enabled: boolean;
  maxConcurrent: number;
}

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface ProjectTrustStatus {
  requiresTrust: boolean;
  trusted: boolean;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export type PluginUpdateState =
  | "update-available"
  | "up-to-date"
  | "unsupported"
  | "error";

export interface PluginUpdateResult {
  source: string;
  scope: PluginScope;
  displayName: string;
  type: "npm" | "git";
  state: PluginUpdateState;
  message?: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  canCheckForUpdates: boolean;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface PushConfigResponse {
  publicKey: string;
}

// Seam-repositioning Task 4（2026-10-26）：交付角色摘要 / 组合预览两条只读 GET
// 的响应形状。结构是 lib/work-items/delivery-runner/role-preview.ts 的客户端
// 镜像（该模块 import node:fs，不能进浏览器 bundle——DeliveryRunnerConfigState
// 同款手法）；DeliveryRole 类型从零依赖的 roles.ts 引（安全）。
export interface DeliveryRoleModelRef {
  provider?: string;
  modelId: string;
}

export interface DeliveryRoleSummary {
  role: string;
  profile: {
    name: string;
    path: string;
    exists: boolean;
    explicit: boolean;
    seededFrom?: string;
  };
  model: {
    effective?: DeliveryRoleModelRef;
    source: "override" | "profile" | "default";
  };
}

export interface DeliveryRolesResponse {
  roles: DeliveryRoleSummary[];
}

/** 组合预览（DeliveryRoleSummary + 三段展示；composed 与 launch 同一函数产出）。 */
export interface DeliveryRolePromptPreview extends DeliveryRoleSummary {
  agentsMd: string | null;
  invariant: string;
  body: string;
  composed: string;
}

export interface DeliveryRolePreviewResponse {
  preview: DeliveryRolePromptPreview;
}
