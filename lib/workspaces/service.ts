import { execFile } from "node:child_process";
import {
  access,
  cp,
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
import {
  BUILT_IN_WORKSPACE_TEMPLATES,
  defaultGitForTemplate,
  defaultSkillsForTemplate,
  getWorkspaceTemplate,
  isBuiltinWorkspaceTemplateId,
  renderSoftwareDevelopmentAgents,
  renderWorkspaceRepositories,
  SOFTWARE_DEVELOPMENT_DIRECTORIES,
  SOFTWARE_DEVELOPMENT_GITIGNORE,
  SOFTWARE_DEVELOPMENT_SKILLS,
} from "./templates.ts";
import {
  WORKSPACE_SCHEMA_VERSION,
  type BuiltinWorkspaceTemplateId,
  type CreateWorkspaceInput,
  type AddWorkspaceRepositoryInput,
  type UpdateWorkspaceInput,
  type WorkspaceCapability,
  type WorkspaceCustomTemplate,
  type WorkspaceManifest,
  type WorkspaceIndex,
  type WorkspaceIndexEntry,
  type WorkspaceRepository,
  type WorkspaceRepositoryKind,
  type WorkspaceRepositoryState,
  type WorkspaceSummary,
  type WorkspaceTemplateInfo,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_DIRECTORY_RE = /^workspace-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKSPACE_INDEX_SCHEMA_VERSION = 1 as const;

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
  "overview",
  "workflows",
  "feishu-transport",
  "feishu-channel",
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

/** Capabilities currently in effect for a workspace: cached snapshot, else the
 *  built-in template lookup, else the bare minimum. */
export function effectiveCapabilities(manifest: WorkspaceManifest): WorkspaceCapability[] {
  if (manifest.capabilities) return manifest.capabilities;
  const builtIn = BUILT_IN_WORKSPACE_TEMPLATES.find((candidate) =>
    candidate.id === manifest.template.id && candidate.version === manifest.template.version
  );
  return builtIn ? [...builtIn.capabilities] : (["sessions", "explorer"] as WorkspaceCapability[]);
}

export async function listWorkspaceTemplates(root?: string): Promise<WorkspaceTemplateInfo[]> {
  const builtIns: WorkspaceTemplateInfo[] = BUILT_IN_WORKSPACE_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    version: template.version,
    capabilities: [...template.capabilities],
    source: "built-in",
    skills: [...template.skills],
    editable: false,
  }));
  const customs = await discoverCustomTemplates(root);
  const customInfos: WorkspaceTemplateInfo[] = customs.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    version: template.version,
    capabilities: [...template.capabilities],
    source: "custom",
    skills: [...template.skills],
    editable: true,
  }));
  return [...builtIns, ...customInfos];
}

function customTemplatesDir(root?: string): string {
  return join(root ?? getWorkspaceRoot(), ".pi", "workspace-templates");
}

export function parseCustomTemplate(value: unknown, templatePath: string): WorkspaceCustomTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceValidationError("Custom template must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) {
    throw new WorkspaceValidationError("Custom template schema_version must be 1");
  }
  const id = validateWorkspaceSlug(requireNonEmptyString(record.id, "id"));
  const dirName = basename(templatePath);
  if (id !== dirName) {
    throw new WorkspaceValidationError(
      `Custom template id "${id}" must equal its directory name "${dirName}"`,
    );
  }
  const skillsRaw = record.skills ?? [];
  if (
    !Array.isArray(skillsRaw)
    || skillsRaw.some((skill) => typeof skill !== "string" || !skill.trim())
  ) {
    throw new WorkspaceValidationError("skills must be an array of non-empty strings");
  }
  const agentValue = record.agent ?? {};
  if (!agentValue || typeof agentValue !== "object" || Array.isArray(agentValue)) {
    throw new WorkspaceValidationError("agent must be an object");
  }
  const agentRecord = agentValue as Record<string, unknown>;
  return {
    schemaVersion: 1,
    id,
    name: requireNonEmptyString(record.name, "name"),
    description: optionalString(record.description, "description") ?? "",
    version: parsePositiveInteger(record.version, "version"),
    capabilities: parseCapabilities(record.capabilities),
    skills: [...new Set((skillsRaw as string[]).map((skill) => skill.trim()))],
    agent: {
      ...(optionalString(agentRecord.default_model, "agent.default_model")
        ? { defaultModel: optionalString(agentRecord.default_model, "agent.default_model") }
        : {}),
      ...(optionalString(agentRecord.thinking_level, "agent.thinking_level")
        ? { thinkingLevel: optionalString(agentRecord.thinking_level, "agent.thinking_level") }
        : {}),
    },
    path: templatePath,
  };
}

export async function discoverCustomTemplates(root?: string): Promise<WorkspaceCustomTemplate[]> {
  const templatesDir = customTemplatesDir(root);
  let entries;
  try {
    entries = await readdir(templatesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const templates: WorkspaceCustomTemplate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(templatesDir, entry.name);
    try {
      const content = await readFile(join(dir, "template.yaml"), "utf8");
      templates.push(parseCustomTemplate(parse(content), dir));
    } catch {
      // Skip malformed or incomplete custom template directories.
    }
  }
  return templates;
}

export async function getCustomTemplate(
  id: string,
  root?: string,
): Promise<WorkspaceCustomTemplate | undefined> {
  const customs = await discoverCustomTemplates(root);
  return customs.find((template) => template.id === id);
}

/** Copy a custom template's `seed/` contents into a freshly created workspace. */
async function applyCustomTemplateSeed(workspacePath: string, templatePath: string): Promise<void> {
  const seedDir = join(templatePath, "seed");
  try {
    if (!(await stat(seedDir)).isDirectory()) return;
  } catch {
    return; // no seed directory
  }
  for (const entry of await readdir(seedDir)) {
    // Never let a seed overwrite the workspace manifest we are about to write.
    if (entry === ".pi") {
      const seedPi = join(seedDir, ".pi");
      await mkdir(join(workspacePath, ".pi"), { recursive: true });
      for (const piEntry of await readdir(seedPi)) {
        if (piEntry === "workspace.yaml") continue;
        await cp(join(seedPi, piEntry), join(workspacePath, ".pi", piEntry), { recursive: true });
      }
      continue;
    }
    await cp(join(seedDir, entry), join(workspacePath, entry), { recursive: true });
  }
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
  const templateId = requireNonEmptyString(templateRecord.id, "template.id");
  const skills = record.skills ?? [];
  if (!Array.isArray(skills) || skills.some((skill) => typeof skill !== "string" || !skill.trim())) {
    throw new WorkspaceValidationError("skills must be an array of non-empty strings");
  }
  const agent = record.agent ?? {};
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new WorkspaceValidationError("agent must be an object");
  }
  const agentRecord = agent as Record<string, unknown>;
  const capabilities =
    record.capabilities === undefined ? undefined : parseCapabilities(record.capabilities);
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
      id: templateId as WorkspaceManifest["template"]["id"],
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
    ...(capabilities ? { capabilities } : {}),
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
    ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
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
  return parseWorkspaceManifest(parse(content));
}

export function workspaceSummary(workspacePath: string, manifest: WorkspaceManifest): WorkspaceSummary {
  return {
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    path: workspacePath,
    templateId: manifest.template.id,
    templateVersion: manifest.template.version,
    capabilities: [...effectiveCapabilities(manifest)],
    available: true,
    configStatus: "ready",
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
  if (!effectiveCapabilities(manifest).includes("repositories")) return;
  const agentsPath = join(workspacePath, "AGENTS.md");
  let current: string;
  try {
    current = await readFile(agentsPath, "utf8");
  } catch {
    return; // no AGENTS.md to maintain
  }
  const managed = renderWorkspaceRepositories(manifest);
  const next = current.replace(
    /<!-- workspace-managed:repositories:start -->[\s\S]*?<!-- workspace-managed:repositories:end -->/,
    managed,
  );
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

export async function listWorkspaceRepositories(
  idOrSlug: string,
  root?: string,
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
  root?: string,
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
      manifest,
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
      manifest,
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
    return {
      id,
      path,
      name: requireNonEmptyString(entry.name, `workspaces[${index}].name`),
      templateId: requireNonEmptyString(entry.template_id, `workspaces[${index}].template_id`),
      templateVersion: parsePositiveInteger(
        entry.template_version,
        `workspaces[${index}].template_version`,
      ),
      addedAt: requireNonEmptyString(entry.added_at, `workspaces[${index}].added_at`),
      lastOpenedAt: requireNonEmptyString(
        entry.last_opened_at,
        `workspaces[${index}].last_opened_at`,
      ),
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
      template_id: workspace.templateId,
      template_version: workspace.templateVersion,
      added_at: workspace.addedAt,
      last_opened_at: workspace.lastOpenedAt,
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
    templateId: manifest.template.id,
    templateVersion: manifest.template.version,
    addedAt: existing?.addedAt ?? now,
    lastOpenedAt: existing?.lastOpenedAt ?? now,
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
  const template = BUILT_IN_WORKSPACE_TEMPLATES.find((candidate) =>
    candidate.id === entry.templateId && candidate.version === entry.templateVersion
  );
  return {
    id: entry.id,
    slug: basename(entry.path),
    name: entry.name,
    path: entry.path,
    templateId: entry.templateId as WorkspaceManifest["template"]["id"],
    templateVersion: entry.templateVersion,
    capabilities: template ? [...template.capabilities] : ["sessions", "explorer"],
    available: false,
    configStatus: status,
    skills: [],
    repositories: [],
    repositoryCount: 0,
    createdAt: entry.addedAt,
    updatedAt: entry.lastOpenedAt,
  };
}

async function migrateManagedWorkspaces(root: string, indexRoot?: string): Promise<WorkspaceIndex> {
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
      // Malformed legacy directories stay untouched and are not registered.
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
    : await migrateManagedWorkspaces(workspaceRoot, root);
  const summaries: Array<{ summary: WorkspaceSummary; lastOpenedAt: string }> = [];
  let snapshotsChanged = false;
  for (const entry of index.workspaces) {
    try {
      const directory = await stat(entry.path);
      if (!directory.isDirectory()) {
        summaries.push({
          summary: unavailableWorkspaceSummary(entry, "directory-unavailable"),
          lastOpenedAt: entry.lastOpenedAt,
        });
        continue;
      }
    } catch {
      summaries.push({
        summary: unavailableWorkspaceSummary(entry, "directory-unavailable"),
        lastOpenedAt: entry.lastOpenedAt,
      });
      continue;
    }
    try {
      const manifest = await readWorkspaceManifest(entry.path);
      if (manifest.id !== entry.id) {
        summaries.push({
          summary: unavailableWorkspaceSummary(entry, "config-invalid"),
          lastOpenedAt: entry.lastOpenedAt,
        });
        continue;
      }
      const nextEntry = indexEntryFromManifest(entry.path, manifest, entry);
      nextEntry.lastOpenedAt = entry.lastOpenedAt;
      if (
        nextEntry.name !== entry.name
        || nextEntry.templateId !== entry.templateId
        || nextEntry.templateVersion !== entry.templateVersion
      ) {
        Object.assign(entry, nextEntry);
        snapshotsChanged = true;
      }
      summaries.push({
        summary: workspaceSummary(entry.path, manifest),
        lastOpenedAt: entry.lastOpenedAt,
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
      });
    }
  }
  if (snapshotsChanged) await writeWorkspaceIndex(index, root);
  return summaries
    .sort((left, right) => {
      if (left.summary.available !== right.summary.available) {
        return left.summary.available ? -1 : 1;
      }
      return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
    })
    .map(({ summary }) => summary);
}

async function ensureWorkspaceRoot(root: string): Promise<void> {
  await mkdir(join(root, ".pi", "workspace-templates"), { recursive: true });
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
  root?: string,
): Promise<WorkspaceSummary> {
  const workspaceRoot = root ?? getWorkspaceRoot();
  const name = requireNonEmptyString(input.name, "name");
  const slug = validateWorkspaceSlug(input.slug);
  const isBuiltin = isBuiltinWorkspaceTemplateId(input.templateId);

  // Resolve the template: a built-in constant or a discovered custom definition.
  let templateVersion: number;
  let templateSkills: string[];
  let templateCapabilities: WorkspaceCapability[];
  let templateAgent: WorkspaceManifest["agent"];
  let customTemplatePath: string | undefined;
  if (isBuiltin) {
    const builtin = getWorkspaceTemplate(input.templateId as BuiltinWorkspaceTemplateId);
    templateVersion = builtin.version;
    templateSkills = defaultSkillsForTemplate(input.templateId);
    templateCapabilities = [...builtin.capabilities];
    templateAgent = {};
  } else {
    const custom = await getCustomTemplate(input.templateId, root);
    if (!custom) {
      throw new WorkspaceValidationError(`Unknown workspace template: ${String(input.templateId)}`);
    }
    templateVersion = custom.version;
    templateSkills = [...custom.skills];
    templateCapabilities = [...custom.capabilities];
    templateAgent = { ...custom.agent };
    customTemplatePath = custom.path;
  }

  await ensureWorkspaceRoot(workspaceRoot);
  const workspacePath = join(workspaceRoot, `workspace-${slug}`);
  try {
    await access(workspacePath);
    throw new WorkspaceConflictError(`Workspace already exists: workspace-${slug}`);
  } catch (error) {
    if (error instanceof WorkspaceConflictError) throw error;
  }

  const temporaryPath = join(workspaceRoot, `.creating-workspace-${slug}-${createUlid()}`);
  const now = new Date().toISOString();
  const manifest: WorkspaceManifest = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: createUlid(),
    slug,
    name,
    template: { id: input.templateId, version: templateVersion },
    skills: templateSkills,
    repositories: [],
    agent: templateAgent,
    capabilities: templateCapabilities,
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
    if (customTemplatePath) {
      await applyCustomTemplateSeed(temporaryPath, customTemplatePath);
    }
    await writeFileAtomic(
      join(temporaryPath, ".pi", "workspace.yaml"),
      serializeWorkspaceManifest(manifest),
    );
    if (isBuiltin && input.templateId === "software-development") {
      await initializeSoftwareDevelopmentWorkspace(temporaryPath, manifest);
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
    if (input.skills !== undefined) {
      if (!Array.isArray(input.skills) || input.skills.some((skill) => typeof skill !== "string" || !skill.trim())) {
        throw new WorkspaceValidationError("skills must be an array of non-empty strings");
      }
      latest.skills = [...new Set(input.skills.map((skill) => skill.trim()))];
    }
    if (input.capabilities !== undefined) {
      latest.capabilities = parseCapabilities(input.capabilities);
    }
    latest.updatedAt = new Date().toISOString();
    await writeWorkspaceManifest(current.path, latest);
    await commitWorkspaceChanges(current.path, "workspace: update settings", latest);
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
    const now = new Date().toISOString();
    manifest = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      id: createUlid(),
      slug: slugFromDirectoryName(basename(workspacePath)),
      name: basename(workspacePath),
      template: { id: "empty", version: getWorkspaceTemplate("empty").version },
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
