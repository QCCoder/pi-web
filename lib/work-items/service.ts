import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { createUlid } from "../workspaces/id.ts";
import {
  commitWorkspaceChanges,
  getWorkspace,
  readWorkspaceManifest,
  reserveWorkItemKey,
  withWorkspaceWriteLock,
} from "../workspaces/service.ts";
import type { WorkspaceManifest } from "../workspaces/types.ts";
import {
  WORK_ITEM_SCHEMA_VERSION,
  type CreateWorkItemInput,
  type InvalidWorkItem,
  type RecordWorkItemMilestoneInput,
  type UpdateWorkItemContentInput,
  type UpdateWorkItemInput,
  type WorkItemActor,
  type WorkItemDetail,
  type WorkItemEvent,
  type WorkItemExternalRef,
  type WorkItemPhase,
  type WorkItemPriority,
  type WorkItemRecord,
  type WorkItemStatus,
  type WorkItemType,
} from "./types.ts";

const WORK_ITEM_KEY_RE = /^(REQ|BUG)-\d{4,}$/;
const WORK_ITEM_DIRECTORY_RE = /^((?:REQ|BUG)-\d{4,})(?:-|$)/;
const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];
const WORK_ITEM_PHASES: readonly WorkItemPhase[] = [
  "intake",
  "analysis",
  "requirement_approval",
  "design",
  "plan_approval",
  "implementation",
  "verification",
  "complete",
];
const WORK_ITEM_PRIORITIES: readonly WorkItemPriority[] = ["P0", "P1", "P2", "P3"];
const WORK_ITEM_ACTORS: readonly WorkItemActor[] = ["user", "agent", "system", "external"];

export class WorkItemValidationError extends Error {}
export class WorkItemConflictError extends Error {}
export class WorkItemNotFoundError extends Error {}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkItemValidationError(`${field} is required`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new WorkItemValidationError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => String(entry).trim()))];
}

function parseExternalRef(value: unknown): WorkItemExternalRef {
  if (!value || typeof value !== "object") {
    throw new WorkItemValidationError("external must be an object");
  }
  const record = value as Record<string, unknown>;
  const source = requireText(record.source, "external.source");
  const sourceId = requireText(record.source_id ?? record.sourceId, "external.sourceId");
  return {
    source,
    sourceId,
    ...(typeof record.url === "string" && record.url ? { url: record.url } : {}),
    lastSyncedAt: requireText(record.last_synced_at ?? record.lastSyncedAt, "external.lastSyncedAt"),
  };
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new WorkItemValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new WorkItemValidationError(`${field} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function workItemDirectoryName(type: WorkItemType): "requirements" | "bugs" {
  return type === "requirement" ? "requirements" : "bugs";
}

function workItemTypeFromKey(key: string): WorkItemType {
  if (!WORK_ITEM_KEY_RE.test(key)) throw new WorkItemValidationError(`Invalid Work Item key: ${key}`);
  return key.startsWith("REQ-") ? "requirement" : "bug";
}

function workItemKeyFromDirectoryName(name: string): string | null {
  return name.match(WORK_ITEM_DIRECTORY_RE)?.[1] ?? null;
}

function workItemTitleSlug(title: string): string {
  const normalized = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(normalized).slice(0, 48).join("").replace(/-+$/g, "") || "未命名";
}

async function findWorkItemDirectory(
  workspacePath: string,
  type: WorkItemType,
  key: string,
): Promise<string> {
  const root = join(workspacePath, workItemDirectoryName(type));
  const exactPath = join(root, key);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const match = entries.find((entry) =>
      entry.isDirectory() && workItemKeyFromDirectoryName(entry.name) === key
    );
    return match ? join(root, match.name) : exactPath;
  } catch {
    return exactPath;
  }
}

function serializeWorkItem(item: WorkItemRecord): string {
  return stringify({
    schema_version: item.schemaVersion,
    id: item.id,
    key: item.key,
    revision: item.revision,
    type: item.type,
    title: item.title,
    status: item.status,
    phase: item.phase,
    priority: item.priority,
    repositories: item.repositories,
    tags: item.tags,
    conversations: item.conversations,
    related_items: item.relatedItems,
    designs: item.designs,
    plans: item.plans,
    ...(item.external
      ? {
          external: {
            source: item.external.source,
            source_id: item.external.sourceId,
            ...(item.external.url ? { url: item.external.url } : {}),
            last_synced_at: item.external.lastSyncedAt,
          },
        }
      : {}),
    archived_at: item.archivedAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }, { lineWidth: 0 });
}

export function parseWorkItem(value: unknown): WorkItemRecord {
  if (!value || typeof value !== "object") {
    throw new WorkItemValidationError("Work Item metadata must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== WORK_ITEM_SCHEMA_VERSION) {
    throw new WorkItemValidationError(`Unsupported Work Item schema: ${String(record.schema_version)}`);
  }
  const type = requireEnum(record.type, ["requirement", "bug"] as const, "type");
  const key = requireText(record.key, "key");
  if (workItemTypeFromKey(key) !== type) {
    throw new WorkItemValidationError(`Work Item key ${key} does not match type ${type}`);
  }
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    id: requireText(record.id, "id"),
    key,
    revision: parseInteger(record.revision, "revision", 1),
    type,
    title: requireText(record.title, "title"),
    status: requireEnum(record.status, WORK_ITEM_STATUSES, "status"),
    phase: requireEnum(record.phase, WORK_ITEM_PHASES, "phase"),
    priority: requireEnum(record.priority, WORK_ITEM_PRIORITIES, "priority"),
    repositories: requireStringArray(record.repositories, "repositories"),
    tags: requireStringArray(record.tags, "tags"),
    conversations: requireStringArray(record.conversations, "conversations"),
    relatedItems: requireStringArray(record.related_items, "related_items"),
    designs: requireStringArray(record.designs, "designs"),
    plans: requireStringArray(record.plans, "plans"),
    ...(record.external !== undefined && record.external !== null
      ? { external: parseExternalRef(record.external) }
      : {}),
    archivedAt: record.archived_at === undefined || record.archived_at === null
      ? null
      : requireText(record.archived_at, "archived_at"),
    createdAt: requireText(record.created_at, "created_at"),
    updatedAt: requireText(record.updated_at, "updated_at"),
  };
}

function parseEvent(line: string, index: number): WorkItemEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new WorkItemValidationError(`events.jsonl line ${index + 1} is invalid JSON`);
  }
  if (!value || typeof value !== "object") {
    throw new WorkItemValidationError(`events.jsonl line ${index + 1} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actor = requireEnum(record.actor, WORK_ITEM_ACTORS, `events[${index}].actor`);
  return {
    id: requireText(record.id, `events[${index}].id`),
    at: requireText(record.at, `events[${index}].at`),
    type: requireText(record.type, `events[${index}].type`),
    actor,
    ...(typeof record.conversation_id === "string" && record.conversation_id
      ? { conversationId: record.conversation_id }
      : {}),
    ...(record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? { data: record.data as Record<string, unknown> }
      : {}),
  };
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
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

function eventFor(
  type: string,
  actor: WorkItemActor,
  conversationId?: string,
  data?: Record<string, unknown>,
): WorkItemEvent {
  return {
    id: createUlid(),
    at: new Date().toISOString(),
    type,
    actor,
    ...(conversationId ? { conversationId } : {}),
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  };
}

async function appendEvent(itemPath: string, event: WorkItemEvent): Promise<void> {
  const serialized = {
    id: event.id,
    at: event.at,
    type: event.type,
    actor: event.actor,
    ...(event.conversationId ? { conversation_id: event.conversationId } : {}),
    ...(event.data ? { data: event.data } : {}),
  };
  await appendFile(join(itemPath, "events.jsonl"), `${JSON.stringify(serialized)}\n`, "utf8");
}

function renderWorkItemReadme(title: string, originalDescription: string, type: WorkItemType): string {
  const middle = type === "bug"
    ? `## Reproduction

## Expected Behavior

## Actual Behavior`
    : `## Context

## Desired Behavior`;
  return `# ${title}

## Original Description

${originalDescription.trim()}

${middle}

## Agent Analysis

## Acceptance Criteria
`;
}

function originalDescription(content: string): string | null {
  const match = content.match(/^## Original Description\s*\n([\s\S]*?)(?=^## |\s*$)/m);
  return match ? match[1].trim() : null;
}

function validateRepositorySelection(manifest: WorkspaceManifest, repositories: string[]): void {
  const registered = new Set(manifest.repositories.map((repository) => repository.id));
  for (const repository of repositories) {
    if (!registered.has(repository)) {
      throw new WorkItemValidationError(`Unknown Workspace repository: ${repository}`);
    }
  }
}

export async function readWorkItem(workspacePath: string, key: string): Promise<WorkItemDetail> {
  const type = workItemTypeFromKey(key);
  const path = await findWorkItemDirectory(workspacePath, type, key);
  let metadata: string;
  try {
    metadata = await readFile(join(path, "item.yaml"), "utf8");
  } catch {
    throw new WorkItemNotFoundError(`Work Item not found: ${key}`);
  }
  const item = parseWorkItem(parse(metadata));
  if (item.key !== workItemKeyFromDirectoryName(basename(path))) {
    throw new WorkItemValidationError(`Work Item directory must begin with ${item.key}`);
  }
  const [content, eventContent] = await Promise.all([
    readFile(join(path, "README.md"), "utf8"),
    readFile(join(path, "events.jsonl"), "utf8"),
  ]);
  const eventLines = eventContent.split("\n").filter(Boolean);
  return {
    path,
    item,
    content,
    events: eventLines.map(parseEvent),
  };
}

export async function listWorkItems(
  workspacePath: string,
): Promise<{ items: WorkItemRecord[]; invalid: InvalidWorkItem[] }> {
  const items: WorkItemRecord[] = [];
  const invalid: InvalidWorkItem[] = [];
  for (const [directory, prefix] of [["requirements", "REQ-"], ["bugs", "BUG-"]] as const) {
    const root = join(workspacePath, directory);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const path = join(root, entry.name);
      const key = workItemKeyFromDirectoryName(entry.name);
      try {
        if (!key) throw new WorkItemValidationError(`Invalid Work Item directory: ${entry.name}`);
        items.push((await readWorkItem(workspacePath, key)).item);
      } catch (error) {
        invalid.push({
          path,
          key: key ?? entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { items, invalid };
}

/** Find the work item a session is linked to via its `conversations` field.
 *  Used by the Loop host to name an orchestrator session after the requirement
 *  it picked (so Loop runs don't all share an identical title). Returns the
 *  first match's `{ key, title }` or undefined. Reads only `item.yaml` (no
 *  README/events) so it stays cheap enough to run at every round boundary. */
export async function findWorkItemByConversation(
  workspacePath: string,
  sessionId: string,
): Promise<{ key: string; title: string } | undefined> {
  for (const [directory, prefix] of [["requirements", "REQ-"], ["bugs", "BUG-"]] as const) {
    const root = join(workspacePath, directory);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const key = workItemKeyFromDirectoryName(entry.name);
      if (!key) continue;
      try {
        const raw = await readFile(join(root, entry.name, "item.yaml"), "utf8");
        const item = parseWorkItem(parse(raw));
        if (Array.isArray(item.conversations) && item.conversations.includes(sessionId)) {
          return { key, title: item.title };
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export async function createWorkItem(
  workspaceId: string,
  input: CreateWorkItemInput,
): Promise<WorkItemDetail> {
  const { path: workspacePath, manifest } = await getWorkspace(workspaceId);
  const type = requireEnum(input.type, ["requirement", "bug"] as const, "type");
  const title = requireText(input.title, "title");
  const description = requireText(input.originalDescription, "originalDescription");
  const repositories = requireStringArray(input.repositories, "repositories");
  validateRepositorySelection(manifest, repositories);
  const tags = requireStringArray(input.tags, "tags");
  const external = input.external === undefined ? undefined : parseExternalRef(input.external);
  const priority = input.priority === undefined
    ? "P2"
    : requireEnum(input.priority, WORK_ITEM_PRIORITIES, "priority");
  const actor = input.actor === undefined
    ? "user"
    : requireEnum(input.actor, WORK_ITEM_ACTORS, "actor");
  const key = await reserveWorkItemKey(workspacePath, type);
  const now = new Date().toISOString();
  const item: WorkItemRecord = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    id: createUlid(),
    key,
    revision: 1,
    type,
    title,
    status: "open",
    phase: "intake",
    priority,
    repositories,
    tags,
    conversations: input.conversationId ? [input.conversationId] : [],
    relatedItems: [],
    designs: [],
    plans: [],
    ...(external ? { external } : {}),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const finalPath = join(
    workspacePath,
    workItemDirectoryName(type),
    `${key}-${workItemTitleSlug(title)}`,
  );
  const temporaryPath = `${finalPath}.creating-${createUlid()}`;
  await mkdir(join(temporaryPath, "attachments"), { recursive: true });
  try {
    await Promise.all([
      writeFile(join(temporaryPath, "item.yaml"), serializeWorkItem(item), "utf8"),
      writeFile(join(temporaryPath, "README.md"), renderWorkItemReadme(title, description, type), "utf8"),
      writeFile(join(temporaryPath, "events.jsonl"), "", "utf8"),
    ]);
    await appendEvent(
      temporaryPath,
      eventFor("work_item.created", actor, input.conversationId, { key, type }),
    );
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
  await commitWorkspaceChanges(workspacePath, `workspace: create ${key}`);
  return readWorkItem(workspacePath, key);
}

function changedFields(before: WorkItemRecord, after: WorkItemRecord): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of [
    "title",
    "status",
    "phase",
    "priority",
    "repositories",
    "tags",
    "conversations",
    "relatedItems",
    "designs",
    "plans",
    "archivedAt",
  ] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}

export async function updateWorkItem(
  workspaceId: string,
  key: string,
  input: UpdateWorkItemInput,
): Promise<WorkItemDetail> {
  const { path: workspacePath } = await getWorkspace(workspaceId);
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    if (input.expectedRevision !== current.item.revision) {
      throw new WorkItemConflictError(
        `Expected revision ${input.expectedRevision}, current revision is ${current.item.revision}`,
      );
    }
    const manifest = await readWorkspaceManifest(workspacePath);
    const next: WorkItemRecord = structuredClone(current.item);
    if (input.title !== undefined) next.title = requireText(input.title, "title");
    if (input.status !== undefined) next.status = requireEnum(input.status, WORK_ITEM_STATUSES, "status");
    if (input.phase !== undefined) next.phase = requireEnum(input.phase, WORK_ITEM_PHASES, "phase");
    if (input.priority !== undefined) next.priority = requireEnum(input.priority, WORK_ITEM_PRIORITIES, "priority");
    if (input.repositories !== undefined) {
      next.repositories = requireStringArray(input.repositories, "repositories");
      validateRepositorySelection(manifest, next.repositories);
    }
    if (input.tags !== undefined) next.tags = requireStringArray(input.tags, "tags");
    if (input.conversations !== undefined) next.conversations = requireStringArray(input.conversations, "conversations");
    if (input.relatedItems !== undefined) next.relatedItems = requireStringArray(input.relatedItems, "relatedItems");
    if (input.designs !== undefined) next.designs = requireStringArray(input.designs, "designs");
    if (input.plans !== undefined) next.plans = requireStringArray(input.plans, "plans");
    if (input.archived !== undefined) {
      if (typeof input.archived !== "boolean") {
        throw new WorkItemValidationError("archived must be a boolean");
      }
      next.archivedAt = input.archived ? (next.archivedAt ?? new Date().toISOString()) : null;
    }
    const changes = changedFields(current.item, next);
    if (Object.keys(changes).length === 0) return current;
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    await writeAtomic(join(current.path, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      current.path,
      eventFor(
        "work_item.updated",
        input.actor ?? "user",
        input.conversationId,
        { revision: next.revision, changes },
      ),
    );
    await commitWorkspaceChanges(workspacePath, `workspace: update ${key}`);
    return readWorkItem(workspacePath, key);
  });
}

export async function updateWorkItemContent(
  workspaceId: string,
  key: string,
  input: UpdateWorkItemContentInput,
): Promise<WorkItemDetail> {
  const { path: workspacePath } = await getWorkspace(workspaceId);
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    if (input.expectedRevision !== current.item.revision) {
      throw new WorkItemConflictError(
        `Expected revision ${input.expectedRevision}, current revision is ${current.item.revision}`,
      );
    }
    const content = requireText(input.content, "content") + "\n";
    const previousOriginal = originalDescription(current.content);
    const nextOriginal = originalDescription(content);
    if (!nextOriginal) {
      throw new WorkItemValidationError("README.md must contain an Original Description section");
    }
    if (previousOriginal !== nextOriginal) {
      throw new WorkItemValidationError("Original Description cannot be overwritten");
    }
    if (content === current.content) return current;
    const next = structuredClone(current.item);
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    await writeAtomic(join(current.path, "README.md"), content);
    await writeAtomic(join(current.path, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      current.path,
      eventFor(
        "work_item.content_updated",
        input.actor ?? "user",
        input.conversationId,
        {
          revision: next.revision,
          before_length: current.content.length,
          after_length: content.length,
        },
      ),
    );
    await commitWorkspaceChanges(workspacePath, `workspace: update ${key} content`);
    return readWorkItem(workspacePath, key);
  });
}

export async function recordWorkItemMilestone(
  workspaceId: string,
  key: string,
  input: RecordWorkItemMilestoneInput,
): Promise<WorkItemDetail> {
  const { path: workspacePath } = await getWorkspace(workspaceId);
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.item.revision) {
      throw new WorkItemConflictError(
        `Expected revision ${input.expectedRevision}, current revision is ${current.item.revision}`,
      );
    }
    await appendEvent(
      current.path,
      eventFor(
        requireText(input.type, "type"),
        input.actor ?? "agent",
        input.conversationId,
        input.data,
      ),
    );
    await commitWorkspaceChanges(workspacePath, `workspace: record ${key} milestone`);
    return readWorkItem(workspacePath, key);
  });
}

export async function trashWorkItem(
  workspaceId: string,
  key: string,
): Promise<{ trashedPath: string }> {
  const { path: workspacePath } = await getWorkspace(workspaceId);
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    const trashDirectory = join(workspacePath, ".pi", "trash", "work-items");
    await mkdir(trashDirectory, { recursive: true });
    const trashedPath = join(
      trashDirectory,
      `${key}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    await rename(current.path, trashedPath);
    await commitWorkspaceChanges(workspacePath, `workspace: remove ${key}`);
    return { trashedPath };
  });
}
