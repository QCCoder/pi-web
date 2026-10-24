// Phase-2 Task 1: 工作区交付自动化配置 `.pi/delivery.yaml`。
// 声明式配置：enabled 总开关 + 角色（designer/developer，Phase-3 T5 显式
// 双字段）的 profile/model 覆写 + 预算帽。
// 纯 fs/yaml 层——capability 门（assertAutomationCapable）由路由层在写入前
// 调用；后续任务（runner/claimer）消费本模块读取配置。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeAtomic } from "../service.ts";
import { WorkItemValidationError } from "../errors.ts";

export interface DeliveryRoleConfig {
  profile?: string;
  model?: { provider?: string; modelId: string };
}

export interface DeliveryRunnerConfig {
  schemaVersion: 1;
  enabled: boolean;
  /** 角色配置显式双字段（Phase-3 T5）：designer 与 developer 同形、各自可选；
   *  旧文件只有 designer 键照常解析，developer 读作缺省（undefined）。 */
  roles: { designer?: DeliveryRoleConfig; developer?: DeliveryRoleConfig };
  budget: { maxAttemptsPerInput: number; maxExecutionMinutes: number };
}

export const DEFAULT_DELIVERY_RUNNER_CONFIG: DeliveryRunnerConfig = {
  schemaVersion: 1,
  enabled: false,
  roles: {},
  budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
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

function parsePositiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new WorkItemValidationError(`${field} must be a positive integer`);
  }
  return value;
}

export function parseDeliveryRunnerConfig(value: unknown): DeliveryRunnerConfig {
  const record = requireObject(value, "delivery runner config");
  if (record.schemaVersion !== 1) {
    throw new WorkItemValidationError(
      `Unknown delivery runner config schemaVersion: ${String(record.schemaVersion)}`,
    );
  }
  const rolesRecord =
    record.roles === undefined ? {} : requireObject(record.roles, "roles");
  return {
    schemaVersion: 1,
    enabled:
      record.enabled === undefined ? false : requireBoolean(record.enabled, "enabled"),
    roles: {
      ...(rolesRecord.designer !== undefined
        ? { designer: parseRole(rolesRecord.designer, "roles.designer") }
        : {}),
      ...(rolesRecord.developer !== undefined
        ? { developer: parseRole(rolesRecord.developer, "roles.developer") }
        : {}),
    },
    budget: parseBudget(record.budget),
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
