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

// final-arch step-2 Task 5（2026-10-26）：attention 队列（spec §8——唯一的人工
// 待办投影）GET …/workspaces/[id]/attention 的响应形状。类型单一定义处：
// lib/work-items/attention.ts（服务端，import node 模块）也 type-only 引用
// 这里的定义——镜像零漂移（DeliveryRoleSummary 手抄镜像的反例教训）。
// acceptance（final-arch step-4 Task 3）：release_ready 待人工验收（开关
// stages.acceptance.enabled 才投影）。
export type AttentionKind = "question" | "confirm" | "release" | "acceptance" | "blocked";

export interface AttentionEntry {
  key: string;
  title: string;
  kind: AttentionKind;
  /** 锚点 ISO 时刻（kind 语义见 attention.ts 投影头注）。 */
  since: string;
  /** floor((now - since) / 86400000)。 */
  ageDays: number;
  /** events.jsonl 中晚于 since 的 delivery.nudged / delivery.parked（同 kind）。 */
  nudged: boolean;
  parked: boolean;
  /** question 原文 / 「设计待确认」/ 「待登记发布」/ 「待人工验收」/
   *  block·暂停·中断文案。 */
  detail: string;
  /** kind === "question" 时 = 最早未答澄清的 id。 */
  clarificationId?: string;
}

export interface AttentionResponse {
  entries: AttentionEntry[];
}

// final-arch step-6 Task 1（2026-10-26）：交付初始化（POST …/delivery/init）与
// 就绪清单（GET …/delivery/readiness）的响应形状。单一定义处 = 此文件；服务端
// lib/workspaces/delivery-init.ts type-only 引用（attention 同款零漂移镜像）。
// 语义（spec §13.2/§13.3/§13.5.1）：init 只补缺、只建议——探测/from 草稿只进
// suggestedChecks 供人确认，从不落盘执行；readiness 非门禁。
export interface DeliverySuggestedCheck {
  name: string;
  command: string;
  /** from 复制的草稿剥除（仓绑定待面板重绑）；工具链探测草稿携带（仓已登记）。 */
  repositoryId?: string;
}

/** 就绪缺项五类（kind 序即展示序）：no-checks / missing-profile:<role> /
 *  capabilities-missing / check-repo-unregistered / integrate-no-command。 */
export type DeliveryReadinessKind =
  | "no-checks"
  | `missing-profile:${string}`
  | "capabilities-missing"
  | "check-repo-unregistered"
  | "integrate-no-command";

export interface DeliveryReadinessItem {
  kind: DeliveryReadinessKind;
  detail: string;
}

export interface DeliveryInitResponse {
  /** 所做动作清单（人话一行一条；「已存在，未改动」= 幂等跳过）。 */
  actions: string[];
  /** 确认草稿（from checks 剥 repositoryId + 工具链探测）——非空才在。 */
  suggestedChecks?: DeliverySuggestedCheck[];
  readiness: DeliveryReadinessItem[];
}

export interface DeliveryReadinessResponse {
  items: DeliveryReadinessItem[];
  /** 当前内置剧本模板版本（role-templates ROLE_TEMPLATE_VERSION——漂移提示依据）。 */
  currentTemplateVersion: number;
}
