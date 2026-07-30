import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { createUlid } from "./id.ts";
import {
  BUILT_IN_WORKSPACE_TEMPLATES,
  defaultGitForTemplate,
  defaultSkillsForTemplate,
  getWorkspaceTemplate,
  isWorkspaceTemplateId,
  renderSoftwareDevelopmentAgents,
  renderWorkspaceRepositories,
  SOFTWARE_DEVELOPMENT_DIRECTORIES,
  SOFTWARE_DEVELOPMENT_GITIGNORE,
} from "./templates.ts";
import {
  WORKSPACE_SCHEMA_VERSION,
  type CreateWorkspaceInput,
  type AddWorkspaceRepositoryInput,
  type UpdateWorkspaceInput,
  type WorkspaceManifest,
  type WorkspaceRepository,
  type WorkspaceRepositoryKind,
  type WorkspaceRepositoryState,
  type WorkspaceSummary,
  type WorkspaceTemplateInfo,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_DIRECTORY_RE = /^workspace-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  repository: Pick<WorkspaceRepository, "kind" | "alias">,
): {
  relativePath: string;
  absolutePath: string;
} {
  const normalized = `repositories/${repository.kind}/${repository.alias}`;
  const absolutePath = resolve(workspacePath, normalized);
  return { relativePath: normalized, absolutePath };
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
  return resolve(configured || join(homedir(), "pi-workspaces"));
}

export function listWorkspaceTemplates(): WorkspaceTemplateInfo[] {
  return BUILT_IN_WORKSPACE_TEMPLATES.map((template) => ({ ...template }));
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
  const template = record.template;
  if (!template || typeof template !== "object") {
    throw new WorkspaceValidationError("template is required");
  }
  const templateRecord = template as Record<string, unknown>;
  if (!isWorkspaceTemplateId(templateRecord.id)) {
    throw new WorkspaceValidationError(`Unknown workspace template: ${String(templateRecord.id)}`);
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
  const slug = validateWorkspaceSlug(requireNonEmptyString(record.slug, "slug"));
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: requireNonEmptyString(record.id, "id"),
    slug,
    name: requireNonEmptyString(record.name, "name"),
    template: {
      id: templateRecord.id,
      version: parsePositiveInteger(templateRecord.version, "template.version"),
    },
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
    ...(git ? { git } : {}),
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
    template: manifest.template,
    skills: manifest.skills,
    repositories: manifest.repositories.map((repository) => ({
      id: repository.id,
      alias: repository.alias,
      name: repository.name,
      kind: repository.kind,
      status: repository.status,
      ...(repository.removedAt ? { removed_at: repository.removedAt } : {}),
    })),
    agent: {
      ...(manifest.agent.defaultModel ? { default_model: manifest.agent.defaultModel } : {}),
      ...(manifest.agent.thinkingLevel ? { thinking_level: manifest.agent.thinkingLevel } : {}),
    },
    ...(manifest.git
      ? {
          git: {
            branch_rules: manifest.git.branchRules,
            create_after: manifest.git.createAfter,
          },
        }
      : {}),
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
  const manifest = parseWorkspaceManifest(parse(content));
  const directoryMatch = basename(workspacePath).match(WORKSPACE_DIRECTORY_RE);
  if (!directoryMatch || directoryMatch[1] !== manifest.slug) {
    throw new WorkspaceValidationError(
      `Workspace directory must be named workspace-${manifest.slug}`,
    );
  }
  return manifest;
}

export function workspaceSummary(workspacePath: string, manifest: WorkspaceManifest): WorkspaceSummary {
  return {
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    path: workspacePath,
    templateId: manifest.template.id,
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
  manifestValue?: WorkspaceManifest,
): Promise<void> {
  const manifest = manifestValue ?? await readWorkspaceManifest(workspacePath);
  if (manifest.template.id !== "software-development") return;
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
  if (manifest.template.id !== "software-development") return;
  const agentsPath = join(workspacePath, "AGENTS.md");
  const current = await readFile(agentsPath, "utf8");
  const managed = renderWorkspaceRepositories(manifest);
  const next = current.replace(
    /<!-- workspace-managed:repositories:start -->[\s\S]*?<!-- workspace-managed:repositories:end -->/,
    managed,
  );
  if (next === current) {
    throw new WorkspaceValidationError("AGENTS.md repository managed block is missing");
  }
  await writeFileAtomic(agentsPath, next);
}

async function repositoryRemote(repositoryPath: string): Promise<string | undefined> {
  try {
    return await gitOutput(repositoryPath, ["remote", "get-url", "origin"]) || undefined;
  } catch {
    return undefined;
  }
}

export async function listWorkspaceRepositories(
  idOrSlug: string,
  root = getWorkspaceRoot(),
): Promise<WorkspaceRepositoryState[]> {
  const workspace = await findWorkspace(idOrSlug, root);
  return Promise.all(workspace.manifest.repositories.map(async (repository) => {
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
  root = getWorkspaceRoot(),
): Promise<WorkspaceRepository> {
  const workspace = await findWorkspace(idOrSlug, root);
  const alias = validateRepositoryAlias(requireNonEmptyString(input.alias, "alias"));
  const kind = validateRepositoryKind(input.kind);
  if (input.mode !== "clone" && input.mode !== "init") {
    throw new WorkspaceValidationError("mode must be clone or init");
  }

  return withWorkspaceWriteLock(workspace.path, async () => {
    const manifest = await readWorkspaceManifest(workspace.path);
    if (manifest.repositories.some((repository) => repository.alias === alias)) {
      throw new WorkspaceConflictError(`Repository alias already exists: ${alias}`);
    }

    const repository: WorkspaceRepository = {
      id: createUlid(),
      alias,
      name: optionalString(input.name, "name") ?? alias,
      kind,
      status: "active",
    };
    const { relativePath, absolutePath } = workspaceRepositoryPath(workspace.path, repository);

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
          await writeFile(join(absolutePath, "index.md"), "# Index\n", "utf8");
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

    manifest.repositories.push(repository);
    manifest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(workspace.path, manifest);
    await updateManagedRepositoryInstructions(workspace.path, manifest);
    await commitWorkspaceChanges(workspace.path, `workspace: add ${kind} repository ${alias}`, manifest);
    return repository;
  });
}

export async function removeWorkspaceRepository(
  idOrSlug: string,
  repositoryId: string,
  root = getWorkspaceRoot(),
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
      manifest,
    );
    return { repository };
  });
}

export async function restoreWorkspaceRepository(
  idOrSlug: string,
  repositoryId: string,
  root = getWorkspaceRoot(),
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
      manifest,
    );
    return { repository };
  });
}

export async function discoverWorkspaces(root = getWorkspaceRoot()): Promise<WorkspaceSummary[]> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const workspaces: WorkspaceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_DIRECTORY_RE.test(entry.name)) continue;
    const workspacePath = join(root, entry.name);
    try {
      const manifest = await readWorkspaceManifest(workspacePath);
      workspaces.push(workspaceSummary(workspacePath, manifest));
    } catch {
      // Invalid directories remain on disk and can be diagnosed separately;
      // they are not treated as usable Workspaces.
    }
  }
  return workspaces.sort((left, right) => left.name.localeCompare(right.name));
}

async function ensureWorkspaceRoot(root: string): Promise<void> {
  await mkdir(join(root, ".pi", "workspace-templates"), { recursive: true });
  await mkdir(join(root, ".pi", "trash"), { recursive: true });
}

async function initializeSoftwareDevelopmentWorkspace(
  workspacePath: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  await Promise.all(
    SOFTWARE_DEVELOPMENT_DIRECTORIES.map((relativePath) =>
      mkdir(join(workspacePath, relativePath), { recursive: true })
    ),
  );
  await writeFile(join(workspacePath, "AGENTS.md"), renderSoftwareDevelopmentAgents(manifest), "utf8");
  await writeFile(join(workspacePath, ".gitignore"), SOFTWARE_DEVELOPMENT_GITIGNORE, "utf8");
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: workspacePath });
  await commitWorkspaceChanges(workspacePath, "workspace: initialize", manifest);
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  root = getWorkspaceRoot(),
): Promise<WorkspaceSummary> {
  const name = requireNonEmptyString(input.name, "name");
  const slug = validateWorkspaceSlug(input.slug);
  if (!isWorkspaceTemplateId(input.templateId)) {
    throw new WorkspaceValidationError(`Unknown workspace template: ${String(input.templateId)}`);
  }
  await ensureWorkspaceRoot(root);
  const workspacePath = join(root, `workspace-${slug}`);
  try {
    await access(workspacePath);
    throw new WorkspaceConflictError(`Workspace already exists: workspace-${slug}`);
  } catch (error) {
    if (error instanceof WorkspaceConflictError) throw error;
  }

  const temporaryPath = join(root, `.creating-workspace-${slug}-${createUlid()}`);
  const now = new Date().toISOString();
  const template = getWorkspaceTemplate(input.templateId);
  const manifest: WorkspaceManifest = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: createUlid(),
    slug,
    name,
    template: { id: input.templateId, version: template.version },
    skills: defaultSkillsForTemplate(input.templateId),
    repositories: [],
    agent: {},
    ...(defaultGitForTemplate(input.templateId)
      ? { git: defaultGitForTemplate(input.templateId) }
      : {}),
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
    if (input.templateId === "software-development") {
      await initializeSoftwareDevelopmentWorkspace(temporaryPath, manifest);
    }
    await rename(temporaryPath, workspacePath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
  return workspaceSummary(workspacePath, manifest);
}

async function findWorkspace(
  idOrSlug: string,
  root = getWorkspaceRoot(),
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
  root = getWorkspaceRoot(),
): Promise<{ path: string; manifest: WorkspaceManifest }> {
  return findWorkspace(idOrSlug, root);
}

export async function updateWorkspace(
  idOrSlug: string,
  input: UpdateWorkspaceInput,
  root = getWorkspaceRoot(),
): Promise<WorkspaceSummary> {
  const current = await findWorkspace(idOrSlug, root);
  return withWorkspaceWriteLock(current.path, async () => {
    const latest = await readWorkspaceManifest(current.path);
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== latest.updatedAt) {
      throw new WorkspaceConflictError("Workspace changed since it was loaded");
    }
    if (input.name !== undefined) latest.name = requireNonEmptyString(input.name, "name");
    if (input.skills !== undefined) {
      if (!Array.isArray(input.skills) || input.skills.some((skill) => typeof skill !== "string" || !skill.trim())) {
        throw new WorkspaceValidationError("skills must be an array of non-empty strings");
      }
      latest.skills = [...new Set(input.skills.map((skill) => skill.trim()))];
    }
    latest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(current.path, latest);
    await commitWorkspaceChanges(current.path, "workspace: update settings", latest);
    return workspaceSummary(current.path, latest);
  });
}

export async function trashWorkspace(
  idOrSlug: string,
  root = getWorkspaceRoot(),
): Promise<{ trashedPath: string }> {
  const current = await findWorkspace(idOrSlug, root);
  const resolvedRoot = resolve(root);
  const resolvedWorkspace = resolve(current.path);
  if (!resolvedWorkspace.startsWith(`${resolvedRoot}${sep}`)) {
    throw new WorkspaceValidationError("Workspace is outside the configured root");
  }
  await ensureWorkspaceRoot(root);
  const trashDirectory = join(root, ".pi", "trash", "workspaces");
  await mkdir(trashDirectory, { recursive: true });
  const trashedPath = join(
    trashDirectory,
    `${basename(current.path)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await rename(current.path, trashedPath);
  return { trashedPath };
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
