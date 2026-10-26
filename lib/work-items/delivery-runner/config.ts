// Phase-2 Task 1: 工作区交付自动化配置 `.pi/delivery.yaml`。
// 声明式配置：enabled 总开关 + 角色（designer/developer，Phase-3 T5 显式
// 双字段）的 profile/model 覆写 + 预算帽；Phase-4 T1 增验证命令
// verification.checks（人维护——agent 只能触发不能自造，spec
// 2026-10-24-phase-four §1.2/§7）。
// Seam-repositioning Task 1（2026-10-26）：config v2——roles 各键同形
// （词表 ./roles.ts——本模块从 roles 引类型、绝不从 pool 引，防循环）；
// schemaVersion 输入 1|2 兼容（v1 旧文件照常读），输出恒 2。
// final-arch step-2 Task 1（2026-10-26）：增 attention 块（ask-a-human 澄清的
// nudge/park 天数阈值）——解析后必有，缺块回填默认 3/7，旧文件免迁移。
// final-arch step-3 Task 1（2026-10-26）：增 stages.review 开关（先审后跑——
// reviewer 人工审查轮，Task 2/3 接流转）——解析后必有，缺块回填
// {review:{enabled:false}}（旧文件免迁移、行为不变）；未知 stage 键 →
// Validation（step-4 进 integrate/acceptance）。
// Task 4（2026-10-26）：verifier 退役——roles.verifier 键按 legacy 键处理：
// 跳过（不进 roles）+ console.warn 每进程一次（写回即丢，round-trip 不带出）；
// 其余未知键（拼错）仍 Validation。
// 纯 fs/yaml 层——capability 门（assertAutomationCapable）由路由层在写入前
// 调用；后续任务（runner/claimer）消费本模块读取配置。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeAtomic } from "../service.ts";
import { WorkItemValidationError } from "../errors.ts";
import { isDeliveryRole, LEGACY_DELIVERY_ROLES, type DeliveryRole } from "./roles.ts";

export interface DeliveryRoleConfig {
  profile?: string;
  model?: { provider?: string; modelId: string };
}

export interface DeliveryRunnerConfig {
  /** 配置版本：输出恒 2（parse 把 v1 输入也规范化为 2；落盘即迁移）。 */
  schemaVersion: 2;
  enabled: boolean;
  /** 角色配置各键同形（Seam-repositioning T1，词表 ./roles.ts）：活值四键
   *  （designer/developer/reviewer/release-preparer）各自可选；键必须 ∈
   *  DELIVERY_ROLES（否则 Validation）。legacy 键 verifier（final-arch step-3
   *  退役）→ 跳过不进 roles + 每进程告警一次；旧文件只有 designer/developer 键
   *  照常解析，未配置的角色读作缺省（undefined）。 */
  roles: Partial<Record<DeliveryRole, DeliveryRoleConfig>>;
  budget: { maxAttemptsPerInput: number; maxExecutionMinutes: number };
  /** attention 队列（final-arch step-2）：ask-a-human 澄清超过 nudgeAfterDays
   *  未答 → nudge 提醒；超过 parkAfterDays 未答 → park 挂起。解析后必有
   *  （缺块回填默认 3/7——旧 v1 文件免迁移）；正整数且 park ≥ nudge。 */
  attention: { nudgeAfterDays: number; parkAfterDays: number };
  /** 流程阶段开关（final-arch step-3，解析后必有——缺块回填全关）。review =
   *  先审后跑：developer 提交候选后先进 reviewer 人工审查轮（enabled 才进）。
   *  已知 stage 键逐步扩充（step-4：integrate/acceptance）；未知键 → Validation
   *  （拼错静默失明比报错危险）。 */
  stages: { review: { enabled: boolean } };
  /** 验证命令（Phase-4 spec §7）：可选缺省 undefined（= 无配置，system 检查步
   *  谓词落 checks-empty 不 due）；空数组合法——等同无配置（检查步按空处理）。 */
  verification?: { checks: DeliveryCheckConfig[] };
}

/** 单条验证命令（Phase-4 spec §7）：name/command 必填；repositoryId 可选——
 *  缺省 = 候选首仓（池/claim 侧解析，spec §3）；timeout_seconds 可选，整数
 *  1–3600（秒），服务端执行器缺省 600s（T2）。 */
export interface DeliveryCheckConfig {
  name: string;
  repositoryId?: string;
  command: string;
  timeout_seconds?: number;
}

const CHECK_TIMEOUT_SECONDS_MIN = 1;
const CHECK_TIMEOUT_SECONDS_MAX = 3600;

export const DEFAULT_DELIVERY_RUNNER_CONFIG: DeliveryRunnerConfig = {
  schemaVersion: 2,
  enabled: false,
  roles: {},
  budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  attention: { nudgeAfterDays: 3, parkAfterDays: 7 },
  stages: { review: { enabled: false } },
};

const DELIVERY_CAPABILITY_REQUIREMENTS = ["work-items", "workflows"] as const;

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkItemValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkItemValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function parseRole(value: unknown, field: string): DeliveryRoleConfig {
  const record = requireObject(value, field);
  const model = record.model === undefined ? undefined : parseRoleModel(record.model, `${field}.model`);
  return {
    ...(record.profile !== undefined ? { profile: optionalNonEmptyString(record.profile, `${field}.profile`) } : {}),
    ...(model ? { model } : {}),
  };
}

function parseRoleModel(value: unknown, field: string): { provider?: string; modelId: string } {
  const record = requireObject(value, field);
  const modelId = optionalNonEmptyString(record.modelId, `${field}.modelId`);
  if (modelId === undefined) {
    throw new WorkItemValidationError(`${field}.modelId must be a non-empty string`);
  }
  return {
    ...(record.provider !== undefined
      ? { provider: optionalNonEmptyString(record.provider, `${field}.provider`) }
      : {}),
    modelId,
  };
}

function parseBudget(value: unknown): DeliveryRunnerConfig["budget"] {
  // 字段缺省回填默认（3 / 30）；显式提供的必须是正整数（0/负数/小数 → Validation）。
  const record = value === undefined ? {} : requireObject(value, "budget");
  return {
    maxAttemptsPerInput: parsePositiveInteger(
      record.maxAttemptsPerInput,
      "budget.maxAttemptsPerInput",
      DEFAULT_DELIVERY_RUNNER_CONFIG.budget.maxAttemptsPerInput,
    ),
    maxExecutionMinutes: parsePositiveInteger(
      record.maxExecutionMinutes,
      "budget.maxExecutionMinutes",
      DEFAULT_DELIVERY_RUNNER_CONFIG.budget.maxExecutionMinutes,
    ),
  };
}

function parseAttention(value: unknown): DeliveryRunnerConfig["attention"] {
  // 缺块回填默认（3 / 7）——v1 旧文件免迁移；显式提供的必须是正整数
  // （parsePositiveInteger 同 budget），且 park ≥ nudge（nudge 抬过缺省 park
  // 的组合同样拒绝——包括只写 nudge 一键时与缺省 7 相撞）。
  const record = value === undefined ? {} : requireObject(value, "attention");
  const nudgeAfterDays = parsePositiveInteger(
    record.nudgeAfterDays,
    "attention.nudgeAfterDays",
    DEFAULT_DELIVERY_RUNNER_CONFIG.attention.nudgeAfterDays,
  );
  const parkAfterDays = parsePositiveInteger(
    record.parkAfterDays,
    "attention.parkAfterDays",
    DEFAULT_DELIVERY_RUNNER_CONFIG.attention.parkAfterDays,
  );
  if (parkAfterDays < nudgeAfterDays) {
    throw new WorkItemValidationError(
      "attention.parkAfterDays must be >= attention.nudgeAfterDays",
    );
  }
  return { nudgeAfterDays, parkAfterDays };
}

function parsePositiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new WorkItemValidationError(`${field} must be a positive integer`);
  }
  return value;
}

/** legacy roles 键（verifier）的退役告警——每进程恰一次（模块级旗标；解析
 *  是纯函数，告警是迁移提示不是数据）。 */
let legacyRoleWarned = false;
function warnLegacyRoleOnce(key: string): void {
  if (legacyRoleWarned) return;
  legacyRoleWarned = true;
  console.warn(
    `[delivery-runner] roles.${key} is deprecated `
    + "(verifier role retired; checks run as a system step) — ignored",
  );
}

/** verification 块（Phase-4）：checks 必须是数组（含空——空=合法，等同无配置），
 *  逐条校验见 parseCheck。 */
function parseVerification(value: unknown): { checks: DeliveryCheckConfig[] } {
  const record = requireObject(value, "verification");
  if (!Array.isArray(record.checks)) {
    throw new WorkItemValidationError("verification.checks must be an array");
  }
  return {
    checks: record.checks.map((entry, index) =>
      parseCheck(entry, `verification.checks[${index}]`)),
  };
}

/** 单条验证命令：可选字段缺席时键整个剥掉（与 roles 的条件展开同一习语）。 */
function parseCheck(value: unknown, field: string): DeliveryCheckConfig {
  const record = requireObject(value, field);
  const name = optionalNonEmptyString(record.name, `${field}.name`);
  if (name === undefined) {
    throw new WorkItemValidationError(`${field}.name must be a non-empty string`);
  }
  const command = optionalNonEmptyString(record.command, `${field}.command`);
  if (command === undefined) {
    throw new WorkItemValidationError(`${field}.command must be a non-empty string`);
  }
  const timeout = parseTimeoutSeconds(record.timeout_seconds, `${field}.timeout_seconds`);
  return {
    name,
    ...(record.repositoryId !== undefined
      ? { repositoryId: optionalNonEmptyString(record.repositoryId, `${field}.repositoryId`) }
      : {}),
    command,
    ...(timeout !== undefined ? { timeout_seconds: timeout } : {}),
  };
}

function parseTimeoutSeconds(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" || !Number.isInteger(value) ||
    value < CHECK_TIMEOUT_SECONDS_MIN || value > CHECK_TIMEOUT_SECONDS_MAX
  ) {
    throw new WorkItemValidationError(
      `${field} must be an integer between ${CHECK_TIMEOUT_SECONDS_MIN} and ${CHECK_TIMEOUT_SECONDS_MAX} (seconds)`,
    );
  }
  return value;
}

/** stages 块（final-arch step-3）：解析后必有——块/子块缺席回填
 *  {review:{enabled:false}}（旧文件免迁移、行为不变）；已知 stage（当前只有
 *  review）逐个校验，enabled 缺省回填 false、显式必须布尔；未知 stage 键 →
 *  Validation（step-4 进 integrate/acceptance）。 */
function parseStages(value: unknown): DeliveryRunnerConfig["stages"] {
  const record = value === undefined ? {} : requireObject(value, "stages");
  const knownStages = new Set(["review"]);
  for (const key of Object.keys(record)) {
    if (!knownStages.has(key)) {
      throw new WorkItemValidationError(`stages.${key} is not a known stage`);
    }
  }
  const reviewRecord =
    record.review === undefined ? {} : requireObject(record.review, "stages.review");
  return {
    review: {
      enabled:
        reviewRecord.enabled === undefined
          ? false
          : requireBoolean(reviewRecord.enabled, "stages.review.enabled"),
    },
  };
}

export function parseDeliveryRunnerConfig(value: unknown): DeliveryRunnerConfig {
  const record = requireObject(value, "delivery runner config");
  // v1|v2 输入都收（v1 旧文件免迁移），输出恒 2；其余版本 → Validation。
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new WorkItemValidationError(
      `Unknown delivery runner config schemaVersion: ${String(record.schemaVersion)}`,
    );
  }
  const rolesRecord =
    record.roles === undefined ? {} : requireObject(record.roles, "roles");
  // 各键同形：遍历传入键逐个校验/解析——legacy 键（verifier，退役）→ 跳过
  // 不进 roles + 告警一次（写回即丢——round-trip 不带出）；键 ∉ DELIVERY_ROLES
  // （拼错如 desginer）→ Validation；v1 文件只带 designer/developer 键不受影响。
  const roles: Partial<Record<DeliveryRole, DeliveryRoleConfig>> = {};
  for (const key of Object.keys(rolesRecord)) {
    if ((LEGACY_DELIVERY_ROLES as readonly string[]).includes(key)) {
      warnLegacyRoleOnce(key);
      continue;
    }
    if (!isDeliveryRole(key)) {
      throw new WorkItemValidationError(`roles.${key} is not a delivery role`);
    }
    roles[key] = parseRole(rolesRecord[key], `roles.${key}`);
  }
  return {
    schemaVersion: 2,
    enabled:
      record.enabled === undefined ? false : requireBoolean(record.enabled, "enabled"),
    roles,
    budget: parseBudget(record.budget),
    attention: parseAttention(record.attention),
    stages: parseStages(record.stages),
    ...(record.verification !== undefined
      ? { verification: parseVerification(record.verification) }
      : {}),
  };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new WorkItemValidationError(`${field} must be a boolean`);
  }
  return value;
}

export function deliveryConfigPath(workspacePath: string): string {
  return join(workspacePath, ".pi", "delivery.yaml");
}

/** 文件缺失 → null（视为 disabled）。坏 YAML/坏结构 → Validation（路由 400）。 */
export async function readDeliveryRunnerConfig(
  workspacePath: string,
): Promise<DeliveryRunnerConfig | null> {
  let content: string;
  try {
    content = await readFile(deliveryConfigPath(workspacePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new WorkItemValidationError(
      `delivery runner config is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseDeliveryRunnerConfig(parsed);
}

export async function writeDeliveryRunnerConfig(
  workspacePath: string,
  config: DeliveryRunnerConfig,
): Promise<void> {
  await writeAtomic(deliveryConfigPath(workspacePath), stringify(config));
}

/** capabilities 需同时含 "work-items" 与 "workflows" 才允许交付自动化。 */
export function assertAutomationCapable(manifest: {
  capabilities: readonly string[];
}): void {
  const missing = DELIVERY_CAPABILITY_REQUIREMENTS.filter(
    (capability) => !manifest.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new WorkItemValidationError(
      "delivery automation requires work-items and workflows capabilities",
    );
  }
}
