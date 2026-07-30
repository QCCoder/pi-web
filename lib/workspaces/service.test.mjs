import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  addWorkspaceRepository,
  createWorkspace,
  discoverWorkspaces,
  listWorkspaceRepositories,
  readWorkspaceManifest,
  removeWorkspaceRepository,
  restoreWorkspaceRepository,
  trashWorkspace,
  updateWorkspace,
  WorkspaceConflictError,
} from "./service.ts";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-workspaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("empty template creates only the manifest inside the Workspace", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Scratch",
    slug: "scratch",
    templateId: "empty",
  }, root);

  assert.equal(summary.slug, "scratch");
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(summary.path));
  assert.deepEqual(entries, [".pi"]);

  const manifest = await readWorkspaceManifest(summary.path);
  assert.equal(manifest.template.id, "empty");
  assert.deepEqual(manifest.skills, []);
  assert.equal(manifest.workItems.nextBugNumber, 1);
});

test("software-development template creates portable management structure", async (t) => {
  const root = await fixture(t);
  const summary = await createWorkspace({
    name: "Commerce",
    slug: "commerce",
    templateId: "software-development",
  }, root);

  for (const path of [
    "AGENTS.md",
    ".git",
    ".gitignore",
    "requirements",
    "bugs",
    "designs",
    "plans",
    "repositories/code",
    "repositories/knowledge",
  ]) {
    await access(join(summary.path, path));
  }
  const manifest = await readWorkspaceManifest(summary.path);
  assert.equal(manifest.template.id, "software-development");
  assert.deepEqual(manifest.skills, ["grilling", "domain-modeling", "codebase-design", "tdd"]);
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
  await createWorkspace({ name: "B", slug: "b", templateId: "empty" }, root);
  await createWorkspace({ name: "A", slug: "a", templateId: "empty" }, root);
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
  const created = await createWorkspace({ name: "Before", slug: "change", templateId: "empty" }, root);
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

test("trash moves the Workspace into the recoverable trash directory", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({ name: "Delete me", slug: "delete-me", templateId: "empty" }, root);
  const result = await trashWorkspace(created.id, root);

  await assert.rejects(access(created.path));
  await access(result.trashedPath);
  assert.match(result.trashedPath, /\.pi[/\\]trash[/\\]workspaces/);
  assert.deepEqual(await discoverWorkspaces(root), []);
});

test("initializes typed code and knowledge repositories inside a Workspace", async (t) => {
  const root = await fixture(t);
  const created = await createWorkspace({
    name: "Repositories",
    slug: "repositories",
    templateId: "software-development",
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
  await access(join(created.path, "repositories", "code", "web", "README.md"));
  await access(join(created.path, "repositories", "knowledge", "product-docs", "index.md"));

  const states = await listWorkspaceRepositories(created.id, root);
  assert.equal(states[0].branch, "main");
  assert.equal(states[0].dirty, false);
  assert.match(states[0].commit, /^[a-f0-9]{12}$/);
  assert.equal(states[0].path, "repositories/code/web");
  assert.match(await readFile(join(created.path, "AGENTS.md"), "utf8"), /`web` \(code/);
});

test("clones, disables, and restores a repository without moving its files", async (t) => {
  const root = await fixture(t);
  const remote = join(root, "remote.git");
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote]);
  const created = await createWorkspace({
    name: "Clone",
    slug: "clone",
    templateId: "empty",
  }, root);

  await addWorkspaceRepository(created.id, {
    alias: "api",
    kind: "code",
    mode: "clone",
    remote,
  }, root);
  const repository = (await readWorkspaceManifest(created.path)).repositories[0];
  const repositoryPath = join(created.path, "repositories", "code", "api");
  await access(join(repositoryPath, ".git"));

  await removeWorkspaceRepository(created.id, repository.id, root);
  assert.equal((await readWorkspaceManifest(created.path)).repositories[0].status, "removed");
  await access(repositoryPath);
  await access(remote);

  await restoreWorkspaceRepository(created.id, repository.id, root);
  assert.equal((await readWorkspaceManifest(created.path)).repositories[0].status, "active");
});
