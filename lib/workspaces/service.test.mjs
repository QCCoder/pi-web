import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { renderOkfSeed } from "./okf.ts";
import {
  addWorkspaceRepository,
  createWorkspace,
  discoverWorkspaces,
  effectiveCapabilities,
  importWorkspace,
  listWorkspaceRepositories,
  readWorkspaceManifest,
  removeWorkspaceRepository,
  restoreWorkspaceRepository,
  removeWorkspace,
  updateWorkspace,
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
  assert.equal(manifest.template, undefined);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer"]);
  assert.deepEqual(manifest.skills, []);
  assert.equal(manifest.workItems.nextBugNumber, 1);
});

test("capability-driven Workspace (software-development equivalent) inits git + AGENTS.md without pre-creating directories", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Commerce",
    slug: "commerce",
    capabilities: ["work-items", "repositories", "overview"],
  }, root);

  for (const path of ["AGENTS.md", ".git", ".gitignore"]) {
    await access(join(summary.path, path));
  }
  // Decision 6 (lazy directories): no scaffolded content directories.
  for (const path of ["requirements", "bugs", "designs", "plans", "repositories"]) {
    await assert.rejects(access(join(summary.path, path)));
  }
  const manifest = await readWorkspaceManifest(summary.path);
  assert.equal(manifest.template, undefined);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "work-items", "repositories", "overview"]);
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

test("discovery keeps pre-repository schema v1 Workspaces visible", async (t) => {
  const root = await fixture(t);
  const workspacePath = join(root, "workspace-existing");
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(join(workspacePath, ".pi", "workspace.yaml"), `schema_version: 1
id: 01KYPYG0HBH7WN4RK71XHZ7WTN
slug: existing
name: Existing
template:
  id: software-development
  version: 1
skills: []
repositories: []
agent: {}
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
  assert.equal(imported.templateId, undefined);
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
  await access(join(created.path, "repositories", "web", "README.md"));
  await access(join(created.path, "knowledge", "product-docs", "index.md"));

  const states = await listWorkspaceRepositories(created.id, root);
  assert.equal(states[0].branch, "main");
  assert.equal(states[0].dirty, false);
  assert.match(states[0].commit, /^[a-f0-9]{12}$/);
  assert.equal(states[0].path, "repositories/web");
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
  const repositoryPath = join(created.path, "repositories", "api");
  await access(join(repositoryPath, ".git"));

  await removeWorkspaceRepository(created.id, repository.id, root);
  assert.equal((await readWorkspaceManifest(created.path)).repositories[0].status, "removed");
  await access(repositoryPath);
  await access(remote);

  await restoreWorkspaceRepository(created.id, repository.id, root);
  assert.equal((await readWorkspaceManifest(created.path)).repositories[0].status, "active");
});

test("createWorkspace stores mandatory and selected capabilities with no template", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Caps",
    slug: "caps",
    capabilities: ["knowledge", "loop", "sessions"], // "sessions" duplicates the mandatory entry
  }, root);

  const manifest = await readWorkspaceManifest(summary.path);
  assert.equal(manifest.template, undefined);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "knowledge", "loop"]);
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

test("parseWorkspaceManifest accepts a manifest without template", async (t) => {
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
  assert.equal(manifest.template, undefined);
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer", "knowledge"]);
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
    capabilities: ["sessions", "explorer", "knowledge", "loop"],
  }, root);
  assert.ok(updated.capabilities.includes("knowledge"));
  assert.ok(updated.capabilities.includes("loop"));

  // Unknown values are still rejected (parseCapabilities guards the registry).
  await assert.rejects(
    updateWorkspace(created.id, {
      expectedUpdatedAt: updated.updatedAt,
      capabilities: ["bogus"],
    }, root),
    (error) => error instanceof WorkspaceValidationError && /Unknown capability/.test(error.message),
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

  const repoDir = join(created.path, "knowledge", "glossary");
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
  assert.match(updated, /knowledge\/docs\/index\.md/);
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

  const repoDir = join(created.path, "knowledge", "imported");
  // Remote structure intact: SPECIAL.md present, index.md NOT replaced by the seed.
  await access(join(repoDir, "SPECIAL.md"));
  const index = await readFile(join(repoDir, "index.md"), "utf8");
  assert.equal(index, "# Custom Remote Index\n");
  // No OKF seed artifacts written over the clone.
  await assert.rejects(access(join(repoDir, "log.md")));
  await assert.rejects(access(join(repoDir, "concepts", "welcome.md")));
});

test("workspaceRepositoryPath falls back to the legacy repositories/<kind>/<alias> layout when the new path is absent", async (t) => {
  // The new flat layout puts code repos at `repositories/<alias>` and knowledge
  // bundles at `knowledge/<alias>`. Existing workspaces that predate this change
  // still have their repos under `repositories/{code,knowledge}/<alias>`. We must
  // NOT force-move them (linked worktrees' absolute gitdir pointers would break),
  // so path resolution prefers the new layout but falls back to the legacy path
  // when only the legacy path exists on disk.
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Legacy Layout",
    slug: "legacy-layout",
    capabilities: ["repositories", "knowledge"],
  }, root);

  // --- Legacy code repo: only the old path exists. ---
  const legacyCodeDir = join(created.path, "repositories", "code", "legacy-x");
  await mkdir(legacyCodeDir, { recursive: true });
  await writeFile(join(legacyCodeDir, "marker"), "legacy", "utf8");
  const legacyCode = workspaceRepositoryPath(created.path, { kind: "code", alias: "legacy-x" });
  assert.equal(legacyCode.relativePath, "repositories/code/legacy-x");
  await access(legacyCode.absolutePath);
  await access(join(legacyCode.absolutePath, "marker"));

  // --- Legacy knowledge bundle: only the old path exists. ---
  const legacyKbDir = join(created.path, "repositories", "knowledge", "legacy-kb");
  await mkdir(legacyKbDir, { recursive: true });
  await writeFile(join(legacyKbDir, "index.md"), "# legacy", "utf8");
  const legacyKb = workspaceRepositoryPath(created.path, { kind: "knowledge", alias: "legacy-kb" });
  assert.equal(legacyKb.relativePath, "repositories/knowledge/legacy-kb");
  await access(legacyKb.absolutePath);
  await access(join(legacyKb.absolutePath, "index.md"));
});

test("workspaceRepositoryPath resolves to the new flat layout when that path exists (or neither exists)", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "New Layout",
    slug: "new-layout",
    capabilities: ["repositories", "knowledge"],
  }, root);

  // --- New code repo: the new path exists → new layout wins. ---
  const newCodeDir = join(created.path, "repositories", "fresh-x");
  await mkdir(newCodeDir, { recursive: true });
  await writeFile(join(newCodeDir, "marker"), "fresh", "utf8");
  const newCode = workspaceRepositoryPath(created.path, { kind: "code", alias: "fresh-x" });
  assert.equal(newCode.relativePath, "repositories/fresh-x");
  await access(join(newCode.absolutePath, "marker"));

  // --- New knowledge bundle: the new path exists → new layout wins. ---
  const newKbDir = join(created.path, "knowledge", "fresh-kb");
  await mkdir(newKbDir, { recursive: true });
  await writeFile(join(newKbDir, "index.md"), "# fresh", "utf8");
  const newKb = workspaceRepositoryPath(created.path, { kind: "knowledge", alias: "fresh-kb" });
  assert.equal(newKb.relativePath, "knowledge/fresh-kb");
  await access(join(newKb.absolutePath, "index.md"));

  // --- Neither path exists (a brand-new repo before addWorkspaceRepository creates it) → new layout by default. ---
  const planned = workspaceRepositoryPath(created.path, { kind: "knowledge", alias: "not-yet" });
  assert.equal(planned.relativePath, "knowledge/not-yet");
  const plannedCode = workspaceRepositoryPath(created.path, { kind: "code", alias: "not-yet" });
  assert.equal(plannedCode.relativePath, "repositories/not-yet");
});

// Build a minimal in-memory WorkspaceManifest. Only the fields relevant to
// effectiveCapabilities vary; the rest use sane defaults so tests stay focused.
function makeManifest({
  template,
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
    ...(template ? { template } : {}),
    workItems: { nextRequirementNumber: 1, nextBugNumber: 1 },
    createdAt: "2026-07-29T12:44:51.115Z",
    updatedAt: "2026-07-29T12:44:51.115Z",
  };
}

function repo(kind, alias, status = "active") {
  return {
    id: `id-${alias}`,
    alias,
    name: alias,
    kind,
    status,
    ...(status === "removed" ? { removedAt: "2026-07-29T12:44:51.115Z" } : {}),
  };
}

// Backward-compat: a pre-redesign workspace (no cached `capabilities`, legacy
// `software-development` template) that has an active knowledge repository must
// surface the `knowledge` capability at read time. This is the core bug fix —
// without it the Activity Bar view, kb_search, and the AGENTS.md knowledge
// segment all stay hidden for these existing workspaces, with no way to enable
// them manually (no general capability toggle in settings).
test("effectiveCapabilities surfaces knowledge for a legacy template workspace with an active knowledge repo", () => {
  const manifest = makeManifest({
    template: { id: "software-development", version: 1 },
    repositories: [repo("knowledge", "docs")],
  });
  const caps = effectiveCapabilities(manifest);
  assert.ok(caps.includes("knowledge"), `expected knowledge, got ${JSON.stringify(caps)}`);
});

test("effectiveCapabilities surfaces repositories for a legacy template workspace with an active code repo", () => {
  const manifest = makeManifest({
    template: { id: "empty", version: 1 },
    repositories: [repo("code", "web")],
  });
  const caps = effectiveCapabilities(manifest);
  assert.ok(caps.includes("repositories"), `expected repositories, got ${JSON.stringify(caps)}`);
});

test("effectiveCapabilities surfaces both repositories and knowledge when both kinds are active", () => {
  const manifest = makeManifest({
    template: { id: "software-development", version: 1 },
    repositories: [repo("code", "web"), repo("knowledge", "docs")],
  });
  const caps = effectiveCapabilities(manifest);
  assert.ok(caps.includes("repositories"));
  assert.ok(caps.includes("knowledge"));
});

test("effectiveCapabilities does not duplicate capabilities already cached on the manifest", () => {
  const manifest = makeManifest({
    capabilities: ["sessions", "explorer", "knowledge"],
    repositories: [repo("knowledge", "docs")],
  });
  const caps = effectiveCapabilities(manifest);
  const knowledgeCount = caps.filter((c) => c === "knowledge").length;
  assert.equal(knowledgeCount, 1, `knowledge must appear once, got ${JSON.stringify(caps)}`);
  assert.ok(caps.includes("knowledge"));
});

test("effectiveCapabilities does not invent knowledge/repositories when there are no active repos", () => {
  const manifest = makeManifest({ template: { id: "software-development", version: 1 } });
  const caps = effectiveCapabilities(manifest);
  // software-development template fallback already lists repositories; knowledge
  // must NOT appear out of nowhere without a knowledge repo.
  assert.ok(!caps.includes("knowledge"), `should not invent knowledge, got ${JSON.stringify(caps)}`);
});

test("effectiveCapabilities ignores removed repositories of a kind (no active repo -> no derived capability)", () => {
  const manifest = makeManifest({
    template: { id: "empty", version: 1 },
    repositories: [repo("knowledge", "docs", "removed")],
  });
  const caps = effectiveCapabilities(manifest);
  assert.ok(!caps.includes("knowledge"), `removed repo must not count, got ${JSON.stringify(caps)}`);
  assert.ok(!caps.includes("repositories"));
});

// NOTE: a `buildWorkspaceExtensions` mounts-kb_search integration test is intentionally
// omitted here. Importing extensions.ts under `node --test` (Node TypeScript
// strip-only mode) hits a PRE-EXISTING limitation: lib/feishu/client.ts uses a
// TypeScript parameter property (`constructor(private readonly config)`), which
// strip-only mode cannot transform. This is unrelated to kb-search and affects the
// whole extensions.ts import graph. The kb_search index logic is fully covered by
// lib/workspaces/kb-search/index.test.mjs, and the factory wiring is verified by
// `tsc --noEmit` + lint and exercised in production via rpc-manager.
