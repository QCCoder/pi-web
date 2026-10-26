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
// composeRoleSystemPrompt / AGENT_INVARIANT_CONTRACT——单一读取器，不二次读盘。
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

/** 单角色摘要：读剧本（同一读取器）+ 按解析序定模型来源。 */
function summarizeRole(
  workspacePath: string,
  role: DeliveryRole,
  config: DeliveryRunnerConfig | null,
): RoleSummary {
  const roleConfig = config?.roles[role];
  const name = resolveRoleProfileName(role, roleConfig);
  // 读盘异常按缺席（readRoleProfile 缺文件/非法名静默 undefined；只读投影不抛）。
  let profile: RoleProfile | undefined;
  try {
    profile = readRoleProfile(workspacePath, name);
  } catch {
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
    role,
    profile: {
      name,
      path: roleProfilePath(workspacePath, name),
      exists: profile !== undefined,
      explicit: roleConfig?.profile !== undefined,
      ...(profile?.seededFrom ? { seededFrom: profile.seededFrom } : {}),
    },
    model,
  };
}

/** 四角色摘要（DELIVERY_ROLES 序）。config null（.pi/delivery.yaml 缺失）按
 *  roles {} 处理：全角色同名、非显式、模型按剧本文件解析。 */
export function summarizeRoles(
  workspacePath: string,
  config: DeliveryRunnerConfig | null,
): RoleSummary[] {
  return DELIVERY_ROLES.map((role) => summarizeRole(workspacePath, role, config));
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

/** 组合预览：key 用 <KEY> 占位；composed = 不变式 + 剧本正文（AGENTS.md 不进）。 */
export function previewRolePrompt(
  workspacePath: string,
  role: DeliveryRole,
  config: DeliveryRunnerConfig | null,
): RolePromptPreview {
  const summary = summarizeRole(workspacePath, role, config);
  let profile: RoleProfile | undefined;
  try {
    profile = readRoleProfile(workspacePath, summary.profile.name);
  } catch {
    profile = undefined;
  }
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
