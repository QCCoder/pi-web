import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { createUlid } from "./id.ts";
import { scanWorkspaceRepositories } from "./scan.ts";
import {
  DEFAULT_GIT_SETTINGS,
  normalizeInitCapabilities,
  renderKnowledgeSection,
  renderWorkspaceAgents,
  renderWorkspaceRepositories,
  SOFTWARE_DEVELOPMENT_GITIGNORE,
} from "./templates.ts";
import { renderOkfSeed } from "./okf.ts";
import {
  WORKSPACE_SCHEMA_VERSION,
  type CreateWorkspaceInput,
  type AddWorkspaceRepositoryInput,
  type UpdateWorkspaceInput,
  type WorkspaceCapability,
  type WorkspaceManifest,
  type WorkspaceIndex,
  type WorkspaceIndexEntry,
  type WorkspaceRepository,
  type WorkspaceRepositoryKind,
  type WorkspaceRepositoryState,
  type WorkspaceSummary,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_DIRECTORY_RE = /^workspace-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKSPACE_INDEX_SCHEMA_VERSION = 2 as const;

export class WorkspaceValidationError extends Error {}
export class WorkspaceConflictError extends Error {}
export class WorkspaceNotFoundError extends Error {}

function validateRepositoryAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  if (!WORKSPACE_SLUG_RE.test(normalized)) {
    throw new WorkspaceValidationError(
      "Repository alias must contain lowercase letters, numbers, and single hyphens only",
    );
  }
  return normalized;
}

function validateRepositoryKind(value: unknown): WorkspaceRepositoryKind {
  if (value !== "code" && value !== "knowledge") {
    throw new WorkspaceValidationError("Repository kind must be code or knowledge");
  }
  return value;
}

export function workspaceRepositoryPath(
  workspacePath: string,
  repository: Pick<WorkspaceRepository, "path">,
): {
  relativePath: string;
  absolutePath: string;
} {
  // Path-registration convention (2026-09): the manifest carries the repo's
  // relative POSIX path inside the workspace; the root hosts the user's own
  // project layout. `kind` no longer drives the path.
  return { relativePath: repository.path, absolutePath: resolve(workspacePath, repository.path) };
}

/** Validate + normalize a repository path: relative POSIX, rooted at the
 *  workspace, no traversal, no trailing slash. */
export function validateRepositoryPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) throw new WorkspaceValidationError("Repository path is required");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new WorkspaceValidationError(
      "Repository path must be relative to the workspace root and may not contain '..'",
    );
  }
  if (normalized === ".pi" || normalized.startsWith(".pi/")) {
    throw new WorkspaceValidationError("Repository path may not live inside .pi/ (pi mechanism files)");
  }
  return normalized;
}

declare global {
  var __piWorkspaceWriteLocks: Map<string, Promise<void>> | undefined;
}

function workspaceWriteLocks(): Map<string, Promise<void>> {
  if (!globalThis.__piWorkspaceWriteLocks) globalThis.__piWorkspaceWriteLocks = new Map();
  return globalThis.__piWorkspaceWriteLocks;
}

export async function withWorkspaceWriteLock<T>(
  workspacePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(workspacePath);
  const locks = workspaceWriteLocks();
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function getWorkspaceRoot(): string {
  const configured = process.env.PI_WORKSPACES_DIR?.trim();
  return resolve(configured || join(homedir(), ".pi", "workspaces"));
}

export function getWorkspaceIndexPath(root?: string): string {
  const configured = process.env.PI_WORKSPACE_INDEX_FILE?.trim();
  return root
    ? join(resolve(root), ".pi", "workspace.yaml")
    : resolve(configured || join(homedir(), ".pi", "workspace.yaml"));
}

const ALL_WORKSPACE_CAPABILITIES: readonly WorkspaceCapability[] = [
  "sessions",
  "explorer",
  "work-items",
  "repositories",
  "knowledge",
  "workflows",
];

export function parseCapabilities(value: unknown): WorkspaceCapability[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceValidationError("capabilities must be an array");
  }
  const result: WorkspaceCapability[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string"
      || !ALL_WORKSPACE_CAPABILITIES.includes(item as WorkspaceCapability)
    ) {
      throw new WorkspaceValidationError(`Unknown capability: ${String(item)}`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item as WorkspaceCapability);
  }
  return result;
}

/** Capability normalization enforced on update (PATCH) — mirrors the init
 *  path's `normalizeInitCapabilities` pattern (normalize, never reject, so a
 *  partial UI toggle cannot produce a broken manifest): the mandatory core
 *  (`sessions`, `explorer`) can never be dropped. (A capability-specific
 *  prerequisite map used to live here for the retired `requirement-sources`
 *  capability; it was removed with it.) */
export function normalizeUpdateCapabilities(
  selected: readonly WorkspaceCapability[],
): WorkspaceCapability[] {
  const seen = new Set<WorkspaceCapability>(selected);
  seen.add("sessions");
  seen.add("explorer");
  // Preserve a stable order: caller's order first, then anything force-added.
  const ordered = selected.filter((capability) => seen.has(capability));
  for (const capability of seen) {
    if (!ordered.includes(capability)) ordered.push(capability);
  }
  return ordered;
}

export function validateWorkspaceSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!WORKSPACE_SLUG_RE.test(normalized)) {
    throw new WorkspaceValidationError(
      "Workspace slug must contain lowercase letters, numbers, and single hyphens only",
    );
  }
  return normalized;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceValidationError(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new WorkspaceValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new WorkspaceValidationError(`${field} must be a positive integer`);
  }
  return Number(value);
}

function parseRepositories(value: unknown): WorkspaceRepository[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new WorkspaceValidationError("repositories must be an array");
  const aliases = new Set<string>();
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new WorkspaceValidationError(`repositories[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = requireNonEmptyString(record.id, `repositories[${index}].id`);
    if (ids.has(id)) throw new WorkspaceValidationError(`Duplicate repository id: ${id}`);
    ids.add(id);
    const alias = requireNonEmptyString(record.alias, `repositories[${index}].alias`);
    if (!WORKSPACE_SLUG_RE.test(alias)) {
      throw new WorkspaceValidationError(`repositories[${index}].alias is invalid`);
    }
    if (aliases.has(alias)) throw new WorkspaceValidationError(`Duplicate repository alias: ${alias}`);
    aliases.add(alias);
    const kind = validateRepositoryKind(record.kind);
    // Path registration is REQUIRED post-migration (2026-09 one-cut): the manifest
    // carries where the repo actually lives relative to the workspace root.
    const path = validateRepositoryPath(
      requireNonEmptyString(record.path, `repositories[${index}].path`),
    );
    if (record.status !== "active" && record.status !== "removed") {
      throw new WorkspaceValidationError(
        `repositories[${index}].status must be active or removed`,
      );
    }
    return {
      id,
      alias,
      name: requireNonEmptyString(record.name, `repositories[${index}].name`),
      kind,
      path,
      status: record.status,
      ...(optionalString(record.removed_at, `repositories[${index}].removed_at`)
        ? { removedAt: optionalString(record.removed_at, `repositories[${index}].removed_at`) }
        : {}),
    };
  });
}

export function parseWorkspaceManifest(value: unknown): WorkspaceManifest {
  if (!value || typeof value !== "object") {
    throw new WorkspaceValidationError("Workspace manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceValidationError(`Unsupported workspace schema: ${String(record.schema_version)}`);
  }
  const skills = record.skills ?? [];
  if (!Array.isArray(skills) || skills.some((skill) => typeof skill !== "string" || !skill.trim())) {
    throw new WorkspaceValidationError("skills must be an array of non-empty strings");
  }
  const agent = record.agent ?? {};
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new WorkspaceValidationError("agent must be an object");
  }
  const agentRecord = agent as Record<string, unknown>;
  if (record.capabilities === undefined) {
    throw new WorkspaceValidationError("capabilities is required");
  }
  const capabilities = parseCapabilities(record.capabilities);
  const gitValue = record.git;
  let git: WorkspaceManifest["git"];
  if (gitValue !== undefined) {
    if (!gitValue || typeof gitValue !== "object" || Array.isArray(gitValue)) {
      throw new WorkspaceValidationError("git must be an object");
    }
    const gitRecord = gitValue as Record<string, unknown>;
    const branchRules = gitRecord.branch_rules;
    if (!branchRules || typeof branchRules !== "object" || Array.isArray(branchRules)) {
      throw new WorkspaceValidationError("git.branch_rules is required");
    }
    const branchRecord = branchRules as Record<string, unknown>;
    if (gitRecord.create_after !== "plan_approved") {
      throw new WorkspaceValidationError("git.create_after must be plan_approved");
    }
    git = {
      branchRules: {
        requirement: requireNonEmptyString(branchRecord.requirement, "git.branch_rules.requirement"),
        bug: requireNonEmptyString(branchRecord.bug, "git.branch_rules.bug"),
      },
      createAfter: "plan_approved",
    };
  }
  const workItems = record.work_items;
  if (!workItems || typeof workItems !== "object" || Array.isArray(workItems)) {
    throw new WorkspaceValidationError("work_items is required");
  }
  const workItemRecord = workItems as Record<string, unknown>;
  const disabledValue = record.disabled;
  if (disabledValue !== undefined && typeof disabledValue !== "boolean") {
    throw new WorkspaceValidationError("disabled must be a boolean");
  }
  const slug = validateWorkspaceSlug(requireNonEmptyString(record.slug, "slug"));
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: requireNonEmptyString(record.id, "id"),
    slug,
    name: requireNonEmptyString(record.name, "name"),
    skills: [...new Set((skills as string[]).map((skill) => skill.trim()))],
    repositories: parseRepositories(record.repositories),
    agent: {
      ...(optionalString(agentRecord.default_model, "agent.default_model")
        ? { defaultModel: optionalString(agentRecord.default_model, "agent.default_model") }
        : {}),
      ...(optionalString(agentRecord.thinking_level, "agent.thinking_level")
        ? { thinkingLevel: optionalString(agentRecord.thinking_level, "agent.thinking_level") }
        : {}),
    },
    capabilities,
    ...(git ? { git } : {}),
    ...(disabledValue === true ? { disabled: true } : {}),
    workItems: {
      nextRequirementNumber: parsePositiveInteger(
        workItemRecord.next_requirement_number,
        "work_items.next_requirement_number",
      ),
      nextBugNumber: parsePositiveInteger(
        workItemRecord.next_bug_number,
        "work_items.next_bug_number",
      ),
    },
    createdAt: requireNonEmptyString(record.created_at, "created_at"),
    updatedAt: requireNonEmptyString(record.updated_at, "updated_at"),
  };
}

export function serializeWorkspaceManifest(manifest: WorkspaceManifest): string {
  return stringify({
    schema_version: manifest.schemaVersion,
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    skills: manifest.skills,
    repositories: manifest.repositories.map((repository) => ({
      id: repository.id,
      alias: repository.alias,
      name: repository.name,
      kind: repository.kind,
      path: repository.path,
      status: repository.status,
      ...(repository.removedAt ? { removed_at: repository.removedAt } : {}),
    })),
    agent: {
      ...(manifest.agent.defaultModel ? { default_model: manifest.agent.defaultModel } : {}),
      ...(manifest.agent.thinkingLevel ? { thinking_level: manifest.agent.thinkingLevel } : {}),
    },
    capabilities: manifest.capabilities,
    ...(manifest.git
      ? {
          git: {
            branch_rules: manifest.git.branchRules,
            create_after: manifest.git.createAfter,
          },
        }
      : {}),
    ...(manifest.disabled ? { disabled: true } : {}),
    work_items: {
      next_requirement_number: manifest.workItems.nextRequirementNumber,
      next_bug_number: manifest.workItems.nextBugNumber,
    },
    created_at: manifest.createdAt,
    updated_at: manifest.updatedAt,
  }, { lineWidth: 0 });
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

export async function writeWorkspaceManifest(
  workspacePath: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  await writeFileAtomic(
    join(workspacePath, ".pi", "workspace.yaml"),
    serializeWorkspaceManifest(manifest),
  );
}

export async function reserveWorkItemKey(
  workspacePath: string,
  type: "requirement" | "bug",
): Promise<string> {
  return withWorkspaceWriteLock(workspacePath, async () => {
    const manifest = await readWorkspaceManifest(workspacePath);
    const isRequirement = type === "requirement";
    const number = isRequirement
      ? manifest.workItems.nextRequirementNumber
      : manifest.workItems.nextBugNumber;
    if (isRequirement) {
      manifest.workItems.nextRequirementNumber += 1;
    } else {
      manifest.workItems.nextBugNumber += 1;
    }
    manifest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(workspacePath, manifest);
    return `${isRequirement ? "REQ" : "BUG"}-${String(number).padStart(4, "0")}`;
  });
}

export async function readWorkspaceManifest(workspacePath: string): Promise<WorkspaceManifest> {
  const filePath = join(workspacePath, ".pi", "workspace.yaml");
  const content = await readFile(filePath, "utf8");
  return parseWorkspaceManifest(parse(content));
}

export function workspaceSummary(workspacePath: string, manifest: WorkspaceManifest): WorkspaceSummary {
  return {
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    path: workspacePath,
    capabilities: [...manifest.capabilities],
    available: true,
    configStatus: "ready",
    disabled: manifest.disabled === true,
    skills: [...manifest.skills],
    repositories: manifest.repositories.map((repository) => ({ ...repository })),
    repositoryCount: manifest.repositories.filter((repository) => repository.status === "active").length,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function ensureGitIdentity(repositoryPath: string): Promise<void> {
  try {
    await gitOutput(repositoryPath, ["config", "--get", "user.name"]);
  } catch {
    await execFileAsync("git", ["config", "user.name", "Pi Workspace"], { cwd: repositoryPath });
  }
  try {
    await gitOutput(repositoryPath, ["config", "--get", "user.email"]);
  } catch {
    await execFileAsync("git", ["config", "user.email", "pi-workspace@local"], {
      cwd: repositoryPath,
    });
  }
}

export async function commitWorkspaceChanges(
  workspacePath: string,
  message: string,
): Promise<void> {
  // Auto-commit only when the workspace is an actual git repository.
  try {
    await gitOutput(workspacePath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return;
  }
  await ensureGitIdentity(workspacePath);
  const status = await gitOutput(workspacePath, ["status", "--porcelain"]);
  if (!status) return;
  await execFileAsync("git", ["add", "-A"], { cwd: workspacePath });
  await execFileAsync("git", ["commit", "-m", message], {
    cwd: workspacePath,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function updateManagedRepositoryInstructions(
  workspacePath: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  // Maintain BOTH managed segments (repositories + knowledge) using the same
  // anchor-replace pattern. Each is only touched when its capability is effective;
  // a segment whose markers are absent is left untouched (never created here). This
  // mirrors the historical repositories-only behavior and never fuzzy-matches user
  // content outside the markers (redesign decision 9, high-risk trap).
  const capabilities = manifest.capabilities;
  const hasRepositories = capabilities.includes("repositories");
  const hasKnowledge = capabilities.includes("knowledge");
  if (!hasRepositories && !hasKnowledge) return;
  const agentsPath = join(workspacePath, "AGENTS.md");
  let current: string;
  try {
    current = await readFile(agentsPath, "utf8");
  } catch {
    return; // no AGENTS.md to maintain
  }
  // Resolve each repo to its actual on-disk path so an existing workspace's
  // repos show their real location in AGENTS.md.
  const resolveRelativePath = (repository: WorkspaceRepository): string =>
    workspaceRepositoryPath(workspacePath, repository).relativePath;
  let next = current;
  if (hasRepositories) {
    next = next.replace(
      /<!-- workspace-managed:repositories:start -->[\s\S]*?<!-- workspace-managed:repositories:end -->/,
      renderWorkspaceRepositories(manifest, resolveRelativePath),
    );
  }
  if (hasKnowledge) {
    next = next.replace(
      /<!-- workspace-managed:knowledge:start -->[\s\S]*?<!-- workspace-managed:knowledge:end -->/,
      renderKnowledgeSection(manifest, resolveRelativePath),
    );
  }
  if (next === current) return; // no managed block present; nothing to update
  await writeFileAtomic(agentsPath, next);
}

async function repositoryRemote(repositoryPath: string): Promise<string | undefined> {
  try {
    return await gitOutput(repositoryPath, ["remote", "get-url", "origin"]) || undefined;
  } catch {
    return undefined;
  }
}

/** 把目录名规整成合法 alias（WORKSPACE_SLUG_RE）；全非 [a-z0-9]（如纯中文）时回落 `repo-<ulid8>`。 */
function repositoryAliasFromDirName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug && WORKSPACE_SLUG_RE.test(slug)) return slug;
  return `repo-${createUlid().slice(-8).toLowerCase()}`;
}

/** 「扫描为事实，manifest 只存记忆」：把磁盘扫描结果对账进 manifest.repositories。
 *  - 磁盘新目录 → 新增条目（alias = 目录名规整，与既有 alias 冲突时加数字后缀；
 *    manifest 已钉住的条目 alias/kind 不被扫描改写，path 是对账键）；
 *  - active 条目在磁盘上消失 → status removed（自动停用，保留 id/alias 供恢复）；
 *  - removed 条目重现 → 恢复 active。
 *  变更时同步刷新 AGENTS.md managed 段并（若是 git 仓）提交审计。调用方需持有
 *  工作区写锁。返回是否发生了变更。 */
async function syncRepositoriesFromScan(
  workspacePath: string,
  manifest: WorkspaceManifest,
): Promise<boolean> {
  const scanned = scanWorkspaceRepositories(workspacePath);
  const byPath = new Map(manifest.repositories.map((repository) => [repository.path, repository]));
  const now = new Date().toISOString();
  let changed = false;

  for (const found of scanned) {
    const existing = byPath.get(found.path);
    if (existing) {
      if (existing.status !== "active") {
        existing.status = "active";
        delete existing.removedAt;
        changed = true;
      }
      continue;
    }
    const takenAliases = new Set(manifest.repositories.map((repository) => repository.alias));
    const baseAlias = repositoryAliasFromDirName(found.alias);
    let alias = baseAlias;
    for (let n = 2; takenAliases.has(alias); n += 1) alias = `${baseAlias}-${n}`;
    manifest.repositories.push({
      id: createUlid(),
      alias,
      name: found.alias,
      kind: found.kind,
      path: found.path,
      status: "active",
    });
    // 嵌套仓不进根仓 git（与 addWorkspaceRepository 同款）；否则 add -A 会
    // 把无提交的嵌套仓当 gitlink 处理甚至直接报错。
    await ignoreRepositoryInWorkspaceGit(workspacePath, found.path);
    changed = true;
  }

  const scannedPaths = new Set(scanned.map((found) => found.path));
  for (const repository of manifest.repositories) {
    if (repository.status === "active" && !scannedPaths.has(repository.path)) {
      repository.status = "removed";
      repository.removedAt = now;
      changed = true;
    }
  }

  if (!changed) return false;
  manifest.updatedAt = now;
  await writeWorkspaceManifest(workspacePath, manifest);
  await updateManagedRepositoryInstructions(workspacePath, manifest);
  // 自动同步的审计提交尽力而为——失败（如嵌套仓异常）不得打断列表
  await commitWorkspaceChanges(workspacePath, "workspace: sync repositories (auto-scan)")
    .catch((error: unknown) => console.error("[workspace] auto-scan commit failed:", error));
  return true;
}

export async function listWorkspaceRepositories(
  idOrSlug: string,
  root?: string,
): Promise<WorkspaceRepositoryState[]> {
  const workspace = await findWorkspace(idOrSlug, root);
  // 先对账（扫描为事实）：列表/设置页打开即自动登记新目录、停用消失目录。
  await withWorkspaceWriteLock(workspace.path, async () => {
    const manifest = await readWorkspaceManifest(workspace.path);
    await syncRepositoriesFromScan(workspace.path, manifest);
  });
  const latest = await readWorkspaceManifest(workspace.path);
  return Promise.all(latest.repositories.map(async (repository) => {
    const { relativePath, absolutePath } = workspaceRepositoryPath(workspace.path, repository);
    try {
      const [branch, commit, status, remote] = await Promise.all([
        gitOutput(absolutePath, ["branch", "--show-current"]),
        gitOutput(absolutePath, ["rev-parse", "--short=12", "HEAD"]),
        gitOutput(absolutePath, ["status", "--porcelain"]),
        repositoryRemote(absolutePath),
      ]);
      return {
        ...repository,
        path: relativePath,
        ...(remote ? { remote } : {}),
        exists: true,
        ...(branch ? { branch } : {}),
        commit,
        dirty: Boolean(status),
      };
    } catch (error) {
      return {
        ...repository,
        path: relativePath,
        exists: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export async function addWorkspaceRepository(
  idOrSlug: string,
  input: AddWorkspaceRepositoryInput,
  root?: string,
): Promise<WorkspaceRepository> {
  const workspace = await findWorkspace(idOrSlug, root);
  const alias = validateRepositoryAlias(requireNonEmptyString(input.alias, "alias"));
  const kind = validateRepositoryKind(input.kind);
  if (input.mode !== "clone" && input.mode !== "init" && input.mode !== "register") {
    throw new WorkspaceValidationError("mode must be clone, init or register");
  }

  return withWorkspaceWriteLock(workspace.path, async () => {
    const manifest = await readWorkspaceManifest(workspace.path);
    if (manifest.repositories.some((repository) => repository.alias === alias)) {
      throw new WorkspaceConflictError(`Repository alias already exists: ${alias}`);
    }

    const relativePath = input.path === undefined && input.mode !== "register"
      ? alias // default: a root-level `<alias>/` directory (path-registration layout)
      : validateRepositoryPath(input.path ?? "");
    const repository: WorkspaceRepository = {
      id: createUlid(),
      alias,
      name: optionalString(input.name, "name") ?? alias,
      kind,
      path: relativePath,
      status: "active",
    };
    const { absolutePath } = workspaceRepositoryPath(workspace.path, repository);

    if (input.mode === "register") {
      // Register an existing directory without touching it (path-registration flow
      // for project dirs the user already has, e.g. cxin-workspace's own repos).
      let registered = false;
      try {
        registered = (await stat(absolutePath)).isDirectory();
      } catch {
        registered = false;
      }
      if (!registered) {
        throw new WorkspaceValidationError(`Repository path does not exist: ${relativePath}`);
      }
    } else {
      const remote = optionalString(input.remote, "remote");
      try {
        await lstat(absolutePath);
        throw new WorkspaceConflictError(`Repository path already exists: ${relativePath}`);
      } catch (error) {
        if (error instanceof WorkspaceConflictError) throw error;
      }
      await mkdir(dirname(absolutePath), { recursive: true });
      if (input.mode === "clone") {
        if (!remote) throw new WorkspaceValidationError("remote is required when cloning");
        try {
          await execFileAsync("git", ["clone", "--", remote, absolutePath], {
            cwd: workspace.path,
            maxBuffer: 10 * 1024 * 1024,
          });
        } catch (error) {
          await rm(absolutePath, { recursive: true, force: true });
          throw new WorkspaceValidationError(
            `Git clone failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        try {
          await mkdir(absolutePath);
          await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: absolutePath });
          const title = `# ${repository.name}\n`;
          await writeFile(join(absolutePath, "README.md"), title, "utf8");
          if (kind === "knowledge") {
            // OKF v0.2 seed (redesign decision 13 / §4): a progressive-disclosure
            // index.md, a log.md, and a frontmatter'd example concept. This replaces
            // the old bare `# Index` file. Clone mode above is untouched — a cloned
            // knowledge repo brings its own OKF structure from the remote.
            const seed = renderOkfSeed(alias);
            for (const [seedPath, content] of Object.entries(seed.files)) {
              const target = join(absolutePath, seedPath);
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, content, "utf8");
            }
          }
          if (remote) {
            await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: absolutePath });
          }
          await ensureGitIdentity(absolutePath);
          await execFileAsync("git", ["add", "-A"], { cwd: absolutePath });
          await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: absolutePath });
        } catch (error) {
          await rm(absolutePath, { recursive: true, force: true });
          throw new WorkspaceValidationError(
            `Git init failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    manifest.repositories.push(repository);
    manifest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(workspace.path, manifest);
    await updateManagedRepositoryInstructions(workspace.path, manifest);
    // Keep the workspace root repo from tracking the nested repository (same
    // precedent as the old fixed-layout /repositories/ ignore entry).
    await ignoreRepositoryInWorkspaceGit(workspace.path, relativePath);
    await commitWorkspaceChanges(workspace.path, `workspace: add ${kind} repository ${alias}`);
    return repository;
  });
}

/** Best-effort: add `/<repoPath>/` to the workspace root's .gitignore so the
 *  nested repository never shows up as untracked dirt in the root repo. */
async function ignoreRepositoryInWorkspaceGit(
  workspacePath: string,
  relativePath: string,
): Promise<void> {
  try {
    await gitOutput(workspacePath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return; // not a git repo — nothing to maintain
  }
  const entry = `/${relativePath}/`;
  const gitignorePath = join(workspacePath, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }
  const lines = current.split("\n");
  if (lines.some((line) => line.trim() === entry)) return;
  const next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n# Nested repositories are managed independently\n${entry}\n`;
  await writeFile(gitignorePath, next, "utf8");
}

export async function removeWorkspaceRepository(
  idOrSlug: string,
  repositoryId: string,
  root?: string,
): Promise<{ repository: WorkspaceRepository }> {
  const workspace = await findWorkspace(idOrSlug, root);
  return withWorkspaceWriteLock(workspace.path, async () => {
    const manifest = await readWorkspaceManifest(workspace.path);
    const index = manifest.repositories.findIndex((repository) => repository.id === repositoryId);
    if (index < 0) throw new WorkspaceNotFoundError(`Repository not found: ${repositoryId}`);
    const repository = manifest.repositories[index];
    if (repository.status === "removed") return { repository };
    repository.status = "removed";
    repository.removedAt = new Date().toISOString();
    manifest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(workspace.path, manifest);
    await updateManagedRepositoryInstructions(workspace.path, manifest);
    await commitWorkspaceChanges(
      workspace.path,
      `workspace: remove ${repository.kind} repository ${repository.alias}`,
    );
    return { repository };
  });
}

export async function restoreWorkspaceRepository(
  idOrSlug: string,
  repositoryId: string,
  root?: string,
): Promise<{ repository: WorkspaceRepository }> {
  const workspace = await findWorkspace(idOrSlug, root);
  return withWorkspaceWriteLock(workspace.path, async () => {
    const manifest = await readWorkspaceManifest(workspace.path);
    const repository = manifest.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) throw new WorkspaceNotFoundError(`Repository not found: ${repositoryId}`);
    if (repository.status === "active") return { repository };
    repository.status = "active";
    delete repository.removedAt;
    manifest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(workspace.path, manifest);
    await updateManagedRepositoryInstructions(workspace.path, manifest);
    await commitWorkspaceChanges(
      workspace.path,
      `workspace: restore ${repository.kind} repository ${repository.alias}`,
    );
    return { repository };
  });
}

function parseWorkspaceIndex(value: unknown): WorkspaceIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceValidationError("Global Workspace index must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== WORKSPACE_INDEX_SCHEMA_VERSION) {
    throw new WorkspaceValidationError(
      `Unsupported global Workspace index schema: ${String(record.schema_version)}`,
    );
  }
  if (!Array.isArray(record.workspaces)) {
    throw new WorkspaceValidationError("Global Workspace index workspaces must be an array");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const workspaces = record.workspaces.map((value, index): WorkspaceIndexEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkspaceValidationError(`workspaces[${index}] must be an object`);
    }
    const entry = value as Record<string, unknown>;
    const id = requireNonEmptyString(entry.id, `workspaces[${index}].id`);
    const path = resolve(requireNonEmptyString(entry.path, `workspaces[${index}].path`));
    if (ids.has(id)) throw new WorkspaceValidationError(`Duplicate Workspace id: ${id}`);
    if (paths.has(path)) throw new WorkspaceValidationError(`Duplicate Workspace path: ${path}`);
    ids.add(id);
    paths.add(path);
    const sortValue = entry.sort_order;
    if (sortValue !== undefined && (typeof sortValue !== "number" || !Number.isFinite(sortValue))) {
      throw new WorkspaceValidationError(`workspaces[${index}].sort_order must be a number`);
    }
    return {
      id,
      path,
      name: requireNonEmptyString(entry.name, `workspaces[${index}].name`),
      addedAt: requireNonEmptyString(entry.added_at, `workspaces[${index}].added_at`),
      lastOpenedAt: requireNonEmptyString(
        entry.last_opened_at,
        `workspaces[${index}].last_opened_at`,
      ),
      ...(sortValue !== undefined ? { sortOrder: sortValue } : {}),
    };
  });
  return { schemaVersion: WORKSPACE_INDEX_SCHEMA_VERSION, workspaces };
}

function serializeWorkspaceIndex(index: WorkspaceIndex): string {
  return stringify({
    schema_version: index.schemaVersion,
    workspaces: index.workspaces.map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      name: workspace.name,
      added_at: workspace.addedAt,
      last_opened_at: workspace.lastOpenedAt,
      ...(workspace.sortOrder !== undefined ? { sort_order: workspace.sortOrder } : {}),
    })),
  }, { lineWidth: 0 });
}

async function readWorkspaceIndex(root?: string): Promise<{
  index: WorkspaceIndex;
  exists: boolean;
}> {
  try {
    const content = await readFile(getWorkspaceIndexPath(root), "utf8");
    return { index: parseWorkspaceIndex(parse(content)), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        index: { schemaVersion: WORKSPACE_INDEX_SCHEMA_VERSION, workspaces: [] },
        exists: false,
      };
    }
    throw error;
  }
}

async function writeWorkspaceIndex(index: WorkspaceIndex, root?: string): Promise<void> {
  await writeFileAtomic(getWorkspaceIndexPath(root), serializeWorkspaceIndex(index));
}

async function updateWorkspaceIndex(
  operation: (index: WorkspaceIndex) => void,
  root?: string,
): Promise<void> {
  const indexPath = getWorkspaceIndexPath(root);
  await withWorkspaceWriteLock(indexPath, async () => {
    const { index } = await readWorkspaceIndex(root);
    operation(index);
    await writeWorkspaceIndex(index, root);
  });
}

function indexEntryFromManifest(
  path: string,
  manifest: WorkspaceManifest,
  existing?: WorkspaceIndexEntry,
): WorkspaceIndexEntry {
  const now = new Date().toISOString();
  return {
    id: manifest.id,
    path,
    name: manifest.name,
    addedAt: existing?.addedAt ?? now,
    lastOpenedAt: existing?.lastOpenedAt ?? now,
    // 手动排序位随条目重建透传（registerWorkspacePath 每次 get/create 都会
    // 重建条目 —— 不透传会被每次读取抹掉）。
    ...(existing?.sortOrder !== undefined ? { sortOrder: existing.sortOrder } : {}),
  };
}

async function registerWorkspacePath(
  workspacePath: string,
  manifest: WorkspaceManifest,
  root?: string,
  touch = true,
): Promise<void> {
  const indexPath = getWorkspaceIndexPath(root);
  await withWorkspaceWriteLock(indexPath, async () => {
    const { index } = await readWorkspaceIndex(root);
    const pathIndex = index.workspaces.findIndex((entry) => entry.path === workspacePath);
    const idIndex = index.workspaces.findIndex((entry) => entry.id === manifest.id);
    if (idIndex >= 0 && idIndex !== pathIndex) {
      const original = index.workspaces[idIndex];
      let originalExists = false;
      try {
        originalExists = (await stat(original.path)).isDirectory();
      } catch {
        originalExists = false;
      }
      if (originalExists) {
        throw new WorkspaceConflictError(
          `Workspace id ${manifest.id} is already registered at ${original.path}`,
        );
      }
      index.workspaces.splice(idIndex, 1);
    }
    const currentPathIndex = index.workspaces.findIndex((entry) => entry.path === workspacePath);
    const existing = currentPathIndex >= 0 ? index.workspaces[currentPathIndex] : undefined;
    const entry = indexEntryFromManifest(workspacePath, manifest, existing);
    if (touch) entry.lastOpenedAt = new Date().toISOString();
    if (currentPathIndex >= 0) index.workspaces[currentPathIndex] = entry;
    else index.workspaces.push(entry);
    await writeWorkspaceIndex(index, root);
  });
}

function unavailableWorkspaceSummary(
  entry: WorkspaceIndexEntry,
  status: WorkspaceSummary["configStatus"],
): WorkspaceSummary {
  return {
    id: entry.id,
    slug: basename(entry.path),
    name: entry.name,
    path: entry.path,
    capabilities: ["sessions", "explorer"] as WorkspaceCapability[],
    available: false,
    configStatus: status,
    disabled: false,
    skills: [],
    repositories: [],
    repositoryCount: 0,
    createdAt: entry.addedAt,
    updatedAt: entry.lastOpenedAt,
  };
}

/** Scan-rebuild path when the global index file does not exist yet (first run
 *  or deleted index): walk the managed workspaces root and register every
 *  directory with a valid manifest. External-path workspaces registered only in
 *  the index are NOT rediscovered by this scan — that is why the index is the
 *  source of truth once it exists. */
async function rebuildWorkspaceIndexFromScan(root: string, indexRoot?: string): Promise<WorkspaceIndex> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const index: WorkspaceIndex = {
    schemaVersion: WORKSPACE_INDEX_SCHEMA_VERSION,
    workspaces: [],
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_DIRECTORY_RE.test(entry.name)) continue;
    const workspacePath = join(root, entry.name);
    try {
      const manifest = await readWorkspaceManifest(workspacePath);
      index.workspaces.push(indexEntryFromManifest(workspacePath, manifest));
    } catch {
      // Malformed directories stay untouched and are not registered.
    }
  }
  await writeWorkspaceIndex(index, indexRoot);
  return index;
}


export async function discoverWorkspaces(root?: string): Promise<WorkspaceSummary[]> {
  const workspaceRoot = root ?? getWorkspaceRoot();
  const stored = await readWorkspaceIndex(root);
  const index = stored.exists
    ? stored.index
    : await rebuildWorkspaceIndexFromScan(workspaceRoot, root);
  const summaries: Array<{
    summary: WorkspaceSummary;
    lastOpenedAt: string;
    sortOrder: number | undefined;
  }> = [];
  let snapshotsChanged = false;
  for (const entry of index.workspaces) {
    try {
      const directory = await stat(entry.path);
      if (!directory.isDirectory()) {
        summaries.push({
          summary: unavailableWorkspaceSummary(entry, "directory-unavailable"),
          lastOpenedAt: entry.lastOpenedAt,
          sortOrder: entry.sortOrder,
        });
        continue;
      }
    } catch {
      summaries.push({
        summary: unavailableWorkspaceSummary(entry, "directory-unavailable"),
        lastOpenedAt: entry.lastOpenedAt,
        sortOrder: entry.sortOrder,
      });
      continue;
    }
    try {
      const manifest = await readWorkspaceManifest(entry.path);
      if (manifest.id !== entry.id) {
        summaries.push({
          summary: unavailableWorkspaceSummary(entry, "config-invalid"),
          lastOpenedAt: entry.lastOpenedAt,
          sortOrder: entry.sortOrder,
        });
        continue;
      }
      const nextEntry = indexEntryFromManifest(entry.path, manifest, entry);
      nextEntry.lastOpenedAt = entry.lastOpenedAt;
      if (nextEntry.name !== entry.name) {
        Object.assign(entry, nextEntry);
        snapshotsChanged = true;
      }
      summaries.push({
        summary: workspaceSummary(entry.path, manifest),
        lastOpenedAt: entry.lastOpenedAt,
        sortOrder: entry.sortOrder,
      });
    } catch (error) {
      summaries.push({
        summary: unavailableWorkspaceSummary(
          entry,
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "config-missing"
            : "config-invalid",
        ),
        lastOpenedAt: entry.lastOpenedAt,
        sortOrder: entry.sortOrder,
      });
    }
  }
  if (snapshotsChanged) await writeWorkspaceIndex(index, root);
  return summaries
    .sort((left, right) => {
      if (left.summary.available !== right.summary.available) {
        return left.summary.available ? -1 : 1;
      }
      // 手动序在前（升序），未设置的条目保持原 MRU 降序兜底 —— 不排序的用户
      // 看到的列表与引入手动序之前完全一致。
      const leftOrder = left.sortOrder ?? Number.POSITIVE_INFINITY;
      const rightOrder = right.sortOrder ?? Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
    })
    .map(({ summary }) => summary);
}

/** 手动排序（2026-09）：把全量期望序写入全局索引条目的 `sortOrder`（按位次
 *  重编 1..N，一次原子写）。未提及的条目剥掉 sortOrder（回落 MRU 段）；未知
 *  id 静默忽略（列表加载与拖放之间工作区可能已被删除，不值得为此报错）。
 *  全量语义让 UI 一次 PATCH 表达完整顺序，也天然支持“清空手动序”。 */
export async function updateWorkspaceOrder(
  ids: string[],
  root?: string,
): Promise<{ updated: true }> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new WorkspaceValidationError("order must be an array of workspace ids");
  }
  await updateWorkspaceIndex((index) => {
    const position = new Map(ids.map((id, i) => [id, i + 1]));
    for (const entry of index.workspaces) {
      const next = position.get(entry.id);
      if (next !== undefined) entry.sortOrder = next;
      else delete entry.sortOrder;
    }
  }, root);
  return { updated: true };
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  root?: string,
): Promise<WorkspaceSummary> {
  const workspaceRoot = root ?? getWorkspaceRoot();
  const name = requireNonEmptyString(input.name, "name");
  const slug = validateWorkspaceSlug(input.slug);
  // Capability-driven init (redesign decision 5/7): validate the selection, then
  // force-include the mandatory sessions/explorer. No template is consulted.
  const capabilities = normalizeInitCapabilities(parseCapabilities(input.capabilities));

  const workspacePath = join(workspaceRoot, `workspace-${slug}`);
  try {
    await access(workspacePath);
    throw new WorkspaceConflictError(`Workspace already exists: workspace-${slug}`);
  } catch (error) {
    if (error instanceof WorkspaceConflictError) throw error;
  }

  // Git settings (branch rules) are a work-items feature; git-init the workspace
  // repo whenever a git-using capability (repositories or work-items) is on so the
  // manifest/AGENTS.md stay tracked (redesign decision 6: lazy directories — only
  // these are created up front, never requirements/bugs/designs/plans).
  const needsGitRepo = capabilities.includes("repositories") || capabilities.includes("work-items");
  const gitSettings = capabilities.includes("work-items")
    ? structuredClone(DEFAULT_GIT_SETTINGS)
    : undefined;

  const temporaryPath = join(workspaceRoot, `.creating-workspace-${slug}-${createUlid()}`);
  const now = new Date().toISOString();
  const manifest: WorkspaceManifest = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: createUlid(),
    slug,
    name,
    skills: [],
    repositories: [],
    agent: {},
    capabilities,
    ...(gitSettings ? { git: gitSettings } : {}),
    workItems: {
      nextRequirementNumber: 1,
      nextBugNumber: 1,
    },
    createdAt: now,
    updatedAt: now,
  };

  await mkdir(join(temporaryPath, ".pi"), { recursive: true });
  try {
    await writeFileAtomic(
      join(temporaryPath, ".pi", "workspace.yaml"),
      serializeWorkspaceManifest(manifest),
    );
    await writeFile(
      join(temporaryPath, "AGENTS.md"),
      renderWorkspaceAgents(manifest, capabilities),
      "utf8",
    );
    if (needsGitRepo) {
      await writeFile(join(temporaryPath, ".gitignore"), SOFTWARE_DEVELOPMENT_GITIGNORE, "utf8");
      await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: temporaryPath });
      await commitWorkspaceChanges(temporaryPath, "workspace: initialize");
    }
    await rename(temporaryPath, workspacePath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
  await registerWorkspacePath(workspacePath, manifest, root);
  return workspaceSummary(workspacePath, manifest);
}

async function findWorkspace(
  idOrSlug: string,
  root?: string,
): Promise<{ path: string; manifest: WorkspaceManifest }> {
  const workspaces = await discoverWorkspaces(root);
  const summary = workspaces.find((workspace) =>
    workspace.id === idOrSlug || workspace.slug === idOrSlug
  );
  if (!summary) throw new WorkspaceNotFoundError(`Workspace not found: ${idOrSlug}`);
  return { path: summary.path, manifest: await readWorkspaceManifest(summary.path) };
}

export async function getWorkspace(
  idOrSlug: string,
  root?: string,
): Promise<{ path: string; manifest: WorkspaceManifest }> {
  const workspace = await findWorkspace(idOrSlug, root);
  await registerWorkspacePath(workspace.path, workspace.manifest, root);
  return workspace;
}

export async function updateWorkspace(
  idOrSlug: string,
  input: UpdateWorkspaceInput,
  root?: string,
): Promise<WorkspaceSummary> {
  const current = await findWorkspace(idOrSlug, root);
  return withWorkspaceWriteLock(current.path, async () => {
    const latest = await readWorkspaceManifest(current.path);
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== latest.updatedAt) {
      throw new WorkspaceConflictError("Workspace changed since it was loaded");
    }
    if (input.name !== undefined) latest.name = requireNonEmptyString(input.name, "name");
    if (input.disabled !== undefined) {
      if (typeof input.disabled !== "boolean") {
        throw new WorkspaceValidationError("disabled must be a boolean");
      }
      // `false` strips the key entirely — old manifests stay byte-compatible.
      if (input.disabled) latest.disabled = true;
      else delete latest.disabled;
    }
    if (input.skills !== undefined) {
      if (!Array.isArray(input.skills) || input.skills.some((skill) => typeof skill !== "string" || !skill.trim())) {
        throw new WorkspaceValidationError("skills must be an array of non-empty strings");
      }
      latest.skills = [...new Set(input.skills.map((skill) => skill.trim()))];
    }
    if (input.capabilities !== undefined) {
      latest.capabilities = normalizeUpdateCapabilities(parseCapabilities(input.capabilities));
    }
    latest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(current.path, latest);
    await commitWorkspaceChanges(current.path, "workspace: update settings");
    await registerWorkspacePath(current.path, latest, root, false);
    return workspaceSummary(current.path, latest);
  });
}

export async function removeWorkspace(
  idOrSlug: string,
  root?: string,
): Promise<{ removed: true }> {
  await updateWorkspaceIndex((index) => {
    const entryIndex = index.workspaces.findIndex((entry) =>
      entry.id === idOrSlug || basename(entry.path) === `workspace-${idOrSlug}`
    );
    if (entryIndex < 0) throw new WorkspaceNotFoundError(`Workspace not found: ${idOrSlug}`);
    index.workspaces.splice(entryIndex, 1);
  }, root);
  return { removed: true };
}

function slugFromDirectoryName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || `workspace-${createUlid().slice(-8).toLowerCase()}`;
}

export async function importWorkspace(
  inputPath: string,
  root?: string,
  asCopy = false,
): Promise<WorkspaceSummary> {
  const requestedPath = resolve(requireNonEmptyString(inputPath, "path"));
  let workspacePath: string;
  try {
    workspacePath = await realpath(requestedPath);
    if (!(await stat(workspacePath)).isDirectory()) {
      throw new WorkspaceValidationError(`Not a directory: ${workspacePath}`);
    }
  } catch (error) {
    if (error instanceof WorkspaceValidationError) throw error;
    throw new WorkspaceValidationError(`Directory is unavailable: ${requestedPath}`);
  }

  const existing = (await discoverWorkspaces(root)).find((workspace) =>
    workspace.path === workspacePath
  );
  if (existing) {
    if (!existing.available) {
      throw new WorkspaceValidationError(`Workspace configuration is not usable: ${workspacePath}`);
    }
    const manifest = await readWorkspaceManifest(workspacePath);
    await registerWorkspacePath(workspacePath, manifest, root);
    return workspaceSummary(workspacePath, manifest);
  }

  let manifest: WorkspaceManifest;
  try {
    manifest = await readWorkspaceManifest(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // No manifest: import as an empty capability-driven workspace.
    {
    const now = new Date().toISOString();
    manifest = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      id: createUlid(),
      slug: slugFromDirectoryName(basename(workspacePath)),
      name: basename(workspacePath),
      // Capability-driven: imported directories without a manifest get the bare
      // mandatory minimum and no template (consistent with createWorkspace).
      capabilities: ["sessions", "explorer"] as WorkspaceCapability[],
      skills: [],
      repositories: [],
      agent: {},
      workItems: {
        nextRequirementNumber: 1,
        nextBugNumber: 1,
      },
      createdAt: now,
      updatedAt: now,
    };
    await writeWorkspaceManifest(workspacePath, manifest);
    }
  }
  if (asCopy) {
    const now = new Date().toISOString();
    manifest = {
      ...manifest,
      id: createUlid(),
      createdAt: now,
      updatedAt: now,
    };
    await writeWorkspaceManifest(workspacePath, manifest);
  }
  await registerWorkspacePath(workspacePath, manifest, root);
  return workspaceSummary(workspacePath, manifest);
}

export async function isWorkspaceDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory() && Boolean(await readWorkspaceManifest(path));
  } catch {
    return false;
  }
}

export async function findWorkspaceForPath(
  path: string,
): Promise<{ path: string; manifest: WorkspaceManifest } | null> {
  let candidate = resolve(path);
  while (true) {
    try {
      const manifest = await readWorkspaceManifest(candidate);
      return { path: candidate, manifest };
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}
