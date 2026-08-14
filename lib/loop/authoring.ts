import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { LoopConflictError, LoopValidationError, readLoopDefinition, validateLoopId } from "./store.ts";
import type { CronTriggerDefinition, LoopDefinition, WorkspaceLocation } from "./types.ts";

export interface CreateLoopInput {
  id: string;
  name: string;
  description?: string;
  manualTrigger?: boolean;
  cronEnabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  goal: string;
  executionRules: string;
  verificationRules: string;
  gateRules?: string;
  improveRules: string;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LoopValidationError(`${field} is required`);
  }
  return value.trim();
}

function validateCron(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*,\/-]+$/.test(field))) {
    throw new LoopValidationError("cronExpression must be a five-field cron expression");
  }
  return normalized;
}

function validateTimezone(value: string): string {
  const timezone = value.trim() || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new LoopValidationError(`invalid timezone: ${timezone}`);
  }
  return timezone;
}

function renderInstructions(input: CreateLoopInput): string {
  const gate = input.gateRules?.trim();
  return [
    `# ${text(input.name, "name")}`,
    "",
    "## 目标",
    "",
    text(input.goal, "goal"),
    "",
    "## Round 契约",
    "",
    "1. `execute`",
    `   - Maker：${text(input.executionRules, "executionRules")}`,
    `   - Checker：${text(input.verificationRules, "verificationRules")}`,
    ...(gate ? [`   - Gate：${gate}`] : []),
    "2. `improve`",
    `   - ${text(input.improveRules, "improveRules")}`,
    "   - 根据本轮证据提出建议。",
    "",
    "## 完成条件",
    "",
    "- Maker 的产出已经由独立 Checker 验证。",
    "- 每个结论都能追溯到本轮证据。",
    "- 已记录本轮状态、异常和改进建议。",
    "",
  ].join("\n");
}

/** Creates a portable Workspace-owned definition; this is not a Runtime operation. */
export async function createLoopDefinition(
  workspace: WorkspaceLocation,
  input: CreateLoopInput,
): Promise<LoopDefinition> {
  const id = validateLoopId(input.id);
  const name = text(input.name, "name");
  const manualTrigger = input.manualTrigger !== false;
  const cronEnabled = input.cronEnabled === true;
  const triggers: Array<Record<string, unknown>> = [];
  if (cronEnabled) {
    triggers.push({
      id: "schedule",
      type: "cron",
      expression: validateCron(text(input.cronExpression, "cronExpression")),
      timezone: validateTimezone(input.timezone ?? "Asia/Shanghai"),
      enabled: true,
    });
  }
  if (manualTrigger) triggers.push({ id: "run-now", type: "manual", enabled: true });

  const loopsRoot = resolve(workspace.path, "loops");
  const directory = resolve(loopsRoot, id);
  if (!directory.startsWith(`${loopsRoot}/`)) throw new LoopValidationError("invalid loop directory");
  await mkdir(loopsRoot, { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LoopConflictError(`loop already exists: ${id}`);
    }
    throw error;
  }

  try {
    const yaml = stringify({
      schema_version: 1,
      id,
      name,
      description: input.description?.trim() ?? "",
      enabled: true,
      triggers,
    }, { lineWidth: 0 });
    await Promise.all([
      writeFile(join(directory, "loop.yaml"), yaml, { encoding: "utf8", flag: "wx" }),
      writeFile(join(directory, "LOOP.md"), renderInstructions(input), { encoding: "utf8", flag: "wx" }),
      writeFile(join(directory, "STATE.md"), "# State\n\n## Accepted baseline\n\n尚无。\n\n## Last audited improvement\n\n尚无。\n", { encoding: "utf8", flag: "wx" }),
      mkdir(join(directory, "agents")),
      mkdir(join(directory, "audit")),
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return readLoopDefinition(workspace, id);
}

export interface UpdateLoopInput {
  name?: string;
  description?: string;
  /** 启用/停用：关闭后 Host 不再自动触发，仍可手动运行。 */
  enabled?: boolean;
  manualTrigger?: boolean;
  cronEnabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  /** 原始 LOOP.md 内容；提供则覆盖写入 LOOP.md，不触碰 STATE.md / agents/。 */
  instructions?: string;
  /** agents/*.md 文件映射：string=写入/覆盖，null=删除。 */
  agents?: Record<string, string | null>;
}

const AGENT_FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

async function writeAgentFiles(workspace: WorkspaceLocation, loopId: string, agents: Record<string, string | null>): Promise<void> {
  const id = validateLoopId(loopId);
  const agentsDir = resolve(workspace.path, "loops", id, "agents");
  for (const [filename, content] of Object.entries(agents)) {
    if (!AGENT_FILE_RE.test(filename)) {
      throw new LoopValidationError(`agent filename must be lowercase/kebab-case ending in .md: ${filename}`);
    }
    const target = resolve(agentsDir, filename);
    if (!target.startsWith(`${agentsDir}/`)) throw new LoopValidationError(`invalid agent path: ${filename}`);
    if (content === null) {
      await rm(target, { force: true });
    } else {
      if (!content.trim()) throw new LoopValidationError(`agent ${filename} must not be empty`);
      await mkdir(agentsDir, { recursive: true });
      await writeFile(target, content, { encoding: "utf8" });
    }
  }
}

/** PATCH：只重写 loop.yaml（以及可选的 LOOP.md / agents/），绝不删目录、不动 STATE.md。 */
export async function updateLoopDefinition(
  workspace: WorkspaceLocation,
  loopId: string,
  input: UpdateLoopInput,
): Promise<LoopDefinition> {
  const id = validateLoopId(loopId);
  const existing = await readLoopDefinition(workspace, id);
  const directory = existing.directory;

  const name = input.name !== undefined ? text(input.name, "name") : existing.name;
  const description = input.description !== undefined ? input.description.trim() : existing.description;
  const enabled = input.enabled ?? existing.enabled;

  const triggersTouched = input.manualTrigger !== undefined || input.cronEnabled !== undefined
    || input.cronExpression !== undefined || input.timezone !== undefined;
  const existingCron = existing.triggers.find((trigger): trigger is CronTriggerDefinition => trigger.type === "cron");
  const hasManual = (rows: Array<Record<string, unknown>>) => rows.some((trigger) => trigger.type === "manual");
  let triggers: Array<Record<string, unknown>>;
  if (triggersTouched) {
    const cronEnabled = input.cronEnabled === true;
    triggers = [];
    if (cronEnabled) {
      triggers.push({
        id: "schedule",
        type: "cron",
        expression: validateCron(text(input.cronExpression ?? existingCron?.expression ?? "", "cronExpression")),
        timezone: validateTimezone(input.timezone ?? existingCron?.timezone ?? "Asia/Shanghai"),
        enabled: true,
      });
    }
    triggers.push({ id: "run-now", type: "manual", enabled: true });
  } else {
    triggers = existing.triggers.map((trigger) =>
      trigger.type === "cron"
        ? { id: trigger.id, type: "cron", expression: trigger.expression, timezone: trigger.timezone, enabled: trigger.enabled }
        : { id: trigger.id, type: trigger.type, enabled: trigger.enabled },
    );
    if (!hasManual(triggers)) triggers.push({ id: "run-now", type: "manual", enabled: true });
  }

  const yaml = stringify(
    { schema_version: 1, id, name, description, enabled, triggers },
    { lineWidth: 0 },
  );
  await writeFile(join(directory, "loop.yaml"), yaml, { encoding: "utf8" });

  if (input.instructions !== undefined) {
    const cleaned = input.instructions.trim();
    if (!cleaned) throw new LoopValidationError("instructions must not be empty");
    await writeFile(existing.instructionsPath, input.instructions, { encoding: "utf8" });
  }

  if (input.agents !== undefined) {
    await writeAgentFiles(workspace, id, input.agents);
  }

  return readLoopDefinition(workspace, id);
}

/** DELETE：移除整个 loop 目录（loop.yaml / LOOP.md / STATE.md / agents/ / audit/）。 */
export async function deleteLoopDefinition(workspace: WorkspaceLocation, loopId: string): Promise<void> {
  const id = validateLoopId(loopId);
  const loopsRoot = resolve(workspace.path, "loops");
  const directory = resolve(loopsRoot, id);
  if (!directory.startsWith(`${loopsRoot}/`)) throw new LoopValidationError("invalid loop directory");
  await readLoopDefinition(workspace, id); // 校验存在且合法
  await rm(directory, { recursive: true, force: true });
}
