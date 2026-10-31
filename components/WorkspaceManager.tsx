"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownBody } from "./MarkdownBody";
import { CapabilityToggle } from "./CapabilityToggle";
import { useWorkItems } from "@/hooks/useWorkItems";
import type {
  WorkspaceCapability,
  WorkspaceRepositoryState,
  WorkspaceRepositoryKind,
  WorkspaceSummary,
} from "@/lib/workspaces/types";
import { INIT_CAPABILITY_CHECKLIST, MANDATORY_CAPABILITIES } from "@/lib/workspaces/templates";
import type {
  WorkItemDetail,
  WorkItemImportOutcome,
  WorkItemPhase,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemStatus,
  WorkItemType,
} from "@/lib/work-items/types";
import { sourceLabel } from "@/lib/work-items/source-labels";
import type {
  DeliveryInitResponse,
  DeliveryReadinessResponse,
  DeliveryRolePreviewResponse,
  DeliveryRolePromptPreview,
  DeliveryRolesResponse,
  DeliveryRoleSummary,
  DeliverySuggestedCheck,
} from "@/lib/api-types";
// 交付角色词表：零依赖叶子模块（不 import 任何 node 内建），可安全进浏览器
// bundle——角色表按 DELIVERY_ROLES 序渲染、PUT 体按词表拼 roles 四键。
import { DELIVERY_ROLES, type DeliveryRole } from "@/lib/work-items/delivery-runner/roles";
import { setLastSettingsSection, setLastSettingsSelection } from "@/lib/settings-navigation";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";
// 工作项共用件（M2 T9 抽取）：创建表单 / 事件时间线 / 来源行与仓库 chips /
// fetch 帮手。本面板与中央 WorkItemsPage 两处引用同一实现。
import { WorkItemCreateForm, type WorkItemCreateFormValues } from "./work-items/WorkItemCreateForm";
import { WorkItemEvents } from "./work-items/WorkItemEvents";
import { SourceRefValue, WorkItemRepositoryChips } from "./work-items/WorkItemMeta";
import { responseJson, uploadWorkItemAttachments } from "./work-items/work-item-api";

interface WorkspaceListResponse {
  root: string;
  workspaces: WorkspaceSummary[];
}

interface RepositoryListResponse {
  repositories: WorkspaceRepositoryState[];
}

/** 交付自动化配置的客户端结构镜像（lib/work-items/delivery-runner/config.ts
 *  的 DeliveryRunnerConfig——该模块是服务端 fs/yaml 层，不能进浏览器 bundle）。
 *  Seam-repositioning T1/T4：schemaVersion v2、roles 四键同形（词表从零依赖的
 *  roles.ts 直引——DeliveryRole 词表与 DELIVERY_ROLES 序服务端同源）。 */
interface DeliveryRoleConfigState {
  profile?: string;
  model?: { provider?: string; modelId: string };
}

/** DeliveryCheckConfig 的客户端镜像：验证命令清单（Phase-4）——人维护
 *  （本编辑器），agent 只能触发不能自造。final-arch step-3：执行者是引擎
 *  system 检查步（verifier 角色已退役），清单语义不变。 */
interface DeliveryCheckConfigState {
  name: string;
  repositoryId?: string;
  command: string;
  timeout_seconds?: number;
}

interface DeliveryRunnerConfigState {
  schemaVersion: 2;
  enabled: boolean;
  /** 角色配置四键同形（v2，词表 roles.ts）：designer/developer/reviewer/
   *  release-preparer 各自可选——角色表按 DELIVERY_ROLES 序拼 PUT 体。 */
  roles: Partial<Record<DeliveryRole, DeliveryRoleConfigState>>;
  budget: { maxAttemptsPerInput: number; maxExecutionMinutes: number };
  /** attention 队列阈值（final-arch step-2，服务端 parse 后必有——缺块回填
   *  3/7）：nudgeAfterDays / parkAfterDays。PUT 必须原样回传（backlog-clearing
   *  T2）——不带 attention 的保存会被服务端 parse 打回缺省 3/7，手设阈值
   *  即丢。UI 无编辑控件，纯 round-trip 保真。 */
  attention: { nudgeAfterDays: number; parkAfterDays: number };
  /** 验证命令（Phase-4）：可选缺省 undefined = 无配置（system 检查步按空清单
   *  处理）；空数组合法、等同无配置。 */
  verification?: { checks: DeliveryCheckConfigState[] };
  /** 流程阶段开关（final-arch step-3/4，服务端解析后必有——缺块回填全关）：
   *  review = 先审后跑；integrate = 集成命令（enabled 时 command 必填非空，
   *  客户端先行拦截——文案与服务端 parseStages 一致；关闭时 command 可选保留，
   *  回开免重写）；acceptance = 验收门（release 前须人工验收记录）。PUT 必须
   *  原样回传——UI 保存不得丢手设的开关。 */
  stages: {
    review: { enabled: boolean };
    integrate: { enabled: boolean; command?: string };
    acceptance: { enabled: boolean };
  };
}

/** checks 编辑器的草稿行：可选字段用空串表达「缺省」，保存时剥键（round-trip
 *  与服务端 parseCheck 的条件展开同形）。 */
interface DeliveryCheckDraft {
  name: string;
  /** "" = 候选首仓（缺省——claim 事务内解析，不落配置）。 */
  repositoryId: string;
  command: string;
  /** "" = 服务端缺省 600s。 */
  timeout: string;
}

/** 配置 → 草稿行（GET 播种与保存回填共用）：可选字段缺省映射为空串。 */
function checksDraftFromConfig(config: DeliveryRunnerConfigState): DeliveryCheckDraft[] {
  return (config.verification?.checks ?? []).map((check) => ({
    name: check.name,
    repositoryId: check.repositoryId ?? "",
    command: check.command,
    timeout: check.timeout_seconds === undefined ? "" : String(check.timeout_seconds),
  }));
}

/** checks 草稿 → PUT 载荷：整行空白丢弃；名称/命令只填其一 → 报错拒存（半行
 *  会被服务端 400 打回，提前在 UI 拦）；timeout 非空时必须是 1–3600 的整数
 *  （config.ts parseTimeoutSeconds 同规）。无有效行 → checks 缺省 = 键整体
 *  省略（PUT 不带 verification = 无配置）。 */
function checksPayload(
  drafts: DeliveryCheckDraft[],
): { checks?: Array<{ name: string; repositoryId?: string; command: string; timeout_seconds?: number }> } | { error: string } {
  const checks: Array<{ name: string; repositoryId?: string; command: string; timeout_seconds?: number }> = [];
  for (const [index, draft] of drafts.entries()) {
    const name = draft.name.trim();
    const command = draft.command.trim();
    const repositoryId = draft.repositoryId.trim();
    const timeout = draft.timeout.trim();
    if (!name && !command && !repositoryId && !timeout) continue; // 空行丢弃
    if (!name || !command) {
      return { error: `验证命令第 ${index + 1} 行：名称与命令必填。` };
    }
    if (timeout && (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 3600)) {
      return { error: `验证命令第 ${index + 1} 行：timeout_seconds 必须是 1–3600 的整数（秒）。` };
    }
    checks.push({
      name,
      ...(repositoryId ? { repositoryId } : {}),
      command,
      ...(timeout ? { timeout_seconds: Number(timeout) } : {}),
    });
  }
  return checks.length > 0 ? { checks } : {};
}

/** 服务端 DEFAULT_DELIVERY_RUNNER_CONFIG 的客户端镜像：GET /delivery 返回
 *  200 + {config:null}（Task 1 契约：.pi/delivery.yaml 缺失 = 默认 disabled）
 *  时按此播种表单——不是错误，否则刚开齐 capabilities 的工作区永远无法从
 *  UI 启用自动化。 */
const DEFAULT_DELIVERY_RUNNER_CONFIG: DeliveryRunnerConfigState = {
  schemaVersion: 2,
  enabled: false,
  roles: {},
  budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  attention: { nudgeAfterDays: 3, parkAfterDays: 7 },
  stages: {
    review: { enabled: false },
    integrate: { enabled: false },
    acceptance: { enabled: false },
  },
};

/** 角色表标签（角色列 + 预览抽屉标题；词表序 = DELIVERY_ROLES）。从词表派生
 *  （final-arch step-3 T1 增 reviewer 后保持任意词表可编译）——查表缺省回退
 *  角色名。 */
const DELIVERY_ROLE_LABEL_LOOKUP: Partial<Record<DeliveryRole, string>> = {
  designer: "设计师",
  developer: "开发者",
  reviewer: "评审者",
  "release-preparer": "发布准备者",
};
const DELIVERY_ROLE_LABELS = Object.fromEntries(
  DELIVERY_ROLES.map((role) => [role, DELIVERY_ROLE_LABEL_LOOKUP[role] ?? role]),
) as Record<DeliveryRole, string>;

/** 角色表全角色空 profile 草稿（"" = 同名剧本缺省——不写 profile 键）。
 *  从词表派生（任意词表可编译，同上）。 */
const EMPTY_ROLE_PROFILE_DRAFTS = Object.fromEntries(
  DELIVERY_ROLES.map((role) => [role, ""]),
) as Record<DeliveryRole, string>;

type ManagerSection = "workspaces" | "work-items";

/** 列表行路径缩短（2026-09 反馈收敛）：保留末尾 3 段 + 省略号，完整路径在
 *  title 提示与详情页可见。与 SettingsPanel.shortenPath 同规则。 */
function shortenWorkspacePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : path;
}
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
  /** Split (three-column) mode — two variants sharing one instance's state
   *  (selection, drafts, save flow); only the layout splits, and the manager
   *  chrome (header/tabs) is always skipped (the host column already renders
   *  its own PanelHeader):
   *  - `{ portalTarget }`: the workspace LIST (rail) renders inline in the
   *    host while the selected workspace's settings DETAIL portals into
   *    `portalTarget` (AppShell's configPortalNode — same pattern as the
   *    模型/Skills/插件 split views). A null portal target renders nothing for
   *    the detail (the frame arrives in the next commit).
   *  - `{ inline: true }`: LIST + DETAIL render side by side inside ONE host
   *    container (the desktop center-area 工作区设置 page — 2026-09 the list
   *    left the cramped middle column; both panes live in the main area). */
  split?: { portalTarget: HTMLElement | null } | { inline: true };
  initialSection?: ManagerSection;
  activeWorkspacePath?: string | null;
  createWorkItemRequest?: { type: WorkItemType; id: number } | null;
  /** createWorkItemRequest 已消费（fix round 1 Important，nonce 一次性）：
   *  面板打开创建表单后回调宿主清空请求——同 WorkItemsPage 的
   *  onConsumedCreateRequest 模式；不清空的话换工作区重挂载（key 变化）
   *  会让残留 nonce 再次自启表单。 */
  onConsumedCreateRequest?: () => void;
  createWorkspaceOnOpen?: boolean;
  openRepositoryFormRequest?: number;
  /** 深链预选（已停用工作区的重启用路径）：设置›工作区分区打开时选中指定
   *  工作区（nonce 驱动，可重复触发）；宿主在设置面关闭时清空，避免重开时
   *  闪回旧选择。数据就绪后命中才生效（id 不存在则忽略）。 */
  selectWorkspaceRequest?: { id: string; nonce: number } | null;
  onClose: () => void;
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
  onOpenWorkItemConversation: (workspace: WorkspaceSummary, item: WorkItemRecord) => void;
  /** Kit 时代「按合同执行」（D11）：客户端预填——把 `/skill:<loop> 执行|收养
   *  <KEY>` 写进该 workspace 新会话 composer 的草稿并切过去，人按发送才起会话
   *  （预填不会失败，恒成功）。 */
  onRunContract?: (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
    mode: "execute" | "adopt",
  ) => Promise<void>;
  /** 「立即跑一轮」（B 面，Task 9）：POST run 路由在 daemon 起一轮，成功后把
   *  新轮会话开成 workspace 的 chat tab（SSE 实时观看）；409（本轮已在跑）
   *  等错误在 handler 内 alert 直陈。 */
  onRunLoopRound?: (workspace: WorkspaceSummary, item: WorkItemRecord, loopName: string) => void;
  /** 角色表「编辑剧本」（Seam-repositioning Task 4）：宿主接此回调切到
   *  设置 › Agents 面板（desktop = openCenterPage({kind:"agents"})，mobile =
   *  设置页 agents 分区）。回调前本组件已写 settings-navigation 的
   *  Agents 选中记录（project:<name>，cwd = 工作区路径）——未接线时记录仍生效
   *  （AgentsConfig 打开时按 cwd 读出并预选该剧本），只是不自动跳页。 */
  onOpenAgentsSettings?: (profile: { name: string; workspacePath: string }) => void;
  /** Open one of the item's linked conversation sessions by id (locate
   * pipeline) — renders the `conversations` list as clickable entries. */
  onOpenConversation?: (sessionId: string) => void;
  /** 「打开完整管理」（M2 T10，spec §6.1）：panel 模式（右坞快捷面板）顶部
   *  入口 → 宿主的 openWorkItemsPage(wsId)——中央整页与快捷面板是同一工作项
   *  域的两个面。rail 图标单击语义不变（模块切换），入口是面板内按钮。 */
  onOpenWorkItemsPage?: (workspaceId: string, itemKey?: string) => void;
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
  ready_for_implementation: "待实现",
  release_ready: "待发布",
  released: "已发布",
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
  activeWorkspacePath,
  createWorkItemRequest,
  onConsumedCreateRequest,
  createWorkspaceOnOpen = false,
  openRepositoryFormRequest,
  selectWorkspaceRequest,
  onClose,
  onOpenWorkspace,
  onOpenWorkItemConversation,
  onRunContract,
  onRunLoopRound,
  onOpenAgentsSettings,
  onOpenConversation,
  onOpenWorkItemsPage,
  onWorkspaceDeleted,
  onWorkItemsChanged,
  onSelectedWorkspaceChange,
}: Props) {
  const [section, setSection] = useState<ManagerSection>(initialSection);
  const [workspaceData, setWorkspaceData] = useState<WorkspaceListResponse | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [selectedWorkItem, setSelectedWorkItem] = useState<WorkItemDetail | null>(null);
  const [filter, setFilter] = useState<WorkItemFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<WorkspaceCapability[]>(["repositories", "work-items"]);
  const [repositoryFormOpen, setRepositoryFormOpen] = useState(false);
  const [repositoryMode, setRepositoryMode] = useState<"clone" | "init" | "register">("clone");
  const [repositoryKind, setRepositoryKind] = useState<WorkspaceRepositoryKind>("code");
  const [repositoryAlias, setRepositoryAlias] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryRemote, setRepositoryRemote] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  // 基本信息：改名草稿（随选中工作区重置；空/未变时保存禁用）。
  const [nameDraft, setNameDraft] = useState("");
  // 列表拖拽排序（HTML5 DnD，同 SessionTabBar 模式：拖到目标上 = 插到它前面）。
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  // 详情优先模式（见 selectWorkspaceRequest effect 注释）：true = rail 收起、
  // 详情独占，「‹ 全部工作区」返回。
  const [detailFocus, setDetailFocus] = useState(false);
  // 拖拽插入指示线（2026-09，同项目树）：行上半 = 插到它前面、下半 = 插到它
  // 后面；tail = 列表尾。动画类 workspace-drop-line 在 globals.css。
  const [railDropHint, setRailDropHint] = useState<{ targetId: string | null; position: "before" | "after" } | null>(null);
  const railDropPositionOf = (event: React.DragEvent): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  };
  const [createWorkItemOpen, setCreateWorkItemOpen] = useState(false);
  // 创建表单草稿归 WorkItemCreateForm 持有（T9 抽取）；这里只留「打开时的
  // 预选类型」与 remount key（每次打开拿到干净草稿）。
  const [workItemInitialType, setWorkItemInitialType] = useState<WorkItemType>("bug");
  const [workItemCreateFormKey, setWorkItemCreateFormKey] = useState(0);
  const [contentDraft, setContentDraft] = useState("");
  const [contentEditing, setContentEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Kit loops of the selected workspace (read-only GET /loops — pure file
  // discovery + run status, no capability involved). Stores the FULL list
  // INCLUDING paused loops (T7's binding dropdown needs them — binding to a
  // paused loop is a soft no-op, S1/S5); the button gate filters via the
  // derived `hasKitLoops` below (D11: paused = not there). Fetched once per
  // selected workspace, no polling — loops are authored rarely.
  const [kitLoops, setKitLoops] = useState<Array<{
    name: string; pattern: string; level: string; cron: string;
    paused?: boolean; running?: boolean;
  }>>([]);
  // 按钮门控派生量（D11 语义不变）：存在至少一个未暂停的 kit loop。
  const hasKitLoops = kitLoops.some((loop) => !loop.paused);
  // 「立即跑一轮」多 active loop 时的手动选择（未绑定且无唯一默认时出现）。
  const [runLoopPick, setRunLoopPick] = useState("");
  // 交付自动化配置（Phase-2 Task 9；Phase-3 T5 增 developer 行；Phase-4 T5 增
  //  verification.checks 编辑器；Seam-repositioning Task 4 增角色表 + 组合预览）：
  //  `.pi/delivery.yaml` 的 GET/PUT——仅 work-items+workflows 双开的 workspaces
  //  可见（PUT 的服务端门同款）。配置结构是 delivery-runner/config.ts
  //  DeliveryRunnerConfig 的客户端镜像（v2 四键，该模块 import node:fs 不能进
  //  浏览器 bundle）。UI 编辑 enabled + 流程阶段开关（stages——review 先审后
  //  跑 / integrate 集成命令 / acceptance 验收门，final-arch step-3/4）+
  //  角色表（剧本下拉 / 模型覆写 / 状态）+ 验证命令清单；budget 只读展示。
  const [deliveryConfig, setDeliveryConfig] = useState<DeliveryRunnerConfigState | null>(null);
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  // 评审阶段开关草稿（final-arch step-3：stages.review.enabled——PUT 原样回传，
  // 否则 UI 保存会丢手设的开关）。
  const [deliveryReviewEnabled, setDeliveryReviewEnabled] = useState(false);
  // 集成阶段草稿（final-arch step-4：stages.integrate.{enabled,command}——命令
  // 输入以空串表达「未配置」；enabled 而无命令在保存前客户端拦截，文案与服务端
  // parseStages 一致）与验收门开关（stages.acceptance.enabled）。PUT 原样回传。
  const [deliveryIntegrateEnabled, setDeliveryIntegrateEnabled] = useState(false);
  const [deliveryIntegrateCommand, setDeliveryIntegrateCommand] = useState("");
  const [deliveryAcceptanceEnabled, setDeliveryAcceptanceEnabled] = useState(false);
  // 角色表剧本草稿（per-role；"" = 同名缺省，不写 roles.<role>.profile 键）。
  const [deliveryRoleProfiles, setDeliveryRoleProfiles] = useState<Record<DeliveryRole, string>>(
    EMPTY_ROLE_PROFILE_DRAFTS,
  );
  const [deliveryChecks, setDeliveryChecks] = useState<DeliveryCheckDraft[]>([]);
  const [deliverySaving, setDeliverySaving] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliverySaved, setDeliverySaved] = useState(false);
  // 角色表状态列（GET …/delivery/roles 只读投影；保存后重取——播种会落新文件）。
  const [deliveryRoleSummaries, setDeliveryRoleSummaries] = useState<DeliveryRoleSummary[] | null>(null);
  // 剧本下拉选项：`/api/subagents/profiles?cwd=<工作区路径>` 的 project 作用域名。
  const [deliveryProfileOptions, setDeliveryProfileOptions] = useState<string[]>([]);
  // 模型覆写下拉选项（ModelSelector；`/api/models?cwd=`，AgentsConfig 同款）。
  const [deliveryModelOptions, setDeliveryModelOptions] = useState<ModelSelectorOption[]>([]);
  const [deliveryModelsLoading, setDeliveryModelsLoading] = useState(true);
  // 保存成功后的播种提示（seeded.written 非空才出现；二次保存空转不显示）；
  // final-fix B：播种失败 → seeded:null + seedingError 的非阻断警告。
  const [deliverySeededNotice, setDeliverySeededNotice] = useState<string | null>(null);
  const [deliverySeedWarning, setDeliverySeedWarning] = useState<string | null>(null);
  // 「预览 prompt」抽屉：目标角色 + 投影数据（GET …/delivery/roles/[role]/preview）。
  const [deliveryPreviewRole, setDeliveryPreviewRole] = useState<DeliveryRole | null>(null);
  const [deliveryPreview, setDeliveryPreview] = useState<DeliveryRolePromptPreview | null>(null);
  const [deliveryPreviewLoading, setDeliveryPreviewLoading] = useState(false);
  // 初始化向导（final-arch step-6 Task 3，spec §13.2/§13.3）：from 同布局源目录
  // 草稿 + 检查草稿行（可编辑；运行后预填最近一次 init 响应的 suggestedChecks）
  // + 运行结果（actions 清单 + suggestedChecks 表）。POST …/delivery/init——
  // 只补缺、只建议：永不翻 enabled、永不执行命令；stages 三开关取当前表单值
  // （与保存同源）。就绪清单投影（GET …/delivery/readiness）常驻显示——无新
  // 定时器，load/保存成功/init 成功三个时机刷新（与页面既有刷新节奏同拍）。
  const [deliveryInitFrom, setDeliveryInitFrom] = useState("");
  const [deliveryInitChecks, setDeliveryInitChecks] = useState<Array<{ name: string; command: string }>>([]);
  const [deliveryInitRunning, setDeliveryInitRunning] = useState(false);
  const [deliveryInitResult, setDeliveryInitResult] = useState<DeliveryInitResponse | null>(null);
  const [deliveryInitError, setDeliveryInitError] = useState<string | null>(null);
  const [deliveryReadiness, setDeliveryReadiness] = useState<DeliveryReadinessResponse | null>(null);
  // 模板另存（漂移行按钮）：进行中的角色（防双击）+ 结果提示（成功带副本路径；
  // 409 = 副本已存在，永不覆盖）。
  const [deliveryTemplateSavingRole, setDeliveryTemplateSavingRole] = useState<DeliveryRole | null>(null);
  const [deliveryTemplateNotice, setDeliveryTemplateNotice] = useState<string | null>(null);

  const selectedWorkspace = workspaceData?.workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  ) ?? null;

  // 交付自动化配置块门控：work-items + workflows 双开（服务端 PUT 同款门，
  // spec Phase-2 Task 1；单开任一都不显示配置块）。
  const deliveryAutomationCapable = Boolean(
    selectedWorkspace
      && selectedWorkspace.capabilities.includes("work-items")
      && selectedWorkspace.capabilities.includes("workflows"),
  );

  // 改名草稿跟随选中工作区（切换/保存后刷新都同步）。
  useEffect(() => {
    setNameDraft(selectedWorkspace?.name ?? "");
  }, [selectedWorkspace?.id, selectedWorkspace?.name]);

  const openCreateWorkItem = useCallback((type?: WorkItemType) => {
    if (type) setWorkItemInitialType(type);
    setWorkItemCreateFormKey((value) => value + 1);
    setCreateWorkItemOpen(true);
  }, []);

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

  // 工作项列表数据（M2 T10，spec §6.3）：改走共享 store 的 useWorkItems——
  // 中央整页（WorkItemsPage）与本面板（右坞快捷面板/设置页）同一缓存、同一
  // 轮询器（per-workspace 单例）；mutation 一律 invalidate()，两面即时互见。
  // 归档池合并进列表（快照 items=活动、archivedItems=归档），「查看归档」
  // 开关按 archivedAt 过滤——旧本地拉取只取 items，归档开关恒空（本切换顺
  // 带修复）。选中项的失效清理由快照 effect 承担（见下）。
  const workItemsWorkspaceId = (open || embedded)
    && selectedWorkspace
    && selectedWorkspace.capabilities.includes("work-items")
    ? selectedWorkspace.id
    : null;
  const {
    snapshot: workItemsSnapshot,
    loading: itemsLoading,
    error: workItemsError,
    invalidate: invalidateWorkItems,
  } = useWorkItems(workItemsWorkspaceId);
  const workItemItems = useMemo(
    () => [
      ...(workItemsSnapshot?.items ?? []),
      ...(workItemsSnapshot?.archivedItems ?? []),
    ],
    [workItemsSnapshot],
  );
  const workItemInvalid = workItemsSnapshot?.invalid ?? [];
  // 快照更新时清理已消失的选中项（旧 loadWorkItems 的清理语义收编；归档项
  // 仍在活动∪归档池里，详情不因归档被踢回列表——与中央页一致）。
  // null 快照短路（fix round 1 Critical）：invalidate() 先 clearSnapshot，
  // 订阅者会同步收到 null——此刻池为 [] 是「数据暂缺」不是「项已消失」，
  // 若照跑清理会把 mutation 刚 set 的 selectedWorkItem 清空（详情被关）。
  // 清理只在真实快照上判定。
  useEffect(() => {
    if (!workItemsSnapshot) return;
    setSelectedWorkItem((current) => (
      current && workItemItems.some((item) => item.key === current.item.key) ? current : null
    ));
  }, [workItemsSnapshot, workItemItems]);

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
    }
  }, []);

  useEffect(() => {
    if (!open && !embedded) return;
    setSection(initialSection);
    void loadWorkspaces();
  }, [embedded, initialSection, loadWorkspaces, open]);

  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspaceId) {
      setRepositories([]);
      return;
    }
    if (selectedWorkspace?.capabilities.includes("repositories")) {
      void loadRepositories(selectedWorkspaceId);
    } else {
      setRepositories([]);
    }
  }, [
    embedded,
    loadRepositories,
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

  // Kit-declared loops of the selected workspace (read-only GET /loops —
  // pure file discovery, no capability involved). Stores the full list
  // (incl. paused); the 开始对话/收养续跑 button gate derives from it
  // (`hasKitLoops` = some(!paused)); failure or offline → no loops (buttons hidden).
  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspaceId) {
      setKitLoops([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/loops`)
      .then(async (response) => {
        if (!response.ok) return { loops: [] as Array<{ name: string; pattern: string; level: string; cron: string; paused?: boolean; running?: boolean }> };
        return response.json() as Promise<{ loops?: Array<{ name: string; pattern: string; level: string; cron: string; paused?: boolean; running?: boolean }> }>;
      })
      .then((data) => {
        if (!cancelled) setKitLoops(data.loops ?? []);
      })
      .catch(() => {
        if (!cancelled) setKitLoops([]);
      });
    return () => {
      cancelled = true;
    };
  }, [embedded, open, selectedWorkspaceId]);

  // 交付自动化配置加载（Phase-2 Task 9；Task 4 增角色表投影）：GET /delivery →
  // 播种 enabled / 四角色 profile 草稿（budget 只读不进草稿）。门控 = 面板
  // 打开 + 双 capability；切换工作区/门控失效即清空。运行态 advisory——加载
  // 失败只降级为块内提示，不打断设置页其它分区。
  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspaceId || !deliveryAutomationCapable) {
      setDeliveryConfig(null);
      setDeliveryReviewEnabled(false);
      setDeliveryIntegrateEnabled(false);
      setDeliveryIntegrateCommand("");
      setDeliveryAcceptanceEnabled(false);
      setDeliveryRoleProfiles(EMPTY_ROLE_PROFILE_DRAFTS);
      setDeliveryChecks([]);
      setDeliveryError(null);
      setDeliverySaved(false);
      setDeliverySeededNotice(null);
      setDeliverySeedWarning(null);
      setDeliveryInitFrom("");
      setDeliveryInitChecks([]);
      setDeliveryInitResult(null);
      setDeliveryInitError(null);
      setDeliveryReadiness(null);
      setDeliveryTemplateNotice(null);
      return;
    }
    let cancelled = false;
    setDeliveryError(null);
    setDeliverySaved(false);
    setDeliverySeededNotice(null);
    setDeliverySeedWarning(null);
    void fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/delivery`)
      .then(async (response) => {
        const fallback = { error: `HTTP ${response.status}` };
        if (!response.ok) return fallback as { config?: DeliveryRunnerConfigState; error?: string };
        return (await response.json()) as { config?: DeliveryRunnerConfigState; error?: string };
      })
      .then((data) => {
        if (cancelled) return;
        // 非 2xx（上面的 fallback 携带 {error:"HTTP <status>"}；服务端错误体
        // 也可能带 error，如 .pi/delivery.yaml 损坏 → 400）必须走错误分支——
        // 静默播种默认表单会让随后的保存把默认值 PUT 覆盖到真实/损坏的配置上。
        // 同时清 deliveryConfig，防止沿用上一工作区的旧配置误写到当前 id。
        if (data.error) {
          setDeliveryConfig(null);
          setDeliveryError(String(data.error));
          return;
        }
        // 干净 200 + {config:null} 是 Task 1 的明确契约（.pi/delivery.yaml
        // 缺失 = 默认 disabled），按默认镜像播种表单——config:null 不是错误。
        const config = data.config ?? DEFAULT_DELIVERY_RUNNER_CONFIG;
        setDeliveryConfig(config);
        setDeliveryEnabled(config.enabled);
        // 评审/集成/验收阶段开关（final-arch step-3/4）：服务端 parse 后 stages
        // 必有——缺块回填三开关全关，这里直读；integrate.command 缺省映射空串。
        setDeliveryReviewEnabled(config.stages.review.enabled);
        setDeliveryIntegrateEnabled(config.stages.integrate.enabled);
        setDeliveryIntegrateCommand(config.stages.integrate.command ?? "");
        setDeliveryAcceptanceEnabled(config.stages.acceptance.enabled);
        setDeliveryRoleProfiles({
          designer: config.roles.designer?.profile ?? "",
          developer: config.roles.developer?.profile ?? "",
          reviewer: config.roles.reviewer?.profile ?? "",
          "release-preparer": config.roles["release-preparer"]?.profile ?? "",
        });
        setDeliveryChecks(checksDraftFromConfig(config));
      })
      .catch(() => {
        if (!cancelled) setDeliveryError("交付自动化配置加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [deliveryAutomationCapable, embedded, open, selectedWorkspaceId]);

  // 角色表状态列（Task 4）：GET /delivery/roles 只读投影——存在/缺失、播种
  // 标记（模板 vN）、有效模型与来源。保存成功后重取（播种会落新文件）。
  // 失败静默降级（状态列显示占位），不打断配置块。
  const loadDeliveryRoleSummaries = useCallback(async (workspaceId: string) => {
    try {
      const data = await responseJson<DeliveryRolesResponse>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/delivery/roles`),
      );
      setDeliveryRoleSummaries(data.roles);
    } catch {
      setDeliveryRoleSummaries(null);
    }
  }, []);

  // 就绪清单（final-arch step-6 Task 3）：GET /delivery/readiness 只读投影——
  // 常驻显示，非门禁；响应带 currentTemplateVersion（角色表漂移提示的对照值）。
  // 无新定时器：与角色摘要同一组时机刷新（load / 保存成功 / init 成功）。
  const loadDeliveryReadiness = useCallback(async (workspaceId: string) => {
    try {
      const data = await responseJson<DeliveryReadinessResponse>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/delivery/readiness`),
      );
      setDeliveryReadiness(data);
    } catch {
      setDeliveryReadiness(null);
    }
  }, []);

  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspaceId || !deliveryAutomationCapable) {
      setDeliveryRoleSummaries(null);
      setDeliveryReadiness(null);
      setDeliveryProfileOptions([]);
      return;
    }
    void loadDeliveryRoleSummaries(selectedWorkspaceId);
    void loadDeliveryReadiness(selectedWorkspaceId);
  }, [deliveryAutomationCapable, embedded, loadDeliveryReadiness, loadDeliveryRoleSummaries, open, selectedWorkspaceId]);

  // 剧本下拉选项（Task 4）：`/api/subagents/profiles?cwd=<工作区路径>` 过滤
  // scope === "project"（.pi/agents 是交付剧本唯一合法作用域——别名剧本必须
  // 住工作区）。失败静默降级（下拉只剩同名缺省项）。
  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspace?.path || !deliveryAutomationCapable) {
      setDeliveryProfileOptions([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(selectedWorkspace.path)}`)
      .then(async (response) => {
        if (!response.ok) return { profiles: [] as Array<{ name: string; scope: string }> };
        return (await response.json()) as { profiles?: Array<{ name: string; scope: string }> };
      })
      .then((data) => {
        if (!cancelled) {
          setDeliveryProfileOptions(
            (data.profiles ?? [])
              .filter((profile) => profile.scope === "project")
              .map((profile) => profile.name),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setDeliveryProfileOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [deliveryAutomationCapable, embedded, open, selectedWorkspace]);

  // 模型覆写选项（Task 4）：`/api/models?cwd=`（AgentsConfig 同款）→
  // ModelSelector；失败/离线 → 空选项（下拉禁用，占位仍显示摘要的有效模型）。
  useEffect(() => {
    if ((!open && !embedded) || !selectedWorkspace?.path || !deliveryAutomationCapable) {
      setDeliveryModelOptions([]);
      setDeliveryModelsLoading(false);
      return;
    }
    let cancelled = false;
    setDeliveryModelsLoading(true);
    void fetch(`/api/models?cwd=${encodeURIComponent(selectedWorkspace.path)}`)
      .then(async (response) => {
        if (!response.ok) return { modelList: [] as Array<{ id: string; name: string; provider: string }> };
        return (await response.json()) as { modelList?: Array<{ id: string; name: string; provider: string }>; modelError?: string };
      })
      .then((data) => {
        if (cancelled) return;
        setDeliveryModelOptions(
          (data.modelList ?? []).map((model) => ({
            provider: model.provider,
            modelId: model.id,
            name: model.name,
          })),
        );
        setDeliveryModelsLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setDeliveryModelOptions([]);
          setDeliveryModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deliveryAutomationCapable, embedded, open, selectedWorkspace]);

  useEffect(() => {
    if ((!open && !embedded) || !createWorkItemRequest) return;
    setSection("work-items");
    openCreateWorkItem(createWorkItemRequest.type);
    // 消费即清（fix round 1 Important）：表单已开，清掉宿主侧 nonce——
    // 防换工作区重挂载（key 变化）时残留请求再次自启表单。宿主清成 null
    // 会再触发本 effect 一次，被首行守卫短路（no-op）。
    onConsumedCreateRequest?.();
  }, [createWorkItemRequest, embedded, open, openCreateWorkItem, onConsumedCreateRequest]);

  // Work-item detail split (desktop): report selection changes up (the
  // right-column header + shell mirror), and honor the right column's ×
  // (request counter — clearing here unmounts the portaled detail).

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

  // 深链预选（已停用工作区的重启用路径）：请求到达且列表数据包含该 id 时
  // 选中它并回到 workspaces 分区。数据通常晚于请求到达（面板刚挂载），所以
  // workspaceData 也在依赖里——落地即触发。
  // 详情优先（detailFocus，2026-09 反馈）：带工作区上下文点「设置」（树 ⚙ /
  // 总览「工作区设置」/ 工作区菜单行）时用户只关心 THAT workspace——rail
  // （全部工作区列表）收起，详情独占 +「‹ 全部工作区」返回；不带上下文的
  // 设置页入口（底部设置）仍落到全局列表。
  useEffect(() => {
    if ((!open && !embedded) || !selectWorkspaceRequest) return;
    if (!workspaceData?.workspaces.some((workspace) => workspace.id === selectWorkspaceRequest.id)) return;
    setSection("workspaces");
    setSelectedWorkspaceId(selectWorkspaceRequest.id);
    setSelectedWorkItem(null);
    setDetailFocus(true);
  }, [embedded, open, selectWorkspaceRequest, workspaceData]);

  const visibleWorkItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return workItemItems.filter((item) => {
      if (showArchived !== Boolean(item.archivedAt)) return false;
      if (filter !== "all" && item.type !== filter) return false;
      if (!normalizedQuery) return true;
      return item.key.toLowerCase().includes(normalizedQuery)
        || item.title.toLowerCase().includes(normalizedQuery)
        || item.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));
    });
  }, [filter, query, showArchived, workItemItems]);

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
            ...(repositoryPath.trim() ? { path: repositoryPath.trim() } : {}),
            ...(repositoryRemote.trim() ? { remote: repositoryRemote.trim() } : {}),
          }),
        }),
      );
      setRepositoryFormOpen(false);
      setRepositoryAlias("");
      setRepositoryName("");
      setRepositoryRemote("");
      setRepositoryPath("");
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
    repositoryPath,
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

  /** 保存交付自动化配置（Phase-2 Task 9；T5 增 developer；Phase-4 T5 增
   *  verification.checks；Task 4 增角色表 + 播种提示；final-arch step-3 增
   *  评审阶段开关；final-arch step-4 增集成命令与验收门）：PUT /delivery 全量
   *  config（v2）——UI 编辑 enabled + stages 三开关（review 先审后跑 /
   *  integrate 集成命令 / acceptance 验收门）+ 角色表（剧本下拉草稿）+ 验证
   *  命令清单，budget 与未触碰角色的既有 profile/model 原样回传（round-trip
   *  保真）。checks 草稿行内校验（名称/命令必填、timeout 整数 1–3600）与
   *  integrate 开启而命令空白（文案与服务端 parseStages 一致）失败 → 块内
   *  错误提示且不发 PUT。成功以响应回填（服务端 parse 后的规范化值），「已
   *  保存」内联提示；保存成功即重取角色摘要（模型覆写/别名切换也改投影），
   *  响应 seeded.written 非空才加「已播种 N 份剧本到 .pi/agents/」提示；失败
   *  （含 capability 门 400）走块内错误提示。 */
  const saveDeliveryConfig = useCallback(async () => {
    if (!selectedWorkspaceId || !deliveryConfig) return;
    setDeliveryError(null);
    setDeliverySaved(false);
    setDeliverySeededNotice(null);
    // 集成阶段客户端守卫（final-arch step-4）：enabled 而命令空白 → 拦截不发
    // PUT（服务端 parseStages 同款文案；提前拦省一次 400 往返）。
    if (deliveryIntegrateEnabled && !deliveryIntegrateCommand.trim()) {
      setDeliveryError("stages.integrate.command is required when integrate is enabled");
      return;
    }
    const checksResult = checksPayload(deliveryChecks);
    if ("error" in checksResult) {
      setDeliveryError(checksResult.error);
      return;
    }
    const verification = checksResult.checks !== undefined ? { checks: checksResult.checks } : undefined;
    setDeliverySaving(true);
    try {
      // 角色 round-trip 习语（四键同形）：profile 草稿 + 既有 model 覆写合并；
      // 两者皆空 → 该角色键整体剥掉（不写空对象）。未触碰角色的 profile/model
      // 从 GET 到 PUT 原样回传（草稿由加载/上次保存播种，字节保真）。
      const rolePayload = (
        profile: string,
        existing?: DeliveryRoleConfigState,
      ): DeliveryRoleConfigState | undefined =>
        (profile || existing?.model)
          ? {
            ...(profile ? { profile } : {}),
            ...(existing?.model ? { model: existing.model } : {}),
          }
          : undefined;
      const roles: Partial<Record<DeliveryRole, DeliveryRoleConfigState>> = {};
      for (const role of DELIVERY_ROLES) {
        const entry = rolePayload(deliveryRoleProfiles[role].trim(), deliveryConfig.roles[role]);
        if (entry) roles[role] = entry;
      }
      const data = await responseJson<{
        config: DeliveryRunnerConfigState;
        /** final-fix B：播种失败降级 null + seedingError（配置已保存）。 */
        seeded: { written: string[] } | null;
        seedingError?: string;
      }>(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/delivery`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 2,
            enabled: deliveryEnabled,
            roles,
            budget: deliveryConfig.budget,
            // attention 阈值原样回传（backlog-clearing T2）：不带 attention 的
            // PUT 被服务端 parseAttention 打回缺省 3/7——手设 nudge/park 即丢。
            attention: deliveryConfig.attention,
            // stages 三开关原样回传（final-arch step-3/4）：不带 stages 的 PUT
            // 会把手设的开关打回缺省 false——save 即丢失。integrate.command
            // 关闭时也保留（服务端同款语义——回开免重写）。
            stages: {
              review: { enabled: deliveryReviewEnabled },
              integrate: {
                enabled: deliveryIntegrateEnabled,
                ...(deliveryIntegrateCommand.trim()
                  ? { command: deliveryIntegrateCommand.trim() }
                  : {}),
              },
              acceptance: { enabled: deliveryAcceptanceEnabled },
            },
            ...(verification ? { verification } : {}),
          }),
        }),
      );
      setDeliveryConfig(data.config);
      setDeliveryEnabled(data.config.enabled);
      setDeliveryReviewEnabled(data.config.stages.review.enabled);
      setDeliveryIntegrateEnabled(data.config.stages.integrate.enabled);
      setDeliveryIntegrateCommand(data.config.stages.integrate.command ?? "");
      setDeliveryAcceptanceEnabled(data.config.stages.acceptance.enabled);
      setDeliveryRoleProfiles({
        designer: data.config.roles.designer?.profile ?? "",
        developer: data.config.roles.developer?.profile ?? "",
        reviewer: data.config.roles.reviewer?.profile ?? "",
        "release-preparer": data.config.roles["release-preparer"]?.profile ?? "",
      });
      setDeliveryChecks(checksDraftFromConfig(data.config));
      setDeliverySaved(true);
      // 播种提示（Task 3 契约；final-fix B null 防御）：seeded.written 非空
      // （首次保存 / 新角色剧本）才显示；二次保存全 skipped 不显示；播种失败
      // → seeded:null + seedingError——配置已落盘，只出非阻断警告不报错。
      if (data.seeded && data.seeded.written.length > 0) {
        setDeliverySeededNotice(`已播种 ${data.seeded.written.length} 份剧本到 .pi/agents/`);
      }
      if (data.seedingError) {
        setDeliverySeedWarning(`剧本播种失败：${data.seedingError}（配置已保存）`);
      }
      // 保存成功即重取角色摘要（不只播种——清模型覆写 / 切别名同样改投影：
      // 状态列与模型占位立刻跟随新配置；review fix round 1：从播种分支提出）。
      void loadDeliveryRoleSummaries(selectedWorkspaceId);
      // 就绪清单同步跟随（final-arch step-6 Task 3）：保存可能补 checks /
      // 剧本——缺项投影立即收敛。
      void loadDeliveryReadiness(selectedWorkspaceId);
    } catch (saveDeliveryError) {
      setDeliveryError(saveDeliveryError instanceof Error ? saveDeliveryError.message : String(saveDeliveryError));
    } finally {
      setDeliverySaving(false);
    }
  }, [deliveryAcceptanceEnabled, deliveryChecks, deliveryConfig, deliveryEnabled, deliveryIntegrateCommand, deliveryIntegrateEnabled, deliveryReviewEnabled, deliveryRoleProfiles, loadDeliveryReadiness, loadDeliveryRoleSummaries, selectedWorkspaceId]);

  /** 角色表「预览 prompt」（Task 4）：GET …/delivery/roles/[role]/preview →
   *  抽屉三段（AGENTS.md 折叠 / 不变式锁定段 / 剧本正文）；composed 与 launch
   *  同一函数产出。失败只提示不占位。 */
  const openDeliveryPreview = useCallback(async (role: DeliveryRole) => {
    if (!selectedWorkspaceId) return;
    setDeliveryPreviewRole(role);
    setDeliveryPreview(null);
    setDeliveryPreviewLoading(true);
    try {
      const data = await responseJson<DeliveryRolePreviewResponse>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/delivery/roles/${encodeURIComponent(role)}/preview`,
        ),
      );
      setDeliveryPreview(data.preview);
    } catch (previewError) {
      setDeliveryError(previewError instanceof Error ? previewError.message : String(previewError));
      setDeliveryPreviewRole(null);
    } finally {
      setDeliveryPreviewLoading(false);
    }
  }, [selectedWorkspaceId]);

  /** 角色表「编辑剧本」（Task 4）：写 settings-navigation 的 Agents 选中记录
   *  （project:<name>，cwd = 工作区路径——AgentsConfig 打开该工作区时读出并
   *  预选）+ 分区记忆，再请宿主切到设置 › Agents（onOpenAgentsSettings 未
   *  接线时只完成记录，不自动跳页）。 */
  const editRoleProfile = useCallback((role: DeliveryRole) => {
    const profileName = deliveryRoleProfiles[role].trim() || role;
    if (!selectedWorkspace) return;
    setLastSettingsSelection("agents", `project:${profileName}`, selectedWorkspace.path);
    setLastSettingsSection("agents");
    onOpenAgentsSettings?.({ name: profileName, workspacePath: selectedWorkspace.path });
  }, [deliveryRoleProfiles, onOpenAgentsSettings, selectedWorkspace]);

  /** 「运行初始化」（final-arch step-6 Task 3，spec §13.2/§13.3）：POST
   *  …/delivery/init——from 目录 + 检查草稿（空行丢弃、半行客户端拦截）+
   *  stages 三开关取当前表单值（与保存同源）。响应 actions 清单 +
   *  suggestedChecks 草稿渲染待确认；草稿跟随最近一次响应预填；init 可能播种
   *  剧本/写默认配置——就绪清单与角色摘要立即跟随。 */
  const runDeliveryInit = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    setDeliveryInitError(null);
    // 集成开启而命令空白：与服务端 parseDeliveryRunnerConfig 同拒（提前拦省一次 400）。
    if (deliveryIntegrateEnabled && !deliveryIntegrateCommand.trim()) {
      setDeliveryInitError("stages.integrate.command is required when integrate is enabled");
      return;
    }
    const checks: Array<{ name: string; command: string }> = [];
    for (const [index, row] of deliveryInitChecks.entries()) {
      const name = row.name.trim();
      const command = row.command.trim();
      if (!name && !command) continue; // 空行丢弃
      if (!name || !command) {
        setDeliveryInitError(`初始化检查草稿第 ${index + 1} 行：名称与命令必填。`);
        return;
      }
      checks.push({ name, command });
    }
    setDeliveryInitRunning(true);
    try {
      const data = await responseJson<DeliveryInitResponse>(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/delivery/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(deliveryInitFrom.trim() ? { from: deliveryInitFrom.trim() } : {}),
            ...(checks.length > 0 ? { checks } : {}),
            stagesReview: deliveryReviewEnabled,
            integrate: {
              enabled: deliveryIntegrateEnabled,
              ...(deliveryIntegrateCommand.trim()
                ? { command: deliveryIntegrateCommand.trim() }
                : {}),
            },
            acceptance: { enabled: deliveryAcceptanceEnabled },
          }),
        }),
      );
      setDeliveryInitResult(data);
      // 草稿预填跟随最近一次 init 响应的 suggestedChecks（可编辑、不自动保存）。
      setDeliveryInitChecks(
        (data.suggestedChecks ?? []).map((check) => ({ name: check.name, command: check.command })),
      );
      void loadDeliveryReadiness(selectedWorkspaceId);
      void loadDeliveryRoleSummaries(selectedWorkspaceId);
    } catch (initError) {
      setDeliveryInitError(initError instanceof Error ? initError.message : String(initError));
    } finally {
      setDeliveryInitRunning(false);
    }
  }, [
    deliveryAcceptanceEnabled,
    deliveryInitChecks,
    deliveryInitFrom,
    deliveryIntegrateCommand,
    deliveryIntegrateEnabled,
    deliveryReviewEnabled,
    loadDeliveryReadiness,
    loadDeliveryRoleSummaries,
    selectedWorkspaceId,
  ]);

  /** 「采用为验证命令」（final-arch step-6 Task 3）：把 init 响应的
   *  suggestedChecks 复制进 checks 编辑器（追加，不覆盖已填行）——只是草稿，
   *  不自动保存；repositoryId 跟随（探测草稿带仓绑定），timeout 留空 = 服务端
   *  缺省 600s。 */
  const adoptSuggestedChecks = useCallback((suggested: DeliverySuggestedCheck[]) => {
    setDeliveryChecks((current) => [
      ...current,
      ...suggested.map((check) => ({
        name: check.name,
        repositoryId: check.repositoryId ?? "",
        command: check.command,
        timeout: "",
      })),
    ]);
    setDeliverySaved(false);
  }, []);

  /** 「另存新模板」（final-arch step-6 Task 3）：POST …/delivery/roles/[role]/
   *  template——把当前内置模板写到 <role>.template.md。成功 toast 带副本路径；
   *  409（副本已存在）按 brief 文案提示，永不覆盖。 */
  const saveRoleTemplateCopy = useCallback(async (role: DeliveryRole) => {
    if (!selectedWorkspaceId) return;
    setDeliveryTemplateNotice(null);
    setDeliveryTemplateSavingRole(role);
    try {
      const data = await responseJson<{ path: string }>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/delivery/roles/${encodeURIComponent(role)}/template`,
          { method: "POST" },
        ),
      );
      setDeliveryTemplateNotice(`已另存新模板副本：${data.path}`);
    } catch (templateError) {
      if (templateError instanceof Error && "status" in templateError && templateError.status === 409) {
        setDeliveryTemplateNotice(`副本已存在（${role}.template.md）——不覆盖既有副本`);
      } else {
        setDeliveryTemplateNotice(
          `另存失败：${templateError instanceof Error ? templateError.message : String(templateError)}`,
        );
      }
    } finally {
      setDeliveryTemplateSavingRole(null);
    }
  }, [selectedWorkspaceId]);

  const saveWorkspaceName = useCallback(async () => {
    if (!selectedWorkspace) return;
    const name = nameDraft.trim();
    if (!name || name === selectedWorkspace.name) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspace.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: selectedWorkspace.updatedAt,
            name,
          }),
        }),
      );
      await loadWorkspaces();
    } catch (saveNameError) {
      setError(saveNameError instanceof Error ? saveNameError.message : String(saveNameError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkspaces, nameDraft, selectedWorkspace]);

  const setWorkspaceDisabled = useCallback(async (disabled: boolean) => {
    if (!selectedWorkspace || selectedWorkspace.disabled === disabled) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspace.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: selectedWorkspace.updatedAt,
            disabled,
          }),
        }),
      );
      await loadWorkspaces();
    } catch (disableError) {
      setError(disableError instanceof Error ? disableError.message : String(disableError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkspaces, selectedWorkspace]);

  const saveWorkspaceOrder = useCallback(async (ids: string[]) => {
    setSaving(true);
    setError(null);
    try {
      // 全量期望序一次提交（服务端重编 sortOrder，只写全局索引，不碰各
      // manifest —— 不会给工作区 git 产生提交）。
      await responseJson(
        await fetch("/api/workspaces", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: ids }),
        }),
      );
      await loadWorkspaces();
    } catch (orderError) {
      setError(orderError instanceof Error ? orderError.message : String(orderError));
    } finally {
      setSaving(false);
    }
  }, [loadWorkspaces]);

  const createWorkItem = useCallback(async (values: WorkItemCreateFormValues) => {
    if (!selectedWorkspaceId) return;
    setSaving(true);
    setError(null);
    try {
      let detail = await responseJson<WorkItemDetail & { importOutcome?: WorkItemImportOutcome }>(
        await fetch(`/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/work-items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: values.type,
            title: values.title,
            originalDescription: values.originalDescription,
            priority: values.priority,
            repositories: values.repositories,
            enableDelivery: values.enableDelivery,
          }),
        }),
      );
      if (detail.importOutcome && detail.importOutcome !== "created") {
        // 导入去重（spec §8.1）：同 source+sourceId 已存在（含回收站墓碑）——
        // 服务端原样返回既有项、未重复创建，不当作新建成功。回收站项不打开
        // 详情（其路径在 .pi/trash 下，详情面板后续操作会 404），仅提示。
        setCreateWorkItemOpen(false);
        if (detail.importOutcome === "existing") {
          setSelectedWorkItem(detail);
          setContentDraft(detail.content);
        }
        invalidateWorkItems();
        onWorkItemsChanged?.();
        setError(
          detail.importOutcome === "existing_trashed"
            ? `同来源工作项 ${detail.item.key} 已在回收站，未重复创建`
            : `同来源工作项 ${detail.item.key} 已存在，未重复创建`,
        );
        return;
      }
      if (values.files.length > 0) {
        // 附件上到刚建的工作项下（attachments/ + README 引用）。失败不静默丢：
        // 工作项已创建——报错并保留它，附件可后续在工作台·文件里补传。
        try {
          detail = await uploadWorkItemAttachments(selectedWorkspaceId, detail.item.key, values.files);
        } catch (attachmentError) {
          setError(
            `工作项 ${detail.item.key} 已创建，但附件上传失败：${attachmentError instanceof Error ? attachmentError.message : String(attachmentError)}`,
          );
        }
      }
      setCreateWorkItemOpen(false);
      setSelectedWorkItem(detail);
      setContentDraft(detail.content);
      invalidateWorkItems();
      onWorkItemsChanged?.();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }, [
    invalidateWorkItems,
    selectedWorkspaceId,
    onWorkItemsChanged,
  ]);

  /** 「按合同执行」/「收养续跑」（D11 客户端预填）：onRunContract 写入新会话
   *  composer 草稿并切到该 workspace 的 chat 视图（预填不会失败）；这里仅
   *  刷新详情，保持列表/详情一致（无新会话产生——.jsonl 到首条消息才建）。 */
  const runContract = useCallback(async (mode: "execute" | "adopt") => {
    if (!selectedWorkspace || !selectedWorkItem || !onRunContract) return;
    setSaving(true);
    setError(null);
    try {
      await onRunContract(selectedWorkspace, selectedWorkItem.item, mode);
      if (selectedWorkspaceId) {
        const detail = await responseJson<WorkItemDetail>(
          await fetch(
            `/api/workspaces/${encodeURIComponent(selectedWorkspaceId)}/work-items/${encodeURIComponent(selectedWorkItem.item.key)}`,
          ),
        );
        setSelectedWorkItem(detail);
        setContentDraft(detail.content);
        invalidateWorkItems();
        onWorkItemsChanged?.();
      }
    } catch (contractError) {
      setError(contractError instanceof Error ? contractError.message : String(contractError));
    } finally {
      setSaving(false);
    }
  }, [invalidateWorkItems, onRunContract, onWorkItemsChanged, selectedWorkspace, selectedWorkspaceId, selectedWorkItem]);

  // T7: `loop` rides the explicit intersection arm (string | null — null
  // clears the binding); putting it in the Pick too would intersect away
  // the null arm and break `patchWorkItem({ loop: value || null })`.
  const patchWorkItem = useCallback(async (
    patch: Partial<Pick<WorkItemRecord, "status" | "phase" | "priority" | "title" | "repositories">>
      & { archived?: boolean; loop?: string | null },
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
      invalidateWorkItems();
      onWorkItemsChanged?.();
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
    } finally {
      setSaving(false);
    }
  }, [invalidateWorkItems, onWorkItemsChanged, selectedWorkItem, selectedWorkspaceId]);

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
      invalidateWorkItems();
      onWorkItemsChanged?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [contentDraft, invalidateWorkItems, onWorkItemsChanged, selectedWorkItem, selectedWorkspaceId]);

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
      invalidateWorkItems();
      onWorkItemsChanged?.();
    } catch (trashError) {
      setError(trashError instanceof Error ? trashError.message : String(trashError));
    } finally {
      setSaving(false);
    }
  }, [invalidateWorkItems, onWorkItemsChanged, selectedWorkItem, selectedWorkspaceId]);

  if (!open && !embedded) return null;

  const splitMode = split != null;
  const portalTarget = split != null && "portalTarget" in split ? split.portalTarget : null;
  const inlineSplit = split != null && "inline" in split;

  // Shared narrow-layout compaction (single-column form grids, wrapping
  // toolbars, phase-badge-hidden work-item meta line, stacked detail header).
  // Used by BOTH the mobile media query and — in `panel` mode — a container
  // query, because the desktop middle column is drag-resizable (200–560px) while the full
  // work-item grid alone needs ~410px.
  const compactStyles = `
          .workspace-form-grid { grid-template-columns: 1fr; }
          .repository-row { grid-template-columns: minmax(0, 1fr) auto; }
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
          .work-item-row .work-item-badge + .work-item-badge { display: none; }
          .work-item-fields { display: grid; grid-template-columns: 1fr 1fr; }
          .workspace-field-compact select { min-width: 0; }
          .work-item-event { grid-template-columns: 92px 1fr auto; }
          /* Detail header is two explicit rows (actions / title) — compact only
             shrinks the title; buttons already wrap inside their row. */
          .work-item-detail-header h2 { font-size: 15px; }
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
          position: relative;
          transition: opacity 0.15s ease;
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
          cursor: grab;
        }
        .workspace-rail-item:active {
          cursor: grabbing;
        }
        .workspace-rail-item:disabled {
          cursor: default;
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
          grid-template-columns: minmax(0, 1fr);
          gap: 5px;
          width: 100%;
          border: 1px solid var(--border);
          border-radius: 9px;
          background: var(--bg);
          color: var(--text);
          padding: 9px 12px;
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
        .work-item-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
        .work-item-meta time { margin-left: auto; color: var(--text-dim); font-size: 10px; white-space: nowrap; }
        .work-item-badge {
          display: inline-flex;
          justify-content: center;
          border-radius: 999px;
          background: var(--bg-panel);
          color: var(--text-muted);
          padding: 3px 7px;
          font-size: 10px;
        }
        /* Detail header: two rows (2026-09 feedback) — row 1 = action buttons,
           row 2 = key + title. Buttons wrap within their own row so any button
           count stays readable. */
        .work-item-detail-header { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 14px; }
        .work-item-detail-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
        .work-item-detail-actions > .workspace-action { flex: 0 0 auto; white-space: nowrap; }
        .work-item-detail-title { min-width: 0; }
        .work-item-detail-header h2 { margin: 2px 0 0; font-size: 20px; overflow-wrap: anywhere; }
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
        .work-item-event { display: grid; grid-template-columns: 120px 1fr auto; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 11px; align-items: start; }
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
           Workspaces tab was a dead-end in this context.
           RAIL EXCEPTION（2026-09 修复）: the rail (all-workspaces LIST) stays
           hidden only for the work-items hosts（右坞/移动工作项 subpage — they
           are scoped to ONE workspace, a list there is a dead end）. When the
           section IS "workspaces"（设置›工作区 subpage — the ONLY surface where
           hidden/disabled workspaces can be selected & re-enabled）the rail
           must stay reachable at EVERY panel width: it used to rely solely on
           the (max-width: 640px) media query below, so phone portrait got the
           stacked list but any wider mobile viewport（横屏/平板/折叠屏 ≥768px
           side-rail / 「电脑版网站」~980px）rendered ONLY the auto-selected
           workspace's detail — the all-workspaces list "wouldn't open" and
           disabled workspaces became unmanageable. Same stacked treatment the
           phone media query applies, emitted here unconditionally. */
        .workspace-manager-page { container-type: inline-size; }
        .workspace-manager-header { display: none; }
        .workspace-manager-body { grid-template-columns: minmax(0, 1fr); ${section === "workspaces" ? "display: block; overflow: auto;" : ""} }
        .workspace-rail { ${section === "workspaces" ? "display: block; height: auto; border-right: 0; border-bottom: 1px solid var(--border);" : "display: none;"} }
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
  // contexts the detail replaces the list in place (右坞 S3 起，工作项宿主全部
  // 是 panel/embedded 推导航——workItemSplit portal 机制已随 S3 退役)。
  // T7: bound kit-loop NAME for the detail 「Loop」 row ("" = 未绑定). Hoisted
  // so the 未生效 badge check narrows cleanly (item.loop is optional).
  const boundLoopName = selectedWorkItem?.item.loop ?? "";
  const workItemDetailPane = selectedWorkItem && selectedWorkspace ? (
    <div className="work-item-detail-card">
                  {/* 两行结构（2026-09 反馈）：第一排 = 按钮区，第二排 = 编号 + 标题。 */}
                  <div className="work-item-detail-header">
                    <div className="work-item-detail-actions">
                    <button className="workspace-action" onClick={() => setSelectedWorkItem(null)}>← 返回</button>
                    {selectedWorkItem.item.status !== "done" && selectedWorkItem.item.status !== "cancelled" && selectedWorkItem.item.phase !== "complete" && selectedWorkItem.events.length > 0
                      && [...selectedWorkItem.events].reverse().find((event) => event.type === "loop.gate" || event.type.startsWith("loop."))?.type === "loop.gate" && (
                      <span
                        style={{ padding: "2px 8px", borderRadius: 5, background: "rgba(245,158,11,0.15)", color: "#b45309", fontSize: 12, fontWeight: 700 }}
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
                    {/* B 面「立即跑一轮」：独立于 conversations 是否为空，仅要求
                        同样的 phase/status gate（Task 9）。命中绑定或单 active
                        loop → 单按钮（默认名）；未绑定多 active loop →
                        select+按钮。前一个兄弟按钮已携带 marginLeft:auto，
                        不重复加（两个 auto 会在按钮组中间豁出空隙）。 */}
                    {onRunLoopRound && hasKitLoops && selectedWorkItem.item.phase !== "complete" && selectedWorkItem.item.status !== "done" && selectedWorkItem.item.status !== "cancelled" && (() => {
                      const activeKitLoops = kitLoops.filter((l) => !l.paused); // kitLoops 存全量（Task 3）
                      const boundLoopName = selectedWorkItem.item.loop;
                      const defaultLoop = activeKitLoops.find((l) => l.name === boundLoopName)
                        ?? (activeKitLoops.length === 1 ? activeKitLoops[0] : undefined);
                      if (defaultLoop) {
                        return (
                          <button
                            className="workspace-action"
                            disabled={saving}
                            onClick={() => void onRunLoopRound(selectedWorkspace, selectedWorkItem.item, defaultLoop.name)}
                            title={`立即起一轮 ${defaultLoop.name}（daemon 会话，实时观看；本轮优先处理 ${selectedWorkItem.item.key}）`}
                          >
                            立即跑一轮
                          </button>
                        );
                      }
                      if (activeKitLoops.length === 0) return null;
                      // 未绑定且多 loop：选择菜单（spec §4 入口 gate）
                      const pick = runLoopPick && activeKitLoops.some((l) => l.name === runLoopPick)
                        ? runLoopPick : activeKitLoops[0]?.name ?? "";
                      return (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <select
                            value={pick}
                            disabled={saving}
                            onChange={(event) => setRunLoopPick(event.target.value)}
                            style={{ fontSize: 12 }}
                            title="选择用哪个 loop 起轮"
                          >
                            {activeKitLoops.map((l) => (
                              <option key={l.name} value={l.name}>{l.name}</option>
                            ))}
                          </select>
                          <button
                            className="workspace-action"
                            disabled={saving}
                            onClick={() => void onRunLoopRound(selectedWorkspace, selectedWorkItem.item, pick)}
                            title={`立即起一轮 ${pick}（daemon 会话，实时观看；本轮优先处理 ${selectedWorkItem.item.key}）`}
                          >
                            立即跑一轮
                          </button>
                        </span>
                      );
                    })()}
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
                    <div className="work-item-detail-title">
                      <div className="work-item-key">{selectedWorkItem.item.key}</div>
                      <h2>{selectedWorkItem.item.title}</h2>
                    </div>
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
                          <SourceRefValue external={selectedWorkItem.item.external} />
                        </div>
                      </div>
                    )}
                    <div className="workspace-field workspace-field-compact">
                      <span>Loop</span>
                      <div style={{ padding: "9px 0", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                        <select
                          value={boundLoopName}
                          disabled={saving || kitLoops.length === 0}
                          onChange={(event) => void patchWorkItem({ loop: event.target.value || null })}
                          title={kitLoops.length === 0 ? "本工作区没有 kit loop" : "绑定后该工作项只被绑定的 loop 拾取（未绑定项对所有 loop 可见）"}
                        >
                          <option value="">未绑定</option>
                          {kitLoops.map((loop) => (
                            <option key={loop.name} value={loop.name}>
                              {loop.name}{loop.paused ? "（已暂停）" : ""}
                            </option>
                          ))}
                        </select>
                        {boundLoopName && !kitLoops.some((l) => l.name === boundLoopName) && (
                          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>未生效（loop 不存在）</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* 仓库范围只读展示（2026-09 反馈：详情页勾选无实际作用，撤掉）。
                    字段仍由创建表单 / 外部源脚本 / LLM 工具写入，loop 选品的
                    verifiable 判定读它；详情页只在非空时展示，不再提供勾选。 */}
                  {selectedWorkItem.item.repositories.length > 0 && (
                    <div className="work-item-repositories" aria-label="Repository scope">
                      <WorkItemRepositoryChips
                        repositoryIds={selectedWorkItem.item.repositories}
                        repositories={selectedWorkspace.repositories}
                      />
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
                      {/* cwd = work-item dir so relative image refs (e.g. external-source-script-written
                          `attachments/chandao-<id>.png`) resolve to /api/files and actually render;
                          without it the browser 404s the relative src and images vanish. */}
                      <MarkdownBody cwd={selectedWorkItem.path}>{selectedWorkItem.content}</MarkdownBody>
                    </div>
                  )}
                  <section className="work-item-events">
                    <WorkItemEvents
                      events={selectedWorkItem.events}
                      onOpenConversation={onOpenConversation}
                      title="执行里程碑"
                      headerActions={
                        <button
                          className="workspace-action"
                          disabled={saving}
                          onClick={() => void trashWorkItem()}
                        >
                          移到回收站
                        </button>
                      }
                    />
                  </section>
    </div>
  ) : null;
  const workItemListPane = selectedWorkspace ? (
    <>
                  <div className="workspace-page-header">
                    <h2>{selectedWorkspace.name} · 工作项</h2>
                    {/* 「打开完整管理」（M2 T10，spec §6.1）：仅快捷面板（panel）
                        形态渲染——设置›工作区 的管理面（同为 panel 宿主）不传
                        prop 自然不出现；rail 图标单击仍是模块切换，与此入口
                        互不冲突。 */}
                    {panel && onOpenWorkItemsPage && (
                      <button
                        className="workspace-action"
                        onClick={() => onOpenWorkItemsPage(selectedWorkspace.id)}
                        title="打开完整工作项管理弹窗（列表/看板/卡片——卡片可拖拽改状态）"
                      >
                        打开完整管理
                      </button>
                    )}
                    <button className="workspace-action" onClick={() => openCreateWorkItem()}>
                      + 新建工作项
                    </button>
                  </div>
                  {createWorkItemOpen && (
                    <div style={{ marginBottom: 14 }}>
                      <WorkItemCreateForm
                        key={workItemCreateFormKey}
                        repositories={selectedWorkspace.repositories.filter((repository) => repository.status === "active")}
                        initialType={workItemInitialType}
                        defaultRepositoryIds={selectedWorkspace.repositories
                          .filter((repository) => repository.status === "active" && repository.kind === "code")
                          .map((repository) => repository.id)}
                        saving={saving}
                        onCancel={() => setCreateWorkItemOpen(false)}
                        onSubmit={(values) => void createWorkItem(values)}
                      />
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
                        <span className="work-item-title">{item.title}</span>
                        <span className="work-item-meta">
                          <span className="work-item-key">
                            {item.key}
                            {item.external && (
                              <span className="work-item-source" title={`来自${sourceLabel(item.external.source)} #${item.external.sourceId}`}>
                                {sourceLabel(item.external.source)}
                              </span>
                            )}
                          </span>
                          <span className="work-item-badge">{STATUS_LABELS[item.status]}</span>
                          <span className="work-item-badge">{PHASE_LABELS[item.phase]}</span>
                          <time>{formatDate(item.updatedAt)}</time>
                        </span>
                      </button>
                    ))}
                    {!itemsLoading && visibleWorkItems.length === 0 && (
                      <div className="workspace-summary-card">
                        {showArchived ? "没有匹配的归档工作项。" : "没有匹配的工作项。"}
                      </div>
                    )}
                    {workItemInvalid.map((item) => (
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
      style={{
        // 详情优先：rail（全部工作区列表）收起——带工作区上下文的入口只见
        // 目标工作区，‹ 全部工作区再展开。
        ...(detailFocus ? { display: "none" } : null),
        ...(inlineSplit
          ? { width: 300, flexShrink: 0, minHeight: 0 }
          : splitMode ? { width: "100%", flex: 1, minHeight: 0, borderRight: "none" } : null),
      }}
    >
            {/* 新建按钮独占头部（2026-09 反馈收敛）：不再带 "Workspaces"
                英文标题——设置页左索引列 / PanelHeader 已标明「工作区」，双层
                标题观感混乱；按钮语义补全为「新建工作区」（避免误读为工作项）。 */}
            <div className="workspace-page-header">
              <button className="workspace-action" onClick={() => setCreateWorkspaceOpen(true)}>＋ 新建工作区</button>
            </div>
            {loading && <div className="workspace-rail-meta">Loading…</div>}
            {workspaceData?.workspaces.map((workspace) => (
              <button
                key={workspace.id}
                disabled={!workspace.available}
                className="workspace-rail-item"
                data-active={workspace.id === selectedWorkspaceId}
                draggable
                onDragStart={(event) => {
                  setDraggedWorkspaceId(workspace.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => { setDraggedWorkspaceId(null); setRailDropHint(null); }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setRailDropHint({ targetId: workspace.id, position: railDropPositionOf(event) });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const position = railDropPositionOf(event);
                  setRailDropHint(null);
                  if (!draggedWorkspaceId || draggedWorkspaceId === workspace.id) return;
                  const ids = workspaceData?.workspaces.map((item) => item.id) ?? [];
                  const next = ids.filter((id) => id !== draggedWorkspaceId);
                  const at = next.indexOf(workspace.id);
                  if (at >= 0) next.splice(position === "after" ? at + 1 : at, 0, draggedWorkspaceId);
                  setDraggedWorkspaceId(null);
                  void saveWorkspaceOrder(next);
                }}
                onClick={() => {
                  setSelectedWorkspaceId(workspace.id);
                  setSelectedWorkItem(null);
                }}
                style={draggedWorkspaceId === workspace.id ? { opacity: 0.5 } : undefined}
              >
                {railDropHint?.targetId === workspace.id && (
                  <span
                    aria-hidden
                    className="workspace-drop-line"
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      height: 2,
                      borderRadius: 2,
                      background: "var(--accent)",
                      boxShadow: "0 0 4px color-mix(in srgb, var(--accent) 45%, transparent)",
                      ...(railDropHint.position === "before" ? { top: -2 } : { bottom: -2 }),
                    }}
                  />
                )}
                <strong>
                  {workspace.name}
                  {workspace.disabled && (
                    <span
                      style={{
                        marginLeft: 6,
                        padding: "1px 6px",
                        borderRadius: 6,
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        background: "var(--bg-hover)",
                        verticalAlign: "middle",
                      }}
                    >
                      已停用
                    </span>
                  )}
                </strong>
                {/* 两行制（2026-09 反馈收敛）：名称（含已停用徽章）+ 缩短路径；
                    capabilities/repos 计数撤下列表（详情页全量可见），不可用
                    状态占第二行。 */}
                <span
                  className="workspace-rail-meta"
                  title={workspace.available ? workspace.path : undefined}
                >
                  {workspace.available ? shortenWorkspacePath(workspace.path) : "目录或配置不可用"}
                </span>
              </button>
            ))}
            {!loading && workspaceData?.workspaces.length === 0 && (
              <div className="workspace-rail-meta">尚未创建 Workspace。</div>
            )}
            {/* 空白区 drop = 移到末尾（同 SessionTabBar 容器兜底）；尾部指示线。 */}
            <div
              style={{ minHeight: 24, position: "relative" }}
              onDragOver={(event) => {
                event.preventDefault();
                setRailDropHint({ targetId: null, position: "after" });
              }}
              onDrop={() => {
                setRailDropHint(null);
                if (!draggedWorkspaceId) return;
                const ids = workspaceData?.workspaces.map((item) => item.id) ?? [];
                const next = ids.filter((id) => id !== draggedWorkspaceId);
                next.push(draggedWorkspaceId);
                setDraggedWorkspaceId(null);
                void saveWorkspaceOrder(next);
              }}
            >
              {draggedWorkspaceId && railDropHint?.targetId === null && (
                <div aria-hidden className="workspace-drop-line" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, borderRadius: 2, background: "var(--accent)" }} />
              )}
            </div>
    </aside>
  );

  const contentPane = (
    <main
      className="workspace-content"
      style={splitMode ? { flex: 1, minHeight: 0 } : undefined}
    >
            {(error || (section === "work-items" ? workItemsError : null)) && (
              <div className="workspace-error">{error ?? workItemsError}</div>
            )}

            {detailFocus && section === "workspaces" && (
              <div style={{ display: "flex", marginBottom: 8 }}>
                <button className="workspace-action" onClick={() => setDetailFocus(false)}>
                  ‹ 全部工作区
                </button>
              </div>
            )}

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
                        <label className="workspace-field">
                          <span>名称</span>
                          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                            <input
                              value={nameDraft}
                              onChange={(event) => setNameDraft(event.target.value)}
                              placeholder="工作区名称"
                              style={{ flex: 1, minWidth: 0 }}
                            />
                            <button
                              className="workspace-action"
                              disabled={saving || !nameDraft.trim() || nameDraft.trim() === selectedWorkspace.name}
                              onClick={() => void saveWorkspaceName()}
                            >
                              保存
                            </button>
                          </div>
                        </label>
                        <div className="workspace-field">
                          <span>状态</span>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32 }}>
                            <CapabilityToggle
                              enabled={!selectedWorkspace.disabled}
                              loading={saving}
                              onToggle={(next) => void setWorkspaceDisabled(!next)}
                            />
                            <span className="workspace-rail-meta">
                              {selectedWorkspace.disabled
                                ? "已停用：首页与各工作区选择器不再出现，已打开的会话不受影响"
                                : "启用中"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
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
                          <div className="workspace-rail-meta">最近更新</div>
                          <div>{formatDate(selectedWorkspace.updatedAt)}</div>
                        </div>
                      </div>
                    </div>
                    {/* 交付自动化配置（Phase-2 Task 9；T5 增 developer 行）：
                        work-items+workflows 双开才显示（服务端 PUT 同款门）。
                        enabled 开关 + designer/developer profile 文本 + 预算
                        只读展示 + 保存（PUT /delivery）。 */}
                    {deliveryAutomationCapable && selectedWorkspace && (
                      <section className="workspace-settings-section" data-section="delivery-automation">
                        <div className="repository-section-header">
                          <h3>交付自动化</h3>
                        </div>
                        <div className="workspace-summary-card">
                          {deliveryConfig ? (
                            <>
                              <div className="workspace-field">
                                <span>自动执行</span>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32 }}>
                                  <CapabilityToggle
                                    enabled={deliveryEnabled}
                                    loading={deliverySaving}
                                    onToggle={(next) => {
                                      setDeliveryEnabled(next);
                                      setDeliverySaved(false);
                                    }}
                                  />
                                  <span className="workspace-rail-meta">
                                    {deliveryEnabled
                                      ? "开启：满足领取条件的工作项由 designer/developer/reviewer/release-preparer 角色自动领取执行，检查由引擎系统步自动运行"
                                      : "关闭：标准交付流程仅人工推进"}
                                  </span>
                                </div>
                              </div>
                              {/* 评审阶段开关（final-arch step-3，stages.review.enabled
                                  ——先审后跑）：开 = developer 提交候选后先进 reviewer
                                  人工评审（pass 才放行跑检查，rework 按源头打回）；
                                  关 = 候选直接进系统检查步（旧流程零变化，缺省）。 */}
                              <div className="workspace-field">
                                <span>评审阶段</span>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32 }}>
                                  <CapabilityToggle
                                    enabled={deliveryReviewEnabled}
                                    loading={deliverySaving}
                                    onToggle={(next) => {
                                      setDeliveryReviewEnabled(next);
                                      setDeliverySaved(false);
                                    }}
                                  />
                                  <span className="workspace-rail-meta">
                                    {deliveryReviewEnabled
                                      ? "开启：候选先进 reviewer 人工评审，通过后才运行检查（先审后跑）"
                                      : "关闭：候选直接由系统检查步执行验证命令（不评审）"}
                                  </span>
                                </div>
                              </div>
                              {/* 集成阶段（final-arch step-4，stages.integrate）：
                                  checks 全过后的延伸段——开 = 在候选 checkout 内逐仓
                                  执行集成命令（{repositoryId}/{branch} 占位符，
                                  单仓上限 10 分钟），失败即 blocked 待人工解锁
                                  （unblock 后整回合重跑）。enabled 而命令空白在
                                  保存前客户端拦截（文案与服务端 parseStages 一致）；
                                  关闭时命令保留（回开免重写）。 */}
                              <div className="workspace-field">
                                <span>集成命令</span>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32, flexWrap: "wrap" }}>
                                  <CapabilityToggle
                                    enabled={deliveryIntegrateEnabled}
                                    loading={deliverySaving}
                                    onToggle={(next) => {
                                      setDeliveryIntegrateEnabled(next);
                                      setDeliverySaved(false);
                                    }}
                                  />
                                  <input
                                    value={deliveryIntegrateCommand}
                                    disabled={deliverySaving}
                                    placeholder="如 npm run integrate（{repositoryId}/{branch} 占位符）"
                                    aria-label="集成命令"
                                    onChange={(event) => {
                                      setDeliveryIntegrateCommand(event.target.value);
                                      setDeliverySaved(false);
                                    }}
                                    style={{ flex: "1 1 220px", minWidth: 0, fontFamily: "var(--font-mono)" }}
                                  />
                                  <span className="workspace-rail-meta">
                                    {deliveryIntegrateEnabled
                                      ? "开启：检查全过后在候选 checkout 内逐仓执行，失败即阻塞待解锁"
                                      : "关闭：检查通过后直接进入后续阶段（不集成）"}
                                  </span>
                                </div>
                              </div>
                              {/* 验收门开关（final-arch step-4，stages.acceptance.
                                  enabled）：开 = release_ready → released 前须人工
                                  record-acceptance（摘要与当前候选绑定——attention
                                  出「待人工验收」待办）；关 = 直接放行（缺省）。 */}
                              <div className="workspace-field">
                                <span>验收门</span>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32 }}>
                                  <CapabilityToggle
                                    enabled={deliveryAcceptanceEnabled}
                                    loading={deliverySaving}
                                    onToggle={(next) => {
                                      setDeliveryAcceptanceEnabled(next);
                                      setDeliverySaved(false);
                                    }}
                                  />
                                  <span className="workspace-rail-meta">
                                    {deliveryAcceptanceEnabled
                                      ? "开启：发布前须人工登记验收（先完成验收才能放行发布）"
                                      : "关闭：发布准备完成即可直接登记发布（不验收）"}
                                  </span>
                                </div>
                              </div>
                              {/* 角色表（Seam-repositioning Task 4，spec §13.5）：四行
                                  （DELIVERY_ROLES 序）× 四列——剧本下拉（选项 =
                                  .pi/agents 的 project 作用域剧本，首项「同名」=
                                  不写 profile 键）/ ModelSelector 模型覆写（占位 =
                                  摘要的有效模型与来源；清空 = 删键）/ 状态（只读
                                  投影：存在〔模板 vN〕/ 缺失 + 播种或创建提示）/
                                  操作（编辑剧本 → 设置›Agents；预览 prompt → 抽屉）。
                                  不另建状态存储——投影来自 GET …/delivery/roles。 */}
                              <div className="workspace-field" style={{ marginTop: 6 }}>
                                <span>交付角色（剧本 / 模型 / 状态）</span>
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                  {DELIVERY_ROLES.map((role) => {
                                    const summary = deliveryRoleSummaries?.find((row) => row.role === role) ?? null;
                                    const roleModel = deliveryConfig.roles[role]?.model;
                                    // 模型占位：摘要的有效模型 + 来源（无解析 → 工作区默认）。
                                    const sourceLabel = summary?.model.source === "override"
                                      ? "覆写"
                                      : summary?.model.source === "profile"
                                        ? "剧本默认"
                                        : "工作区默认";
                                    const effectiveLabel = summary?.model.effective
                                      ? `${sourceLabel}：${summary.model.effective.provider ? `${summary.model.effective.provider}/` : ""}${summary.model.effective.modelId}`
                                      : "工作区默认模型";
                                    // 模板漂移（final-arch step-6 Task 3）：剧本由模板播种
                                    // （seeded_from = "<role>@<n>"）且 n < 当前内置模板版本
                                    //（readiness 响应携带）→ 提示 + 「另存新模板」（副本写
                                    // <role>.template.md，永不覆盖 <role>.md 与既有副本）。
                                    const seededFrom = summary?.profile.seededFrom;
                                    const atSign = seededFrom?.lastIndexOf("@") ?? -1;
                                    const seededVersion = atSign >= 0 ? Number(seededFrom?.slice(atSign + 1)) : NaN;
                                    const templateDrift = Boolean(
                                      summary?.profile.exists
                                      && Number.isInteger(seededVersion)
                                      && deliveryReadiness
                                      && seededVersion < deliveryReadiness.currentTemplateVersion,
                                    );
                                    return (
                                      <div
                                        key={role}
                                        style={{
                                          display: "flex",
                                          gap: 8,
                                          flexWrap: "wrap",
                                          alignItems: "flex-end",
                                          border: "1px solid var(--border)",
                                          borderRadius: 8,
                                          padding: "8px 10px",
                                        }}
                                      >
                                        <div className="workspace-field" style={{ flex: "0 1 96px" }}>
                                          <span>{DELIVERY_ROLE_LABELS[role]}</span>
                                          <span className="workspace-rail-meta" style={{ fontFamily: "var(--font-mono)" }}>{role}</span>
                                        </div>
                                        <label className="workspace-field" style={{ flex: "1 1 150px" }}>
                                          <span>剧本</span>
                                          <select
                                            value={deliveryRoleProfiles[role]}
                                            disabled={deliverySaving}
                                            onChange={(event) => {
                                              setDeliveryRoleProfiles((current) => ({
                                                ...current,
                                                [role]: event.target.value,
                                              }));
                                              setDeliverySaved(false);
                                            }}
                                          >
                                            <option value="">同名（{role}.md）</option>
                                            {deliveryProfileOptions.map((name) => (
                                              <option key={name} value={name}>{name}</option>
                                            ))}
                                          </select>
                                        </label>
                                        <div className="workspace-field" style={{ flex: "1 1 190px" }}>
                                          <span>模型</span>
                                          <ModelSelector
                                            options={deliveryModelOptions}
                                            value={roleModel
                                              ? { provider: roleModel.provider ?? "", modelId: roleModel.modelId }
                                              : null}
                                            onChange={(provider, modelId) => {
                                              setDeliveryConfig((current) => current && ({
                                                ...current,
                                                roles: {
                                                  ...current.roles,
                                                  [role]: {
                                                    ...(current.roles[role] ?? {}),
                                                    model: provider ? { provider, modelId } : { modelId },
                                                  },
                                                },
                                              }));
                                              setDeliverySaved(false);
                                            }}
                                            onClear={() => {
                                              // 清空 = 删 model 键；profile 也空 → 整个角色键剥掉。
                                              setDeliveryConfig((current) => {
                                                if (!current) return current;
                                                const existing = current.roles[role];
                                                if (!existing?.model) return current;
                                                const rest = { ...existing };
                                                delete rest.model;
                                                const nextRoles = { ...current.roles };
                                                if (rest.profile) nextRoles[role] = rest;
                                                else delete nextRoles[role];
                                                return { ...current, roles: nextRoles };
                                              });
                                              setDeliverySaved(false);
                                            }}
                                            emptyLabel={effectiveLabel}
                                            aria-label={`${DELIVERY_ROLE_LABELS[role]}模型覆写`}
                                            disabled={deliverySaving}
                                            busy={deliveryModelsLoading}
                                            variant="field"
                                            placement="auto"
                                          />
                                        </div>
                                        <div className="workspace-field" style={{ flex: "1 1 150px" }}>
                                          <span>状态</span>
                                          {summary ? (
                                            summary.profile.exists ? (
                                              <>
                                                <span className="workspace-rail-meta">
                                                  存在{summary.profile.seededFrom?.includes("@")
                                                    ? ` · 模板 v${summary.profile.seededFrom.split("@").pop()}`
                                                    : ""}
                                                </span>
                                                {templateDrift && deliveryReadiness && (
                                                  <>
                                                    <span
                                                      className="workspace-rail-meta"
                                                      style={{ color: "#b45309" }}
                                                      title={`内置模板已升级到 v${deliveryReadiness.currentTemplateVersion}；另存得到参考副本，是否采用由你改后决定`}
                                                    >
                                                      模板已更新 v{seededVersion}→v{deliveryReadiness.currentTemplateVersion}
                                                    </span>
                                                    <button
                                                      type="button"
                                                      className="workspace-action"
                                                      disabled={deliveryTemplateSavingRole !== null}
                                                      onClick={() => void saveRoleTemplateCopy(role)}
                                                    >
                                                      {deliveryTemplateSavingRole === role ? "另存中…" : "另存新模板"}
                                                    </button>
                                                  </>
                                                )}
                                              </>
                                            ) : (
                                              <span className="workspace-rail-meta">
                                                缺失 · {summary.profile.explicit ? "请在 Agents 面板创建" : "保存后自动播种"}
                                              </span>
                                            )
                                          ) : (
                                            <span className="workspace-rail-meta">加载中…</span>
                                          )}
                                        </div>
                                        <div className="workspace-field" style={{ flex: "0 0 auto", flexDirection: "row", gap: 6 }}>
                                          <button
                                            type="button"
                                            className="workspace-action"
                                            disabled={deliverySaving}
                                            onClick={() => editRoleProfile(role)}
                                            title="定位到 设置 › Agents 的该剧本（打开 Agents 面板后自动选中）"
                                          >
                                            编辑剧本
                                          </button>
                                          <button
                                            type="button"
                                            className="workspace-action"
                                            disabled={deliverySaving}
                                            onClick={() => void openDeliveryPreview(role)}
                                          >
                                            预览 prompt
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              {/* 验证命令清单（Phase-4 T5）：系统检查步按此执行并
                                  留存证据（final-arch step-3 起执行者是引擎
                                  system 步，原 verifier 角色已退役）——agent
                                  只能触发，不能自造命令。四列
                                  name/仓库/命令/超时（秒）+ 行删除；空清单 = 无配置
                                  （检查步按空处理，项以 checks-empty 可见）。
                                  保存前 checksPayload 行内
                                  校验（名称/命令必填、timeout 整数 1–3600）。 */}
                              <div className="workspace-field" style={{ marginTop: 6 }}>
                                <span>验证命令（系统检查）</span>
                                {deliveryChecks.length === 0 && (
                                  <span className="workspace-rail-meta">
                                    尚未配置验证命令——开启后系统检查步将按此清单在候选上执行命令并留存证据（agent 只能触发，不能自造命令）；空清单即不执行任何检查。
                                  </span>
                                )}
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                  {deliveryChecks.map((check, index) => (
                                    <div
                                      key={index}
                                      style={{
                                        display: "flex",
                                        gap: 8,
                                        flexWrap: "wrap",
                                        alignItems: "flex-end",
                                        border: "1px solid var(--border)",
                                        borderRadius: 8,
                                        padding: "8px 10px",
                                      }}
                                    >
                                      <label className="workspace-field" style={{ flex: "1 1 110px" }}>
                                        <span>名称</span>
                                        <input
                                          value={check.name}
                                          disabled={deliverySaving}
                                          placeholder="unit"
                                          onChange={(event) => {
                                            setDeliveryChecks((current) => current.map((row, rowIndex) =>
                                              rowIndex === index ? { ...row, name: event.target.value } : row,
                                            ));
                                            setDeliverySaved(false);
                                          }}
                                        />
                                      </label>
                                      <label className="workspace-field" style={{ flex: "1 1 150px" }}>
                                        <span>仓库</span>
                                        <select
                                          value={check.repositoryId}
                                          disabled={deliverySaving}
                                          onChange={(event) => {
                                            setDeliveryChecks((current) => current.map((row, rowIndex) =>
                                              rowIndex === index ? { ...row, repositoryId: event.target.value } : row,
                                            ));
                                            setDeliverySaved(false);
                                          }}
                                        >
                                          <option value="">候选首仓（缺省）</option>
                                          {repositories
                                            .filter((repository) => repository.status === "active")
                                            .map((repository) => (
                                              <option key={repository.id} value={repository.id}>
                                                {repository.alias}
                                              </option>
                                            ))}
                                        </select>
                                      </label>
                                      <label className="workspace-field" style={{ flex: "2 1 220px" }}>
                                        <span>命令</span>
                                        <input
                                          value={check.command}
                                          disabled={deliverySaving}
                                          placeholder="npm test"
                                          style={{ fontFamily: "var(--font-mono)" }}
                                          onChange={(event) => {
                                            setDeliveryChecks((current) => current.map((row, rowIndex) =>
                                              rowIndex === index ? { ...row, command: event.target.value } : row,
                                            ));
                                            setDeliverySaved(false);
                                          }}
                                        />
                                      </label>
                                      <label className="workspace-field" style={{ flex: "0 1 92px" }}>
                                        <span>超时（秒）</span>
                                        <input
                                          value={check.timeout}
                                          disabled={deliverySaving}
                                          placeholder="600"
                                          inputMode="numeric"
                                          onChange={(event) => {
                                            setDeliveryChecks((current) => current.map((row, rowIndex) =>
                                              rowIndex === index ? { ...row, timeout: event.target.value } : row,
                                            ));
                                            setDeliverySaved(false);
                                          }}
                                        />
                                      </label>
                                      <button
                                        type="button"
                                        className="workspace-action"
                                        aria-label={`删除验证命令 ${index + 1}`}
                                        disabled={deliverySaving}
                                        onClick={() => {
                                          setDeliveryChecks((current) => current.filter((_, rowIndex) => rowIndex !== index));
                                          setDeliverySaved(false);
                                        }}
                                      >
                                        删除
                                      </button>
                                    </div>
                                  ))}
                                </div>
                                <div>
                                  <button
                                    type="button"
                                    className="workspace-action"
                                    disabled={deliverySaving}
                                    onClick={() => {
                                      setDeliveryChecks((current) => [
                                        ...current,
                                        { name: "", repositoryId: "", command: "", timeout: "" },
                                      ]);
                                      setDeliverySaved(false);
                                    }}
                                  >
                                    + 添加验证命令
                                  </button>
                                </div>
                              </div>
                              {/* 初始化向导（final-arch step-6 Task 3，spec §13.2/§13.3）：
                                  「Nth project」故事——新建与导入一视同仁，重跑幂等。
                                  init 只补缺（缺 delivery.yaml 才写默认、enabled 恒 false、
                                  缺剧本才播种、from 的剧本/integrate.sh 缺文件才复制）、
                                  只建议（探测与 from 的检查只作草稿，不落盘不执行）。
                                  stages 三开关取当前表单值（与保存同源）；from 的检查
                                  草稿剥 repositoryId（仓绑定待面板重绑）。 */}
                              <div className="workspace-field" style={{ marginTop: 6 }}>
                                <span>初始化</span>
                                <span className="workspace-rail-meta">
                                  只补缺、只建议：缺配置才写默认（自动执行恒为关闭，启用是人的手）；缺剧本才播种；探测与 from 的检查命令只作草稿建议，不执行、不自动保存。
                                </span>
                                <label className="workspace-field">
                                  <span>from 同布局源目录（可选——须含 .pi/，绝对路径；复制剧本与 integrate.sh，缺文件才写）</span>
                                  <input
                                    value={deliveryInitFrom}
                                    disabled={deliveryInitRunning}
                                    placeholder="/absolute/path/to/source-workspace"
                                    onChange={(event) => setDeliveryInitFrom(event.target.value)}
                                    style={{ fontFamily: "var(--font-mono)" }}
                                  />
                                </label>
                                {deliveryInitChecks.length > 0 && (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    {deliveryInitChecks.map((check, index) => (
                                      <div
                                        key={index}
                                        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
                                      >
                                        <label className="workspace-field" style={{ flex: "1 1 110px" }}>
                                          <span>草稿名称 {index + 1}</span>
                                          <input
                                            value={check.name}
                                            disabled={deliveryInitRunning}
                                            onChange={(event) => {
                                              setDeliveryInitChecks((current) => current.map((row, rowIndex) =>
                                                rowIndex === index ? { ...row, name: event.target.value } : row,
                                              ));
                                            }}
                                          />
                                        </label>
                                        <label className="workspace-field" style={{ flex: "2 1 220px" }}>
                                          <span>命令</span>
                                          <input
                                            value={check.command}
                                            disabled={deliveryInitRunning}
                                            style={{ fontFamily: "var(--font-mono)" }}
                                            onChange={(event) => {
                                              setDeliveryInitChecks((current) => current.map((row, rowIndex) =>
                                                rowIndex === index ? { ...row, command: event.target.value } : row,
                                              ));
                                            }}
                                          />
                                        </label>
                                        <button
                                          type="button"
                                          className="workspace-action"
                                          aria-label={`删除初始化检查草稿 ${index + 1}`}
                                          disabled={deliveryInitRunning}
                                          onClick={() => {
                                            setDeliveryInitChecks((current) => current.filter((_, rowIndex) => rowIndex !== index));
                                          }}
                                        >
                                          删除
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                  <button
                                    type="button"
                                    className="workspace-action"
                                    disabled={deliveryInitRunning}
                                    onClick={() => {
                                      setDeliveryInitChecks((current) => [...current, { name: "", command: "" }]);
                                    }}
                                  >
                                    + 添加检查草稿
                                  </button>
                                  <button
                                    type="button"
                                    className="workspace-action"
                                    disabled={deliveryInitRunning}
                                    onClick={() => void runDeliveryInit()}
                                  >
                                    {deliveryInitRunning ? "初始化中…" : "运行初始化"}
                                  </button>
                                </div>
                                {deliveryInitResult && (
                                  <div
                                    role="status"
                                    style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}
                                  >
                                    <span className="workspace-rail-meta">初始化动作清单：</span>
                                    {deliveryInitResult.actions.map((action, index) => (
                                      <span key={index} className="workspace-rail-meta">· {action}</span>
                                    ))}
                                    {(deliveryInitResult.suggestedChecks?.length ?? 0) > 0 && (
                                      <>
                                        <span className="workspace-rail-meta">
                                          建议的检查命令（草稿——确认后才进上方验证命令清单；未自动保存）：
                                        </span>
                                        {deliveryInitResult.suggestedChecks?.map((check, index) => (
                                          <span
                                            key={`${check.name}:${index}`}
                                            className="workspace-rail-meta"
                                            style={{ fontFamily: "var(--font-mono)" }}
                                          >
                                            {check.name}：{check.command}
                                          </span>
                                        ))}
                                        <div>
                                          <button
                                            type="button"
                                            className="workspace-action"
                                            disabled={deliveryInitRunning}
                                            onClick={() => adoptSuggestedChecks(deliveryInitResult.suggestedChecks ?? [])}
                                          >
                                            采用为验证命令
                                          </button>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                )}
                                {deliveryInitError && (
                                  <div role="alert" className="workspace-rail-meta" style={{ color: "#dc2626" }}>
                                    {deliveryInitError}
                                  </div>
                                )}
                              </div>
                              {/* 就绪清单（final-arch step-6 Task 3，常驻只读投影非门禁）：
                                  五类缺项 {kind, detail} 逐行 muted；空 = 已就绪。
                                  无新定时器——load / 保存成功 / init 成功三个时机刷新。 */}
                              <div className="workspace-field" style={{ marginTop: 6 }}>
                                <span>就绪清单</span>
                                {deliveryReadiness === null ? (
                                  <span className="workspace-rail-meta">加载中…</span>
                                ) : deliveryReadiness.items.length === 0 ? (
                                  <span className="workspace-rail-meta" role="status">已就绪</span>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    {deliveryReadiness.items.map((item, index) => (
                                      <span key={`${item.kind}:${index}`} className="workspace-rail-meta">
                                        · {item.detail}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="workspace-rail-meta" style={{ marginTop: 6 }}>
                                预算（只读，.pi/delivery.yaml）：失败上限 {deliveryConfig.budget.maxAttemptsPerInput} 次 · 执行上限 {deliveryConfig.budget.maxExecutionMinutes} 分钟
                              </div>
                              {deliveryError && (
                                <div
                                  role="alert"
                                  className="workspace-rail-meta"
                                  style={{ marginTop: 6, color: "#dc2626" }}
                                >
                                  {deliveryError}
                                </div>
                              )}
                              {deliverySeededNotice && (
                                <div
                                  role="status"
                                  className="workspace-rail-meta"
                                  style={{ marginTop: 6 }}
                                >
                                  {deliverySeededNotice}
                                </div>
                              )}
                              {deliverySeedWarning && (
                                <div
                                  role="status"
                                  className="workspace-rail-meta"
                                  style={{ marginTop: 6, color: "#b45309" }}
                                >
                                  {deliverySeedWarning}
                                </div>
                              )}
                              {deliveryTemplateNotice && (
                                <div
                                  role="status"
                                  className="workspace-rail-meta"
                                  style={{ marginTop: 6, color: deliveryTemplateNotice.startsWith("另存失败") ? "#dc2626" : undefined }}
                                >
                                  {deliveryTemplateNotice}
                                </div>
                              )}
                              <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 10 }}>
                                {deliverySaved && (
                                  <span className="workspace-rail-meta" role="status">已保存</span>
                                )}
                                <button
                                  className="workspace-action"
                                  disabled={deliverySaving}
                                  onClick={() => void saveDeliveryConfig()}
                                >
                                  {deliverySaving ? "保存中…" : "保存"}
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="workspace-rail-meta">
                              {deliveryError ?? "加载交付自动化配置…"}
                            </div>
                          )}
                        </div>
                        {/* 「预览 prompt」抽屉（Task 4）：三段只读——AGENTS.md（默认
                            折叠，pi 从 cwd 注入、仅展示）▸ 不变式（引擎锁定段：
                            灰底 + 锁 + spec §4.3.1 出处，不可编辑）▸ 剧本正文；
                            顶部一行有效模型 + 来源 + 剧本路径。 */}
                        {deliveryPreviewRole && createPortal(
                          <div
                            role="dialog"
                            aria-modal="true"
                            aria-label={`${DELIVERY_ROLE_LABELS[deliveryPreviewRole]} prompt 预览`}
                            onClick={(event) => {
                              if (event.target === event.currentTarget) {
                                setDeliveryPreviewRole(null);
                                setDeliveryPreview(null);
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setDeliveryPreviewRole(null);
                                setDeliveryPreview(null);
                              }
                            }}
                            style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
                          >
                            <div style={{ width: 680, maxWidth: "calc(100vw - 16px)", height: "min(640px, calc(100dvh - 16px))", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 14 }}>
                                    {DELIVERY_ROLE_LABELS[deliveryPreviewRole]} · 组合预览
                                  </div>
                                  {deliveryPreview && (
                                    <div className="workspace-rail-meta" style={{ fontFamily: "var(--font-mono)", marginTop: 2 }}>
                                      {deliveryPreview.model.effective
                                        ? `模型：${deliveryPreview.model.effective.provider ? `${deliveryPreview.model.effective.provider}/` : ""}${deliveryPreview.model.effective.modelId}（${
                                          deliveryPreview.model.source === "override" ? "覆写" : "剧本默认"
                                        }）`
                                        : "模型：工作区默认"}
                                      {" · "}
                                      <span title={deliveryPreview.profile.path}>{deliveryPreview.profile.path}</span>
                                    </div>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDeliveryPreviewRole(null);
                                    setDeliveryPreview(null);
                                  }}
                                  title="关闭"
                                  aria-label="关闭"
                                  style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: "pointer" }}
                                >
                                  ×
                                </button>
                              </div>
                              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                                {deliveryPreviewLoading && (
                                  <div className="workspace-rail-meta">加载预览…</div>
                                )}
                                {deliveryPreview && (
                                  <>
                                    <details>
                                      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
                                        AGENTS.md（pi 从工作区注入，仅展示——不进组合 prompt）
                                      </summary>
                                      <div style={{ marginTop: 6 }}>
                                        <button
                                          type="button"
                                          className="workspace-action"
                                          style={{ marginBottom: 6 }}
                                          title={selectedWorkspace ? `${selectedWorkspace.path}/AGENTS.md` : undefined}
                                          onClick={() => {
                                            if (selectedWorkspace) void navigator.clipboard?.writeText(`${selectedWorkspace.path}/AGENTS.md`);
                                          }}
                                        >
                                          复制文件路径
                                        </button>
                                        <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11.5, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflowY: "auto" }}>
                                          {deliveryPreview.agentsMd ?? "（工作区没有 AGENTS.md）"}
                                        </pre>
                                      </div>
                                    </details>
                                    <section>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                        <span aria-hidden style={{ color: "var(--text-dim)" }}>
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                                        </span>
                                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>引擎不变式（锁定，不可编辑）</span>
                                        <span
                                          className="workspace-rail-meta"
                                          title="docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md §4.3.1"
                                          style={{ fontFamily: "var(--font-mono)" }}
                                        >
                                          spec §4.3.1
                                        </span>
                                      </div>
                                      <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11.5, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "none" }}>
                                        {deliveryPreview.invariant}
                                      </pre>
                                    </section>
                                    <section>
                                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
                                        剧本正文（{deliveryPreview.profile.name}.md{deliveryPreview.profile.exists ? "" : " · 文件缺失"}）
                                      </div>
                                      <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", fontSize: 11.5, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                        {deliveryPreview.body || "（剧本正文为空——会话仅带不变式开场）"}
                                      </pre>
                                    </section>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>,
                          document.body,
                        )}
                      </section>
                    )}
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
                      <p className="repository-scan-hint" style={{ margin: "4px 0 8px", fontSize: 12, opacity: 0.65 }}>
                        根目录下的 git 仓与 OKF 知识库自动登记（打开本页即扫描）：往工作区放目录即可，无需手动添加；「停用」仅是隐藏，目录原样保留。
                      </p>
                      {repositoryFormOpen && (
                        <div className="workspace-form-card" style={{ marginBottom: 9 }}>
                          <div className="workspace-form-grid">
                            <label className="workspace-field">
                              <span>方式</span>
                              <select
                                value={repositoryMode}
                                onChange={(event) => setRepositoryMode(event.target.value as "clone" | "init" | "register")}
                              >
                                <option value="clone">Clone 远程仓库</option>
                                <option value="init">新建空仓库</option>
                                <option value="register">登记已有目录</option>
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
                            {repositoryMode === "register" && (
                              <label className="workspace-field" style={{ gridColumn: "1 / -1" }}>
                                <span>相对路径（相对工作区根，必填）</span>
                                <input
                                  value={repositoryPath}
                                  onChange={(event) => setRepositoryPath(event.target.value)}
                                  placeholder="cargoware-haichuang"
                                />
                              </label>
                            )}
                            {repositoryMode !== "register" && (
                              <label className="workspace-field">
                                <span>相对路径（可选，默认为别名）</span>
                                <input
                                  value={repositoryPath}
                                  onChange={(event) => setRepositoryPath(event.target.value)}
                                  placeholder={repositoryAlias || "web"}
                                />
                              </label>
                            )}
                            {repositoryMode !== "register" && (
                              <label className="workspace-field" style={{ gridColumn: "1 / -1" }}>
                                <span>{repositoryMode === "clone" ? "Git URL" : "Origin URL（可选）"}</span>
                                <input
                                  value={repositoryRemote}
                                  onChange={(event) => setRepositoryRemote(event.target.value)}
                                  placeholder="https://github.com/org/repo.git"
                                />
                              </label>
                            )}
                          </div>
                          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                            <button
                              className="workspace-action"
                              disabled={
                                saving
                                || !repositoryAlias
                                || (repositoryMode === "register" && !repositoryPath.trim())
                                || (repositoryMode === "clone" && !repositoryRemote.trim())
                              }
                              onClick={() => void addRepository()}
                            >
                              {saving
                                ? "处理中…"
                                : repositoryMode === "clone"
                                  ? "Clone 仓库"
                                  : repositoryMode === "register"
                                    ? "登记仓库"
                                    : "创建仓库"}
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
              selectedWorkItem ? workItemDetailPane : workItemListPane
            )}
    </main>
  );

  if (splitMode) {
    if (inlineSplit) {
      // Inline split (the desktop center-area 工作区设置 page, 2026-09): LIST
      // + DETAIL render side by side inside ONE container — no portal, no
      // manager chrome. The list left the cramped middle column; both panes
      // live in the main content area now.
      return (
        <div
          className="workspace-manager-page"
          style={{ display: "flex", flexDirection: "row" }}
        >
          <style>{managerStyles}</style>
          {railPane}
          {contentPane}
        </div>
      );
    }
    // Portal split (three-column) mode: the workspace LIST (rail) fills the
    // host column — no manager chrome, the column's own PanelHeader (via
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

        <div
          className="workspace-manager-body"
          style={detailFocus ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}
        >
          {railPane}
          {contentPane}
        </div>
      </div>
    </div>
  );
}
