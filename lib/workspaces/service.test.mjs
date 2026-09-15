import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { renderOkfSeed } from "./okf.ts";
import {
  addWorkspaceRepository,
  createWorkspace,
  discoverWorkspaces,
  getWorkspace,
  getWorkspaceIndexPath,
  importWorkspace,
  listWorkspaceRepositories,
  parseCapabilities,
  parseWorkspaceManifest,
  readWorkspaceManifest,
  removeWorkspaceRepository,
  restoreWorkspaceRepository,
  removeWorkspace,
  updateWorkspace,
  updateWorkspaceOrder,
  workspaceRepositoryPath,
  WorkspaceConflictError,
  WorkspaceValidationError,
} from "./service.ts";

/** Extract the raw YAML frontmatter body from a Markdown note (between the opening
 *  `---` fence and its closing `---`), or null if the note has no frontmatter. */
function frontmatterOf(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-workspaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a minimal (sessions/explorer-only) Workspace writes manifest + AGENTS.md only", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Scratch",
    slug: "scratch",
    capabilities: [],
  }, root);

  assert.equal(summary.slug, "scratch");
  const entries = await readdir(summary.path);
  assert.deepEqual([...entries].sort(), [".pi", "AGENTS.md"]);

  const manifest = await readWorkspaceManifest(summary.path);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer"]);
  assert.deepEqual(manifest.skills, []);
  assert.equal(manifest.workItems.nextBugNumber, 1);
});

test("capability-driven Workspace inits git + AGENTS.md without pre-creating directories", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Commerce",
    slug: "commerce",
    capabilities: ["work-items", "repositories"],
  }, root);

  for (const path of ["AGENTS.md", ".git", ".gitignore"]) {
    await access(join(summary.path, path));
  }
  // Decision 6 (lazy directories): no scaffolded content directories.
  for (const path of ["requirements", "bugs", "designs", "plans", "repositories"]) {
    await assert.rejects(access(join(summary.path, path)));
  }
  const manifest = await readWorkspaceManifest(summary.path);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "work-items", "repositories"]);
  assert.deepEqual(manifest.skills, []);
  assert.equal(manifest.git?.createAfter, "plan_approved");
  assert.match(await readFile(join(summary.path, "AGENTS.md"), "utf8"), /workspace-managed:git:start/);
  assert.match(await readFile(join(summary.path, "AGENTS.md"), "utf8"), /workspace-managed:repositories:start/);
  assert.equal((await stat(join(summary.path, ".git"))).isDirectory(), true);
  assert.equal(
    (await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: summary.path })).stdout.trim(),
    "workspace: initialize",
  );
});

test("discovery uses valid manifests and ignores malformed directories", async (t) => {
  const root = await fixture(t);
  await createWorkspace({ name: "B", slug: "b", capabilities: [] }, root);
  await createWorkspace({ name: "A", slug: "a", capabilities: [] }, root);
  await mkdir(join(root, "workspace-broken", ".pi"), { recursive: true });
  await writeFile(join(root, "workspace-broken", ".pi", "workspace.yaml"), "broken: true\n");
  await mkdir(join(root, "not-a-workspace"), { recursive: true });

  const workspaces = await discoverWorkspaces(root);
  assert.deepEqual(workspaces.map((workspace) => workspace.name), ["A", "B"]);
});

test("discovery keeps hand-authored capability-driven Workspaces visible", async (t) => {
  const root = await fixture(t);
  const workspacePath = join(root, "workspace-existing");
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(join(workspacePath, ".pi", "workspace.yaml"), `schema_version: 1
id: 01KYPYG0HBH7WN4RK71XHZ7WTN
slug: existing
name: Existing
skills: []
repositories: []
agent: {}
capabilities: [sessions, explorer, work-items, repositories]
git:
  branch_rules:
    requirement: feature/{date}/{slug}
    bug: hotfix/{date}/{slug}
  create_after: plan_approved
work_items:
  next_requirement_number: 1
  next_bug_number: 1
created_at: 2026-07-29T12:44:51.115Z
updated_at: 2026-07-29T12:44:51.115Z
`);

  const workspaces = await discoverWorkspaces(root);
  assert.deepEqual(workspaces.map((workspace) => workspace.name), ["Existing"]);
});

test("updates use optimistic concurrency", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({ name: "Before", slug: "change", capabilities: [] }, root);
  const updated = await updateWorkspace(created.id, {
    expectedUpdatedAt: created.updatedAt,
    name: "After",
    skills: ["system-design", "system-design"],
  }, root);
  assert.equal(updated.name, "After");
  assert.deepEqual(updated.skills, ["system-design"]);

  await assert.rejects(
    updateWorkspace(created.id, {
      expectedUpdatedAt: created.updatedAt,
      name: "Stale",
    }, root),
    WorkspaceConflictError,
  );
});

test("removing a Workspace only deletes its global registration", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({ name: "Delete me", slug: "delete-me", capabilities: [] }, root);
  const result = await removeWorkspace(created.id, root);

  assert.deepEqual(result, { removed: true });
  await access(created.path);
  await access(join(created.path, ".pi", "workspace.yaml"));
  assert.deepEqual(await discoverWorkspaces(root), []);
});

test("imports an arbitrary external directory as an Empty Workspace", async (t) => {
  const root = await fixture(t);
  const externalParent = await fixture(t);
  const externalPath = join(externalParent, "Existing Project");
  await mkdir(externalPath);

  const imported = await importWorkspace(externalPath, root);
  assert.equal(imported.path, await realpath(externalPath));
  assert.equal(imported.name, "Existing Project");
  assert.deepEqual(imported.capabilities, ["sessions", "explorer"]);
  await access(join(externalPath, ".pi", "workspace.yaml"));

  const rediscovered = await discoverWorkspaces(root);
  assert.deepEqual(rediscovered.map((workspace) => workspace.id), [imported.id]);
});

test("imports a copied Workspace with a new identity when requested", async (t) => {
  const root = await fixture(t);
  const externalParent = await fixture(t);
  const originalPath = join(externalParent, "original");
  const copyPath = join(externalParent, "copy");
  await mkdir(originalPath);
  const original = await importWorkspace(originalPath, root);
  await cp(originalPath, copyPath, { recursive: true });

  await assert.rejects(importWorkspace(copyPath, root), WorkspaceConflictError);
  const copied = await importWorkspace(copyPath, root, true);
  assert.notEqual(copied.id, original.id);
  assert.equal((await readWorkspaceManifest(copyPath)).id, copied.id);
});

test("initializes typed code and knowledge repositories inside a Workspace", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Repositories",
    slug: "repositories",
    capabilities: ["work-items", "repositories"],
  }, root);
  const codeRepository = await addWorkspaceRepository(created.id, {
    alias: "web",
    name: "Web",
    kind: "code",
    mode: "init",
  }, root);
  const knowledgeRepository = await addWorkspaceRepository(created.id, {
    alias: "product-docs",
    name: "Product Docs",
    kind: "knowledge",
    mode: "init",
  }, root);

  assert.equal(codeRepository.kind, "code");
  assert.equal(codeRepository.status, "active");
  assert.match(codeRepository.id, /^[0-9A-Z]+$/);
  assert.equal(knowledgeRepository.kind, "knowledge");
  await access(join(created.path, "web", "README.md"));
  await access(join(created.path, "product-docs", "index.md"));

  const states = await listWorkspaceRepositories(created.id, root);
  assert.equal(states[0].branch, "main");
  assert.equal(states[0].dirty, false);
  assert.match(states[0].commit, /^[a-f0-9]{12}$/);
  assert.equal(states[0].path, "web");
  assert.match(await readFile(join(created.path, "AGENTS.md"), "utf8"), /`web` \(code/);
});

test("clones, disables, and restores a repository without moving its files", async (t) => {
  const root = await fixture(t);
  const remote = join(root, "remote.git");
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote]);
  const created = await createWorkspace({
    name: "Clone",
    slug: "clone",
    capabilities: ["repositories"],
  }, root);

  await addWorkspaceRepository(created.id, {
    alias: "api",
    kind: "code",
    mode: "clone",
    remote,
  }, root);
  const repository = (await readWorkspaceManifest(created.path)).repositories[0];
  const repositoryPath = join(created.path, "api");
  await access(join(repositoryPath, ".git"));

  await removeWorkspaceRepository(created.id, repository.id, root);
  assert.equal((await readWorkspaceManifest(created.path)).repositories[0].status, "removed");
  await access(repositoryPath);
  await access(remote);

  await restoreWorkspaceRepository(created.id, repository.id, root);
  assert.equal((await readWorkspaceManifest(created.path)).repositories[0].status, "active");
});

test("createWorkspace stores mandatory and selected capabilities (dedup, mandatory first)", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Caps",
    slug: "caps",
    capabilities: ["knowledge", "work-items", "sessions"], // "sessions" duplicates the mandatory entry
  }, root);

  const manifest = await readWorkspaceManifest(summary.path);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "knowledge", "work-items"]);
});

test("createWorkspace does not pre-create work-item or repository directories (decision 6)", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Lazy",
    slug: "lazy",
    capabilities: ["work-items", "repositories"],
  }, root);

  const entries = await readdir(summary.path);
  for (const dir of ["requirements", "bugs", "designs", "plans", "repositories"]) {
    assert.ok(!entries.includes(dir), `unexpected pre-created directory: ${dir}`);
  }
  // The manifest, collaboration policy, and git repo are still seeded up front.
  await access(join(summary.path, ".pi", "workspace.yaml"));
  await access(join(summary.path, "AGENTS.md"));
  await access(join(summary.path, ".git"));
});

test("parseWorkspaceManifest accepts a capability-driven manifest", async (t) => {
  const root = await fixture(t);
  const workspacePath = join(root, "workspace-templateless");
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(join(workspacePath, ".pi", "workspace.yaml"), `schema_version: 1
id: 01KYPYG0HBH7WN4RK71XHZ7WTN
slug: templateless
name: Templateless
skills: []
repositories: []
agent: {}
capabilities: [sessions, explorer, knowledge]
work_items:
  next_requirement_number: 1
  next_bug_number: 1
created_at: 2026-07-29T12:44:51.115Z
updated_at: 2026-07-29T12:44:51.115Z
`);

  const manifest = await readWorkspaceManifest(workspacePath);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "knowledge"]);
});

test("disable/re-enable: summary flag + manifest round-trip (false strips the key)", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({ name: "Pausable", slug: "pausable", capabilities: [] }, root);
  const manifestPath = join(created.path, ".pi", "workspace.yaml");

  // 新建默认启用：summary 无停用标记，manifest 不写 disabled 键（旧清单字节不变）。
  assert.equal(created.disabled, false);
  assert.doesNotMatch(await readFile(manifestPath, "utf8"), /^disabled:/m);

  // 停用：summary + manifest 键同时生效。
  const disabledSummary = await updateWorkspace(created.id, { disabled: true }, root);
  assert.equal(disabledSummary.disabled, true);
  assert.equal((await readWorkspaceManifest(created.path)).disabled, true);
  assert.match(await readFile(manifestPath, "utf8"), /^disabled: true$/m);

  // 重新启用：键整个剥掉（从未停用过的清单保持字节兼容）。
  const enabledSummary = await updateWorkspace(created.id, { disabled: false }, root);
  assert.equal(enabledSummary.disabled, false);
  assert.equal((await readWorkspaceManifest(created.path)).disabled, undefined);
  assert.doesNotMatch(await readFile(manifestPath, "utf8"), /^disabled:/m);

  // 非布尔值拒绝。
  await assert.rejects(
    updateWorkspace(created.id, { disabled: "yes" }, root),
    (error) => error instanceof WorkspaceValidationError && /disabled must be a boolean/.test(error.message),
  );

  // 非布尔 disabled 的清单解析直接报错（而非静默忽略）。
  const badPath = join(root, "workspace-bad");
  await mkdir(join(badPath, ".pi"), { recursive: true });
  await writeFile(join(badPath, ".pi", "workspace.yaml"), `schema_version: 1
id: 01KZBADBADBADBADBADBADBAD
slug: bad
name: Bad
skills: []
repositories: []
agent: {}
capabilities: [sessions, explorer]
disabled: "yes"
work_items:
  next_requirement_number: 1
  next_bug_number: 1
created_at: 2026-07-29T12:44:51.115Z
updated_at: 2026-07-29T12:44:51.115Z
`);
  await assert.rejects(readWorkspaceManifest(badPath), /disabled must be a boolean/);
});

test("manual order: full-list PATCH renumbers index sortOrder; unmentioned fall back to MRU", async (t) => {
  const root = await fixture(t);
  const a = await createWorkspace({ name: "A", slug: "a", capabilities: [] }, root);
  const b = await createWorkspace({ name: "B", slug: "b", capabilities: [] }, root);
  const c = await createWorkspace({ name: "C", slug: "c", capabilities: [] }, root);

  // 全量期望序 → 索引 sortOrder 重编，discover 按此返回。
  await updateWorkspaceOrder([b.id, a.id, c.id], root);
  assert.deepEqual((await discoverWorkspaces(root)).map((w) => w.name), ["B", "A", "C"]);

  // 部分提交：未提及的 a/c 剥掉 sortOrder（回落 MRU 段），而非保留旧号 ——
  // 直接读索引验证机制（仅看 discover 顺序无法区分两种实现）。
  await updateWorkspaceOrder([b.id], root);
  const afterPartial = await discoverWorkspaces(root);
  assert.equal(afterPartial[0].name, "B");
  const indexParsed = parse(await readFile(getWorkspaceIndexPath(root), "utf8"));
  const entryById = new Map(indexParsed.workspaces.map((e) => [e.id, e]));
  assert.equal(entryById.get(b.id).sort_order, 1);
  assert.equal(entryById.get(a.id).sort_order, undefined);
  assert.equal(entryById.get(c.id).sort_order, undefined);

  // registerWorkspacePath 每次重建条目（getWorkspace touch）不抹掉手动序。
  // 此时手动段只剩 B；a/c 在 MRU 段，刚被 touch 的 c 最新 → B, C, A。
  await getWorkspace(c.id, root);
  assert.deepEqual((await discoverWorkspaces(root)).map((w) => w.name), ["B", "C", "A"]);

  // 非法输入拒绝。
  await assert.rejects(updateWorkspaceOrder("nope", root), WorkspaceValidationError);
});

test("rename: updateWorkspace name round-trips into manifest + index entry", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({ name: "Old Name", slug: "old-name", capabilities: [] }, root);
  const renamed = await updateWorkspace(created.id, { name: "New Name" }, root);
  assert.equal(renamed.name, "New Name");
  assert.equal((await readWorkspaceManifest(created.path)).name, "New Name");
  // 全局索引条目名同步（registerWorkspacePath 重写）。
  const listed = await discoverWorkspaces(root);
  assert.equal(listed.find((w) => w.id === created.id)?.name, "New Name");
  await assert.rejects(updateWorkspace(created.id, { name: "   " }, root), WorkspaceValidationError);
});

test("AGENTS.md is generated from capabilities (with and without work-items)", async (t) => {
  const root = await fixture(t);
  const withItems = await createWorkspace({
    name: "With Items",
    slug: "with-items",
    capabilities: ["work-items", "repositories"],
  }, root);
  const withAgents = await readFile(join(withItems.path, "AGENTS.md"), "utf8");
  assert.match(withAgents, /## Collaboration flow/);
  assert.match(withAgents, /## Work Item records/);
  assert.match(withAgents, /workspace-managed:git:start/);
  assert.match(withAgents, /workspace-managed:repositories:start/);

  const withoutItems = await createWorkspace({
    name: "Without Items",
    slug: "without-items",
    capabilities: ["repositories"],
  }, root);
  const withoutAgents = await readFile(join(withoutItems.path, "AGENTS.md"), "utf8");
  assert.doesNotMatch(withoutAgents, /## Collaboration flow/);
  assert.doesNotMatch(withoutAgents, /## Work Item records/);
  // repositories-only has no git settings, so no git block.
  assert.doesNotMatch(withoutAgents, /workspace-managed:git:start/);
  assert.match(withoutAgents, /workspace-managed:repositories:start/);
});

test("PATCH capabilities accepts knowledge (registered in ALL_WORKSPACE_CAPABILITIES)", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Patch",
    slug: "patch",
    capabilities: [],
  }, root);
  const updated = await updateWorkspace(created.id, {
    expectedUpdatedAt: created.updatedAt,
    capabilities: ["sessions", "explorer", "knowledge", "work-items"],
  }, root);
  assert.ok(updated.capabilities.includes("knowledge"));
  assert.ok(updated.capabilities.includes("work-items"));

  // Unknown values are still rejected (parseCapabilities guards the registry).
  await assert.rejects(
    updateWorkspace(created.id, {
      expectedUpdatedAt: updated.updatedAt,
      capabilities: ["bogus"],
    }, root),
    (error) => error instanceof WorkspaceValidationError && /Unknown capability/.test(error.message),
  );

  // Retired values are likewise rejected on write — `loop` was replaced by the
  // pi-loop kit and only survives via the read-path strip of legacy manifests.
  await assert.rejects(
    updateWorkspace(created.id, {
      expectedUpdatedAt: updated.updatedAt,
      capabilities: ["loop"],
    }, root),
    (error) => error instanceof WorkspaceValidationError && /Unknown capability: loop/.test(error.message),
  );
});

test("renderOkfSeed produces YAML-parseable frontmatter with a type field", () => {
  const seed = renderOkfSeed("product-docs");
  assert.ok(seed.files["index.md"]);
  assert.ok(seed.files["log.md"]);
  assert.ok(seed.files["concepts/welcome.md"]);
  for (const [filePath, content] of Object.entries(seed.files)) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(match, `${filePath} should have YAML frontmatter`);
    const frontmatter = parse(match[1]);
    assert.equal(
      typeof frontmatter.type,
      "string",
      `${filePath} frontmatter should declare a type`,
    );
  }
});

test("initializing a knowledge repo seeds an OKF v0.2 structure (index/log/concept)", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Knowledge WS",
    slug: "knowledge-ws",
    capabilities: ["knowledge"],
  }, root);
  await addWorkspaceRepository(created.id, {
    alias: "glossary",
    name: "Glossary",
    kind: "knowledge",
    mode: "init",
  }, root);

  const repoDir = join(created.path, "glossary");
  // index.md is the progressive-disclosure entry, carrying type: index frontmatter.
  const index = await readFile(join(repoDir, "index.md"), "utf8");
  assert.match(frontmatterOf(index), /type: index/);
  assert.match(index, /progressive disclosure/i);
  // log.md exists with type: log.
  const log = await readFile(join(repoDir, "log.md"), "utf8");
  assert.match(frontmatterOf(log), /type: log/);
  // At least one concept note with type: concept + tags frontmatter.
  const welcome = await readFile(join(repoDir, "concepts", "welcome.md"), "utf8");
  assert.match(frontmatterOf(welcome), /type: concept/);
  assert.match(welcome, /tags:/);
});

test("AGENTS.md knowledge managed segment tracks add/remove knowledge repos and preserves user content", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Kb WS",
    slug: "kb-ws",
    capabilities: ["knowledge"],
  }, root);
  const agentsPath = join(created.path, "AGENTS.md");

  // At creation the knowledge segment exists with the empty placeholder.
  let agents = await readFile(agentsPath, "utf8");
  assert.match(agents, /workspace-managed:knowledge:start/);
  assert.match(agents, /No knowledge bundles are configured/);

  // Inject user content OUTSIDE the managed markers; it must survive segment rewrites.
  const userNote = "\n## My notes\nThis is user content outside managed markers.\n";
  await writeFile(agentsPath, agents + userNote, "utf8");

  // Add a knowledge repo -> segment now references its index.md.
  const repo = await addWorkspaceRepository(created.id, {
    alias: "docs",
    name: "Docs",
    kind: "knowledge",
    mode: "init",
  }, root);
  let updated = await readFile(agentsPath, "utf8");
  assert.match(updated, /workspace-managed:knowledge:start/);
  assert.match(updated, /`docs` \(id: .*\): OKF bundle — read its index at `docs\/index\.md`/);
  assert.match(updated, /## My notes/);
  assert.match(updated, /This is user content outside managed markers\./);

  // Remove -> segment goes back to the placeholder; user content still intact.
  await removeWorkspaceRepository(created.id, repo.id, root);
  updated = await readFile(agentsPath, "utf8");
  assert.match(updated, /No knowledge bundles are configured/);
  assert.match(updated, /## My notes/);
});

test("cloning a knowledge repo does not overwrite its remote OKF structure", async (t) => {
  const root = await fixture(t);
  // Build a source repo carrying its own custom structure.
  const source = join(root, "kb-source");
  await mkdir(source, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: source });
  await execFileAsync("git", ["config", "user.email", "t@t.t"], { cwd: source });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: source });
  await writeFile(join(source, "index.md"), "# Custom Remote Index\n", "utf8");
  await writeFile(join(source, "SPECIAL.md"), "# Do not overwrite\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: source });
  await execFileAsync("git", ["commit", "-m", "remote content"], { cwd: source });

  const created = await createWorkspace({
    name: "Clone Kb",
    slug: "clone-kb",
    capabilities: ["knowledge"],
  }, root);
  await addWorkspaceRepository(created.id, {
    alias: "imported",
    kind: "knowledge",
    mode: "clone",
    remote: source,
  }, root);

  const repoDir = join(created.path, "imported");
  // Remote structure intact: SPECIAL.md present, index.md NOT replaced by the seed.
  await access(join(repoDir, "SPECIAL.md"));
  const index = await readFile(join(repoDir, "index.md"), "utf8");
  assert.equal(index, "# Custom Remote Index\n");
  // No OKF seed artifacts written over the clone.
  await assert.rejects(access(join(repoDir, "log.md")));
  await assert.rejects(access(join(repoDir, "concepts", "welcome.md")));
});

test("workspaceRepositoryPath resolves through the manifest's registered path (path-registration convention)", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Path Registration",
    slug: "path-registration",
    capabilities: ["repositories", "knowledge"],
  }, root);

  // --- The registered path is used verbatim: any root-level project dir works. ---
  const customDir = join(created.path, "cargoware-haichuang");
  await mkdir(customDir, { recursive: true });
  await writeFile(join(customDir, "marker"), "fresh", "utf8");
  const registered = workspaceRepositoryPath(created.path, { path: "cargoware-haichuang" });
  assert.equal(registered.relativePath, "cargoware-haichuang");
  await access(registered.absolutePath);
  await access(join(registered.absolutePath, "marker"));

  // --- Nested paths are fine too (e.g. a legacy layout dir kept in place). ---
  const legacyDir = join(created.path, "repositories", "old-clone");
  await mkdir(legacyDir, { recursive: true });
  const legacy = workspaceRepositoryPath(created.path, { path: "repositories/old-clone" });
  assert.equal(legacy.relativePath, "repositories/old-clone");
  assert.equal(legacy.absolutePath, join(created.path, "repositories", "old-clone"));
});

test("addWorkspaceRepository register mode registers an existing directory without touching it", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Register",
    slug: "register",
    capabilities: ["repositories", "knowledge"],
  }, root);
  const existing = join(created.path, "cxin-knowledge");
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, "index.md"), "# mine\n", "utf8");

  const repository = await addWorkspaceRepository(created.id, {
    alias: "cxin-knowledge",
    kind: "knowledge",
    mode: "register",
    path: "cxin-knowledge",
  }, root);
  assert.equal(repository.path, "cxin-knowledge");
  // Directory untouched (no git init, no seed).
  await access(join(existing, "index.md"));
  await assert.rejects(access(join(existing, ".git")));

  // register mode with a missing directory is a validation error.
  await assert.rejects(
    addWorkspaceRepository(created.id, {
      alias: "nope",
      kind: "code",
      mode: "register",
      path: "does-not-exist",
    }, root),
    /does not exist/,
  );
});

test("addWorkspaceRepository rejects traversal, absolute paths and .pi/ targets", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Guard",
    slug: "guard",
    capabilities: ["repositories"],
  }, root);
  let caseIndex = 0;
  for (const bad of ["../escape", "/abs", ".pi/loop", "a/../b"]) {
    caseIndex += 1;
    await assert.rejects(
      addWorkspaceRepository(created.id, {
        alias: `bad-${caseIndex}`,
        kind: "code",
        mode: "register",
        path: bad,
      }, root),
    );
  }
});

// Build a minimal in-memory WorkspaceManifest. Only the fields relevant to
// effectiveCapabilities vary; the rest use sane defaults so tests stay focused.
function makeManifest({
  capabilities,
  repositories = [],
} = {}) {
  return {
    schemaVersion: 1,
    id: "01KYPYG0HBH7WN4RK71XHZ7WTN",
    slug: "fixture",
    name: "Fixture",
    skills: [],
    repositories,
    agent: {},
    ...(capabilities ? { capabilities } : {}),
    workItems: { nextRequirementNumber: 1, nextBugNumber: 1 },
    createdAt: "2026-07-29T12:44:51.115Z",
    updatedAt: "2026-07-29T12:44:51.115Z",
  };
}

test("parseWorkspaceManifest requires explicit capabilities", () => {
  const base = {
    schema_version: 1,
    id: "01KYPYG0HBH7WN4RK71XHZ7WTN",
    slug: "fixture",
    name: "Fixture",
    skills: [],
    repositories: [],
    agent: {},
    work_items: { next_requirement_number: 1, next_bug_number: 1 },
    created_at: "2026-07-29T12:44:51.115Z",
    updated_at: "2026-07-29T12:44:51.115Z",
  };
  const manifest = parseWorkspaceManifest({
    ...base,
    capabilities: ["sessions", "explorer", "knowledge"],
  });
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "knowledge"]);
  assert.throws(
    () => parseWorkspaceManifest(base),
    /capabilities is required/,
  );
});

test("parseCapabilities rejects retired channel values instead of silently stripping", () => {
  assert.throws(
    () => parseCapabilities(["sessions", "feishu-channel"]),
    /Unknown capability: feishu-channel/,
  );
});

test("legacy manifests keep parsing with the retired overview capability stripped on read", () => {
  const base = {
    schema_version: 1,
    id: "01KYPYG0HBH7WN4RK71XHZ7WTN",
    slug: "fixture",
    name: "Fixture",
    skills: [],
    repositories: [],
    agent: {},
    work_items: { next_requirement_number: 1, next_bug_number: 1 },
    created_at: "2026-07-29T12:44:51.115Z",
    updated_at: "2026-07-29T12:44:51.115Z",
  };
  // Read path: the retired value is stripped BEFORE validation, so a legacy
  // manifest (overview-era) still parses and normalizes in memory.
  const manifest = parseWorkspaceManifest({
    ...base,
    capabilities: ["sessions", "explorer", "overview", "knowledge"],
  });
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "knowledge"]);
  // Write path: NEW selections are rejected — overview is no longer in the
  // ALL_WORKSPACE_CAPABILITIES registry.
  assert.throws(
    () => parseCapabilities(["overview"]),
    /Unknown capability: overview/,
  );
});

test("legacy manifests keep parsing with the retired loop capability stripped on read", () => {
  const base = {
    schema_version: 1,
    id: "01KYPYG0HBH7WN4RK71XHZ7WTN",
    slug: "fixture",
    name: "Fixture",
    skills: [],
    repositories: [],
    agent: {},
    work_items: { next_requirement_number: 1, next_bug_number: 1 },
    created_at: "2026-07-29T12:44:51.115Z",
    updated_at: "2026-07-29T12:44:51.115Z",
  };
  // Read path: the retired value is stripped BEFORE validation, so a v3-era
  // manifest listing `loop` still parses. Kit loops are file-declared
  // (loops/<loopId>/LOOP.md presence) with no capability gate (D5) — the value
  // is physically dropped at the next manifest write.
  const manifest = parseWorkspaceManifest({
    ...base,
    capabilities: ["sessions", "explorer", "work-items", "loop"],
  });
  assert.ok(!manifest.capabilities.includes("loop"));
  assert.ok(manifest.capabilities.includes("sessions"));
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "work-items"]);
  // Write path: NEW selections are rejected — loop is no longer in the
  // ALL_WORKSPACE_CAPABILITIES registry.
  assert.throws(
    () => parseCapabilities(["loop"]),
    /Unknown capability: loop/,
  );
});

test("buildWorkspaceExtensions mounts modules by capability", async () => {
  const { buildWorkspaceExtensions } = await import("./extensions.ts");
  const manifest = makeManifest({
    capabilities: ["sessions", "explorer", "work-items", "knowledge"],
  });
  const names = buildWorkspaceExtensions(manifest, "/tmp/fixture-ws").map((e) => e.name);
  // Extensions are lazy {name, factory} modules; asserting on names covers the
  // capability filtering (tools materialize only inside a real pi context).
  assert.ok(names.includes("pi-workspace-work-items"), "work-items module should mount");
  assert.ok(names.includes("pi-kb-search"), "kb_search module should mount for knowledge");
});

test("v1 index migration rewrites manifests: capabilities materialized, retired values stripped", async (t) => {
  const root = await fixture(t);
  const wsPath = join(root, "workspace-legacy");
  await mkdir(join(wsPath, ".pi"), { recursive: true });
  const manifestYaml = {
    schema_version: 1,
    id: "01LEGACY0000000000000000000",
    slug: "legacy",
    name: "Legacy",
    skills: [],
    repositories: [],
    agent: {},
    capabilities: ["sessions", "explorer", "feishu-channel", "feishu-transport"],
    work_items: { next_requirement_number: 1, next_bug_number: 1 },
    created_at: "2026-07-29T12:44:51.115Z",
    updated_at: "2026-07-29T12:44:51.115Z",
  };
  await writeFile(join(wsPath, ".pi", "workspace.yaml"), stringify(manifestYaml), "utf8");
  // v1 global index pointing at the workspace.
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi", "workspace.yaml"),
    stringify({
      schema_version: 1,
      workspaces: [{
        id: "01LEGACY0000000000000000000",
        path: wsPath,
        name: "Legacy",
        added_at: "2026-07-29T12:44:51.115Z",
        last_opened_at: "2026-07-29T12:44:51.115Z",
      }],
    }),
    "utf8",
  );
  const summaries = await discoverWorkspaces(root);
  assert.equal(summaries.length, 1);
  assert.ok(summaries[0].available);
  assert.deepEqual(summaries[0].capabilities, ["sessions", "explorer"]);
  const migrated = parse(await readFile(join(wsPath, ".pi", "workspace.yaml"), "utf8"));
  assert.deepEqual(migrated.capabilities, ["sessions", "explorer"]);
  const index = parse(await readFile(join(root, ".pi", "workspace.yaml"), "utf8"));
  assert.equal(index.schema_version, 2);
});

// NOTE: the `buildWorkspaceExtensions` integration test above imports
// extensions.ts dynamically. It previously could not be imported under
// `node --test` strip-only mode at all (lib/feishu/client.ts used a TypeScript
// parameter property, poisoning the whole import graph); deleting the feishu
// module fixed that, so the test now runs for real.

test("auto-scan sync: 根下 git 仓与 OKF 知识库打开列表即自动登记", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Scan",
    slug: "scan",
    capabilities: ["repositories", "knowledge"],
  }, root);

  // 手工放两个目录（模拟用户往根里放仓），不经任何登记 API
  await mkdir(join(created.path, "proj-a"), { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: join(created.path, "proj-a") });
  await mkdir(join(created.path, "kb-b"), { recursive: true });
  await writeFile(join(created.path, "kb-b", "index.md"), "# i", "utf8");
  await writeFile(join(created.path, "kb-b", "log.md"), "# l", "utf8");

  const states = await listWorkspaceRepositories(created.id, root);
  const projA = states.find((state) => state.path === "proj-a");
  const kbB = states.find((state) => state.path === "kb-b");
  assert.equal(projA?.kind, "code");
  assert.equal(projA?.status, "active");
  assert.equal(kbB?.kind, "knowledge");

  // 落盘：manifest 与 AGENTS.md managed 段同步
  const manifest = await readWorkspaceManifest(created.path);
  assert.ok(manifest.repositories.some((repository) => repository.path === "proj-a"));
  const agents = await readFile(join(created.path, "AGENTS.md"), "utf8");
  assert.match(agents, /`proj-a` \(code/);
  assert.match(agents, /`kb-b` \(id: .*\): OKF bundle/);
});

test("auto-scan sync: 消失自动停用、重现自动恢复、钉住 alias 不被扫描改写", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Scan2",
    slug: "scan2",
    capabilities: ["repositories", "knowledge"],
  }, root);
  await mkdir(join(created.path, "proj-a"), { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: join(created.path, "proj-a") });

  // 钉住 alias（路径登记 + 自定 alias，不落盘文件也允许——register 语义的scan前手登记）
  await addWorkspaceRepository(created.id, {
    alias: "pinned",
    kind: "code",
    mode: "register",
    path: "proj-a",
  }, root);

  let states = await listWorkspaceRepositories(created.id, root);
  assert.equal(states.find((state) => state.path === "proj-a")?.alias, "pinned");

  // 磁盘上消失 → 自动停用（保留条目）
  await rm(join(created.path, "proj-a"), { recursive: true, force: true });
  states = await listWorkspaceRepositories(created.id, root);
  assert.equal(states.find((state) => state.path === "proj-a")?.status, "removed");

  // 重现 → 自动恢复，钉住 alias 仍在
  await mkdir(join(created.path, "proj-a"), { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: join(created.path, "proj-a") });
  states = await listWorkspaceRepositories(created.id, root);
  const restored = states.find((state) => state.path === "proj-a");
  assert.equal(restored?.status, "active");
  assert.equal(restored?.alias, "pinned");
});

test("auto-scan sync: 非法字符目录名规整为 alias，冲突加后缀", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Scan3",
    slug: "scan3",
    capabilities: ["repositories"],
  }, root);
  for (const dir of ["My Repo", "my-repo"]) {
    await mkdir(join(created.path, dir), { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: join(created.path, dir) });
  }
  const states = await listWorkspaceRepositories(created.id, root);
  const aliases = states.filter((state) => state.path !== "").map((state) => state.alias).sort();
  assert.deepEqual(aliases, ["my-repo", "my-repo-2"]);
});
