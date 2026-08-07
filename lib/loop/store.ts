import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type {
  AutonomyLevel,
  LoopDefinition,
  LoopRun,
  LoopTriggerDefinition,
  WorkspaceLocation,
} from "./types.ts";

export class LoopValidationError extends Error {}
export class LoopConflictError extends Error {}
export class LoopNotFoundError extends Error {}

const LOOP_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUTONOMY_LEVELS = new Set<AutonomyLevel>(["L1", "L2", "L3"]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LoopValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function validateLoopId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!LOOP_ID_RE.test(id)) {
    throw new LoopValidationError("loop id must use lowercase letters, numbers, and hyphens");
  }
  return id;
}

function parseTriggers(value: unknown): LoopTriggerDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LoopValidationError("triggers must contain at least one trigger");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new LoopValidationError(`triggers[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const id = requiredString(record.id, `triggers[${index}].id`);
    const type = requiredString(record.type, `triggers[${index}].type`);
    const enabled = record.enabled !== false;
    if (type === "cron") {
      return {
        id,
        type,
        expression: requiredString(record.expression, `triggers[${index}].expression`),
        timezone: typeof record.timezone === "string" && record.timezone.trim()
          ? record.timezone.trim()
          : "Asia/Shanghai",
        enabled,
      };
    }
    if (type === "manual" || type === "message" || type === "webhook") {
      return { id, type, enabled };
    }
    throw new LoopValidationError(`unsupported trigger type: ${type}`);
  });
}

export async function readLoopDefinition(
  workspace: WorkspaceLocation,
  loopId: string,
): Promise<LoopDefinition> {
  const id = validateLoopId(loopId);
  const directory = resolve(workspace.path, "loops", id);
  let raw: unknown;
  try {
    raw = parse(await readFile(join(directory, "loop.yaml"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LoopNotFoundError(`loop not found: ${workspace.id}/${id}`);
    }
    throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LoopValidationError("loop.yaml must contain an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== 1) throw new LoopValidationError("schema_version must be 1");
  const fileId = validateLoopId(requiredString(record.id, "id"));
  if (fileId !== id) throw new LoopValidationError(`loop id ${fileId} must match directory ${id}`);
  const autonomy = (record.autonomy ?? "L1") as AutonomyLevel;
  if (!AUTONOMY_LEVELS.has(autonomy)) throw new LoopValidationError("autonomy must be L1, L2, or L3");
  const instructionsPath = join(directory, "LOOP.md");
  try {
    await readFile(instructionsPath, "utf8");
  } catch {
    throw new LoopValidationError(`${instructionsPath} is required`);
  }
  return {
    schemaVersion: 1,
    id,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
    description: typeof record.description === "string" ? record.description.trim() : "",
    enabled: record.enabled !== false,
    autonomy,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    directory,
    instructionsPath,
    statePath: join(directory, "STATE.md"),
    triggers: parseTriggers(record.triggers),
  };
}

export async function listLoopDefinitions(workspace: WorkspaceLocation): Promise<LoopDefinition[]> {
  let entries;
  try {
    entries = await readdir(join(workspace.path, "loops"), { withFileTypes: true });
  } catch {
    return [];
  }
  const loops: LoopDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      loops.push(await readLoopDefinition(workspace, entry.name));
    } catch (error) {
      console.warn(`[loop] ignoring invalid definition ${workspace.id}/${entry.name}:`, error);
    }
  }
  return loops.sort((a, b) => a.id.localeCompare(b.id));
}

function runsFile(workspace: WorkspaceLocation, loopId: string): string {
  return join(workspace.path, "loops", validateLoopId(loopId), "RUNS.jsonl");
}

export async function appendRunSnapshot(workspace: WorkspaceLocation, run: LoopRun): Promise<void> {
  await mkdir(join(workspace.path, "loops", run.loopId), { recursive: true });
  await appendFile(runsFile(workspace, run.loopId), `${JSON.stringify(run)}\n`, "utf8");
}

export async function listRunSnapshots(
  workspace: WorkspaceLocation,
  loopId?: string,
): Promise<LoopRun[]> {
  const loopIds = loopId
    ? [validateLoopId(loopId)]
    : (await listLoopDefinitions(workspace)).map((definition) => definition.id);
  const latest = new Map<string, LoopRun>();
  for (const id of loopIds) {
    let content = "";
    try {
      content = await readFile(runsFile(workspace, id), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line) as LoopRun;
        latest.set(run.id, run);
      } catch {
        // An append-only evidence log remains usable after a partial final line.
      }
    }
  }
  return [...latest.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
