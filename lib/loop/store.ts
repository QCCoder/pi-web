import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { createUlid } from "../workspaces/id.ts";
import {
  LOOP_JOB_SCHEMA_VERSION,
  type LoopJob,
  type LoopProduceFormat,
  type LoopRun,
  type UpsertLoopJobInput,
} from "./types.ts";

export class LoopValidationError extends Error {}
export class LoopConflictError extends Error {}
export class LoopNotFoundError extends Error {}

const JOB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_PRODUCE_FORMATS: readonly LoopProduceFormat[] = ["card", "text"];
const MAX_RUNS_RETURNED = 50;
const DEFAULT_WATCHLIST = "watchlist";

export function automationsDir(workspacePath: string): string {
  return join(workspacePath, "automations");
}

function jobsDir(workspacePath: string): string {
  return join(automationsDir(workspacePath), "jobs");
}

function jobFile(workspacePath: string, name: string): string {
  return join(jobsDir(workspacePath), `${name}.yaml`);
}

function runsDir(workspacePath: string): string {
  return join(automationsDir(workspacePath), "runs");
}

function runFile(workspacePath: string, name: string): string {
  return join(runsDir(workspacePath), `${name}.jsonl`);
}

function watchlistFile(workspacePath: string, watchlist: string): string {
  const stem = watchlist.trim() || DEFAULT_WATCHLIST;
  return join(automationsDir(workspacePath), `${stem}.md`);
}

export function validateJobName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!JOB_NAME_RE.test(normalized)) {
    throw new LoopValidationError(
      "Job name must contain lowercase letters, numbers, and single hyphens only",
    );
  }
  return normalized;
}

function parseProduceFormat(value: unknown): LoopProduceFormat {
  if (value === undefined) return "card";
  if (typeof value !== "string" || !VALID_PRODUCE_FORMATS.includes(value as LoopProduceFormat)) {
    throw new LoopValidationError(`produce_format must be one of: ${VALID_PRODUCE_FORMATS.join(", ")}`);
  }
  return value as LoopProduceFormat;
}

/** Normalize + validate a job definition from the API or disk. */
export function normalizeJob(input: UpsertLoopJobInput, existing?: LoopJob): LoopJob {
  const name = validateJobName(input.name);
  const prompt = input.prompt?.trim();
  if (!prompt) throw new LoopValidationError("prompt is required");
  const schedule = input.schedule?.trim() ?? "";
  if (!/^\s*([01]\d|2[0-3]):([0-5]\d)\s*$/.test(schedule)) {
    throw new LoopValidationError("schedule must be HH:MM (Asia/Shanghai), e.g. 15:05");
  }
  const now = new Date().toISOString();
  return {
    name,
    description: input.description?.trim() ?? existing?.description ?? "",
    prompt,
    schedule,
    watchlist: input.watchlist?.trim() ?? existing?.watchlist ?? DEFAULT_WATCHLIST,
    pushTarget: input.pushTarget?.trim() ?? existing?.pushTarget ?? "",
    produceFormat: parseProduceFormat(input.produceFormat),
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function serializeJob(job: LoopJob): string {
  return stringify({
    schema_version: LOOP_JOB_SCHEMA_VERSION,
    name: job.name,
    description: job.description,
    prompt: job.prompt,
    schedule: job.schedule,
    watchlist: job.watchlist,
    push_target: job.pushTarget,
    produce_format: job.produceFormat,
    enabled: job.enabled,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  }, { lineWidth: 0 });
}

export function parseJob(value: unknown, expectedName?: string): LoopJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LoopValidationError("Job must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== LOOP_JOB_SCHEMA_VERSION) {
    throw new LoopValidationError(`Unsupported job schema: ${String(record.schema_version)}`);
  }
  const name = validateJobName(String(record.name ?? ""));
  if (expectedName && name !== expectedName) {
    throw new LoopValidationError(`Job name "${name}" must match its filename "${expectedName}"`);
  }
  return normalizeJob(
    {
      name,
      description: typeof record.description === "string" ? record.description : "",
      prompt: typeof record.prompt === "string" ? record.prompt : "",
      schedule: typeof record.schedule === "string" ? record.schedule : "",
      watchlist: typeof record.watchlist === "string" ? record.watchlist : "",
      pushTarget: typeof record.push_target === "string" ? record.push_target : "",
      produceFormat: record.produce_format as LoopProduceFormat | undefined,
      enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
    },
    {
      name,
      description: "",
      prompt: "",
      schedule: "",
      watchlist: DEFAULT_WATCHLIST,
      pushTarget: "",
      produceFormat: "card",
      enabled: true,
      createdAt: typeof record.created_at === "string" ? record.created_at : "",
      updatedAt: typeof record.updated_at === "string" ? record.updated_at : "",
    },
  );
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${createUlid()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function listJobs(workspacePath: string): Promise<LoopJob[]> {
  let entries: string[];
  try {
    entries = await readdir(jobsDir(workspacePath));
  } catch {
    return [];
  }
  const jobs: LoopJob[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const name = entry.replace(/\.ya?ml$/, "");
    try {
      const content = await readFile(jobFile(workspacePath, name), "utf8");
      jobs.push(parseJob(parse(content), name));
    } catch {
      // Skip malformed job files so one bad file doesn't break listing.
    }
  }
  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readJob(workspacePath: string, name: string): Promise<LoopJob> {
  const normalized = validateJobName(name);
  let content: string;
  try {
    content = await readFile(jobFile(workspacePath, normalized), "utf8");
  } catch {
    throw new LoopNotFoundError(`Loop job not found: ${normalized}`);
  }
  return parseJob(parse(content), normalized);
}

export async function writeJob(workspacePath: string, input: UpsertLoopJobInput): Promise<LoopJob> {
  const normalized = validateJobName(input.name);
  let existing: LoopJob | undefined;
  try {
    existing = await readJob(workspacePath, normalized);
  } catch (error) {
    if (!(error instanceof LoopNotFoundError)) throw error;
  }
  const job = normalizeJob(input, existing);
  await writeFileAtomic(jobFile(workspacePath, normalized), serializeJob(job));
  return job;
}

export async function deleteJob(workspacePath: string, name: string): Promise<void> {
  const normalized = validateJobName(name);
  try {
    await rm(jobFile(workspacePath, normalized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Run history is retained for auditability even after a job is deleted.
}

export async function appendRun(workspacePath: string, name: string, run: LoopRun): Promise<void> {
  const normalized = validateJobName(name);
  await mkdir(runsDir(workspacePath), { recursive: true });
  await appendFile(runFile(workspacePath, normalized), `${JSON.stringify(run)}\n`, "utf8");
}

export async function listRuns(
  workspacePath: string,
  name: string,
  limit = MAX_RUNS_RETURNED,
): Promise<LoopRun[]> {
  const normalized = validateJobName(name);
  let content: string;
  try {
    content = await readFile(runFile(workspacePath, normalized), "utf8");
  } catch {
    return [];
  }
  const runs: LoopRun[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      runs.push(JSON.parse(trimmed) as LoopRun);
    } catch {
      // Skip malformed lines.
    }
  }
  // Newest first.
  runs.reverse();
  return runs.slice(0, Math.max(0, limit));
}

export async function readWatchlist(workspacePath: string, watchlist: string): Promise<string> {
  try {
    return await readFile(watchlistFile(workspacePath, watchlist), "utf8");
  } catch {
    return "";
  }
}
