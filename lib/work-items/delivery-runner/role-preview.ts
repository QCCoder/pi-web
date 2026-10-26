// Seam-repositioning Task 4（2026-10-26）：角色摘要与组合预览的只读投影。
// 设置面板的角色表（剧本下拉 / 模型覆写占位 / 状态列）与「预览 prompt」抽屉
// 不另建状态存储（spec §13.5 页面是文件的编辑器）——本模块把「磁盘上的剧本
// 文件 + .pi/delivery.yaml + 引擎不变式」投影成两份 GET 数据：
//   1. summarizeRoles：四角色（DELIVERY_ROLES 序）各一行——剧本名（缺省同名，
//      config.roles[role].profile 显式优先）/ 是否在场 / 播种标记（frontmatter
//      seeded_from）/ 有效模型与来源。模型优先级与 launch 完全一致
//      （role-session.ts launchRoleSession 同一解析序）：config 覆写 → 剧本
//      frontmatter model → 会话默认（effective 缺省）。config null（配置文件
//      缺失）= roles {}（全角色同名、非显式）。
//   2. previewRolePrompt：组合预览——composed 与 launch 的 appendSystemPrompt
//      走同一函数（composeRoleSystemPrompt，key 用 <KEY> 占位），杜绝「预览与
//      实际不一致」；AGENTS.md 全文仅展示（pi 从 cwd 注入，不参与 composed）。
// 复用 role-session.ts 的 resolveRoleProfileName / readRoleProfile /
// composeRoleSystemPrompt / AGENT_INVARIANT_CONTRACT。剧本文件每个投影恰好读
// 一次盘（final-fix C：摘要与预览共用同一次读取——预览不再二次读盘）；读盘
// 异常按缺席 + console.error 一条（final-fix D，与 launch「读盘异常当缺场」
// 同口径），deps.readProfile 为注入缝（测试注异常读取器，LaunchDeps.
// readProfile 同款）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DELIVERY_ROLES, type DeliveryRole } from "./roles.ts";
import type { DeliveryRunnerConfig } from "./config.ts";
import {
  AGENT_INVARIANT_CONTRACT,
  composeRoleSystemPrompt,
  readRoleProfile,
  resolveRoleProfileName,
  type RoleProfile,
} from "./role-session.ts";

/** 组合预览的 key 占位：预览不绑定具体工作项，标题行内插 <KEY> 示意。 */
export const PREVIEW_KEY_PLACEHOLDER = "<KEY>";

/** 单角色摘要（GET …/delivery/roles 的行）。 */
export interface RoleSummary {
  role: DeliveryRole;
  profile: {
    /** 剧本名 = resolveRoleProfileName（config.roles[role].profile ?? 角色名）。 */
    name: string;
    /** `<ws>/.pi/agents/<name>.md` 绝对路径（与 readRoleProfile 同一拼法）。 */
    path: string;
    /** 剧本文件在场（可读且名字合法）。 */
    exists: boolean;
    /** 剧本名来自 roles.<role>.profile 显式配置（false = 同名缺省）。 */
    explicit: boolean;
    /** frontmatter seeded_from（Task 3 播种标记，如 "designer@1"）；缺 → 键省略。 */
    seededFrom?: string;
  };
  model: {
    /** 解析出的有效模型；仅 override / profile 来源时存在（default → 缺省）。 */
    effective?: { provider?: string; modelId: string };
    /** 来源三态，优先级与 launch 一致：覆写（config）压剧本、剧本压默认。 */
    source: "override" | "profile" | "default";
  };
}

/** 剧本文件绝对路径（与 readRoleProfile 同一拼法，供展示）。 */
const roleProfilePath = (workspacePath: string, name: string): string =>
  join(resolve(workspacePath), ".pi", "agents", `${name}.md`);

/** 读取器注入缝（final-fix D，LaunchDeps.readProfile 同款最小形状）：默认
 *  readRoleProfile；测试注入抛错读取器覆盖降级路径。 */
export interface ProjectionDeps {
  readProfile?: (workspacePath: string, profile: string) => RoleProfile | undefined;
}

/** 单角色摘要 + 本次读到的剧本（同一次读盘喂两用——summarizeRoles 取摘要、
 *  previewRolePrompt 连正文一起用，预览不二次读盘）。 */
function summarizeWithProfile(
  workspacePath: string,
  role: DeliveryRole,
  config: DeliveryRunnerConfig | null,
  deps?: ProjectionDeps,
): { summary: RoleSummary; profile: RoleProfile | undefined } {
  const readProfile = deps?.readProfile ?? readRoleProfile;
  const roleConfig = config?.roles[role];
  const name = resolveRoleProfileName(role, roleConfig);
  // 读盘异常按缺席（readRoleProfile 缺文件/非法名静默 undefined；抛错 →
  // console.error 一条后当缺场——只读投影不抛，与 launch 同口径）。
  let profile: RoleProfile | undefined;
  try {
    profile = readProfile(workspacePath, name);
  } catch (error) {
    console.error(`[delivery-runner] ${role} profile read failed during projection (${name}):`, error);
    profile = undefined;
  }
  // 模型优先级（launch 同序）：config.roles[role].model → 剧本 frontmatter model
  // → 默认（source default、effective 缺省）。
  const override = roleConfig?.model;
  const profileModel = profile?.model;
  const model: RoleSummary["model"] = override
    ? { effective: override, source: "override" }
    : profileModel
      ? { effective: profileModel, source: "profile" }
      : { source: "default" };
  return {
    summary: {
      role,
      profile: {
        name,
        path: roleProfilePath(workspacePath, name),
        exists: profile !== undefined,
        explicit: roleConfig?.profile !== undefined,
        ...(profile?.seededFrom ? { seededFrom: profile.seededFrom } : {}),
      },
      model,
    },
    profile,
  };
}

/** 四角色摘要（DELIVERY_ROLES 序）。config null（.pi/delivery.yaml 缺失）按
 *  roles {} 处理：全角色同名、非显式、模型按剧本文件解析。 */
export function summarizeRoles(
  workspacePath: string,
  config: DeliveryRunnerConfig | null,
  deps?: ProjectionDeps,
): RoleSummary[] {
  return DELIVERY_ROLES.map((role) => summarizeWithProfile(workspacePath, role, config, deps).summary);
}

/** 组合预览（GET …/delivery/roles/[role]/preview）：摘要字段随行 + 三段展示。 */
export interface RolePromptPreview extends RoleSummary {
  /** `<ws>/AGENTS.md` 全文（缺文件 → null）——仅展示：pi 从 cwd 注入，不参与
   *  composed。 */
  agentsMd: string | null;
  /** AGENT_INVARIANT_CONTRACT({ role, key: "<KEY>" })——引擎锁定段。 */
  invariant: string;
  /** 剧本正文（缺 → ""）。 */
  body: string;
  /** composeRoleSystemPrompt(...)——与 launch 的 appendSystemPrompt 同一函数。 */
  composed: string;
}

/** 组合预览：key 用 <KEY> 占位；composed = 不变式 + 剧本正文（AGENTS.md 不进）。
 *  剧本与摘要共用同一次读取（summarizeWithProfile——不二次读盘）。 */
export function previewRolePrompt(
  workspacePath: string,
  role: DeliveryRole,
  config: DeliveryRunnerConfig | null,
  deps?: ProjectionDeps,
): RolePromptPreview {
  const { summary, profile } = summarizeWithProfile(workspacePath, role, config, deps);
  // AGENTS.md 全文（缺 → null）；读盘异常按缺（展示层容错，与剧本同一口径）。
  let agentsMd: string | null = null;
  try {
    agentsMd = readFileSync(join(resolve(workspacePath), "AGENTS.md"), "utf8");
  } catch {
    agentsMd = null;
  }
  const ctx = { role, key: PREVIEW_KEY_PLACEHOLDER };
  return {
    ...summary,
    agentsMd,
    invariant: AGENT_INVARIANT_CONTRACT(ctx),
    body: profile?.body ?? "",
    composed: composeRoleSystemPrompt(ctx, profile),
  };
}
