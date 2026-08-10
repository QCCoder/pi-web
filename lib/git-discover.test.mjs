import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSubject() {
  // git-discover.ts imports "@/lib/file-dirent"; map the "@" alias to the
  // absolute project root so jiti can resolve it. Fall back to a direct import
  // when jiti is unavailable.
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { alias: { "@": projectRoot } }).import("./git-discover.ts");
  } catch {
    return import("./git-discover.ts");
  }
}

function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
}

/** Create a fresh repo (with a base commit so worktrees can be added). */
function initRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir], { stdio: ["ignore", "ignore", "ignore"] });
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-qm", "base"]);
}

/** Add a linked worktree at <main>/worktrees/<name> on a new branch. */
function addWorktree(main, name) {
  const wt = path.join(main, "worktrees", name);
  git(main, ["worktree", "add", "-b", name, wt]);
  return wt;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("discoverRepoAndWorktreeRoots separates linked worktrees from main repos", async () => {
  const { discoverRepoAndWorktreeRoots } = await loadSubject();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-disc-wt-"));
  try {
    const main = path.join(tmp, "main");
    initRepo(main);
    const wt = addWorktree(main, "feature");

    const { repoRoots, worktreeRoots } = discoverRepoAndWorktreeRoots(tmp);

    assert.deepEqual(repoRoots, [main]);
    assert.deepEqual(worktreeRoots, [wt]);
  } finally {
    rmrf(tmp);
  }
});

test("discoverRepoAndWorktreeRoots groups multiple main repos with their own worktrees", async () => {
  const { discoverRepoAndWorktreeRoots } = await loadSubject();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-disc-multi-"));
  try {
    const mainA = path.join(tmp, "repo-a");
    const mainB = path.join(tmp, "repo-b");
    initRepo(mainA);
    initRepo(mainB);
    const wtA = addWorktree(mainA, "x");
    const wtB = addWorktree(mainB, "y");

    const { repoRoots, worktreeRoots } = discoverRepoAndWorktreeRoots(tmp);

    assert.deepEqual(repoRoots.sort(), [mainA, mainB].sort());
    assert.deepEqual(worktreeRoots.sort(), [wtA, wtB].sort());
  } finally {
    rmrf(tmp);
  }
});

test("discoverRepoRoots still treats worktrees as repo roots (file-index behavior preserved)", async () => {
  const { discoverRepoRoots, discoverReposAndScattered } = await loadSubject();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-disc-legacy-"));
  try {
    const main = path.join(tmp, "main");
    initRepo(main);
    const wt = addWorktree(main, "feature");
    // drop a file in the worktree so scattered/file-index would see it
    fs.writeFileSync(path.join(wt, "in-wt.txt"), "x\n");

    // Existing call sites (file-index) use skipWorktrees:false semantics:
    // the worktree stays a normal repo root and is descended into.
    const roots = discoverRepoRoots(tmp);
    assert.ok(roots.includes(main), "main repo present");
    assert.ok(roots.includes(wt), "worktree still a repo root (legacy behavior)");

    const { repoRoots, worktreeRoots, scatteredFiles } = discoverReposAndScattered(tmp);
    assert.ok(repoRoots.includes(wt), "discoverReposAndScattered still lists worktree as repo root");
    // worktreeRoots is populated but legacy callers may ignore it.
    assert.deepEqual(worktreeRoots, [wt]);
    assert.deepEqual(scatteredFiles, []);
  } finally {
    rmrf(tmp);
  }
});

test("a submodule gitlink (.git file not pointing at worktrees) stays a normal repo root", async () => {
  const { discoverRepoAndWorktreeRoots } = await loadSubject();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-disc-submod-"));
  try {
    const main = path.join(tmp, "main");
    initRepo(main);
    // Fabricate a submodule-like .git gitlink that points at .git/modules/...
    // (NOT .git/worktrees/...). It must be treated as a normal nested repo.
    // (Placed under a non-ignored dir; `vendor`/`node_modules` are pruned.)
    const sub = path.join(main, "deps", "submod");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/deps-submod\n");
    fs.writeFileSync(path.join(sub, "file.txt"), "x\n");

    const { repoRoots, worktreeRoots } = discoverRepoAndWorktreeRoots(tmp);

    assert.deepEqual(repoRoots, [main, sub]);
    assert.deepEqual(worktreeRoots, []);
  } finally {
    rmrf(tmp);
  }
});
