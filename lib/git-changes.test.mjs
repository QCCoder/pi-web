import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSubject() {
  return import("./git-status.ts");
}

// git-changes.ts imports "@/lib/file-dirent" (via git-discover), so loading the
// full module needs jiti's alias resolution mapped to the project root; fall
// back to a direct import when jiti is unavailable.
async function loadChanges() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { alias: { "@": projectRoot } }).import("./git-changes.ts");
  } catch {
    return import("./git-changes.ts");
  }
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

function porcelainEntry(path, indexStatus, worktreeStatus) {
  return { path, indexStatus, worktreeStatus };
}

test("buildRepoGroups scopes the primary repo's changes to cwd", async () => {
  const { buildRepoGroups } = await loadSubject();
  // cwd is a subdirectory of the repo root; only changes under cwd appear.
  const cwd = "/proj/src";
  const primary = "/proj";
  const repos = [{
    root: primary,
    isPrimary: true,
    scopeCwd: cwd,
    entries: [
      porcelainEntry("src/a.ts", " ", "M"),  // /proj/src/a.ts — in cwd
      porcelainEntry("README.md", " ", "M"), // /proj/README.md — outside cwd
    ],
    trackedAdditions: 5,
    trackedDeletions: 2,
  }];
  const groups = buildRepoGroups(cwd, primary, repos, new Set([primary]));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].repositoryRoot, primary);
  assert.deepEqual(groups[0].files.map((f) => f.filePath), ["/proj/src/a.ts"]);
  assert.equal(groups[0].additions, 5);
  assert.equal(groups[0].deletions, 2);
});

test("buildRepoGroups drops nested-repo boundary entries and groups nested changes (D1)", async () => {
  const { buildRepoGroups } = await loadSubject();
  const cwd = "/proj";
  const primary = "/proj";
  const nested = "/proj/lib/sub";
  const allRoots = new Set([primary, nested]);
  const repos = [
    {
      root: primary,
      isPrimary: true,
      scopeCwd: cwd,
      entries: [
        porcelainEntry("src/a.ts", " ", "M"), // real change — keep
        porcelainEntry("lib/sub", "M", " "),   // submodule gitlink boundary — drop
      ],
      trackedAdditions: 3,
      trackedDeletions: 1,
    },
    {
      root: nested,
      isPrimary: false,
      scopeCwd: nested,
      entries: [porcelainEntry("foo.ts", " ", "M")], // /proj/lib/sub/foo.ts — keep
      trackedAdditions: 7,
      trackedDeletions: 0,
    },
  ];
  const groups = buildRepoGroups(cwd, primary, repos, allRoots);

  assert.equal(groups.length, 2);
  // primary first, boundary entry dropped
  assert.equal(groups[0].repositoryRoot, primary);
  assert.deepEqual(groups[0].files.map((f) => f.filePath), ["/proj/src/a.ts"]);
  assert.equal(groups[0].additions, 3);
  // nested second, only its own real change
  assert.equal(groups[1].repositoryRoot, nested);
  assert.deepEqual(groups[1].files.map((f) => f.filePath), ["/proj/lib/sub/foo.ts"]);
  assert.equal(groups[1].additions, 7);
});

test("buildRepoGroups orders primary first then nested alphabetically", async () => {
  const { buildRepoGroups } = await loadSubject();
  // cwd is not itself a repo; multiple peer repos underneath.
  const cwd = "/work";
  const primary = null;
  const zRoot = "/work/z-repo";
  const aRoot = "/work/a-repo";
  const allRoots = new Set([aRoot, zRoot]);
  const repos = [
    { root: zRoot, isPrimary: false, scopeCwd: zRoot, entries: [porcelainEntry("f.ts", " ", "M")], trackedAdditions: 0, trackedDeletions: 0 },
    { root: aRoot, isPrimary: false, scopeCwd: aRoot, entries: [porcelainEntry("f.ts", " ", "M")], trackedAdditions: 0, trackedDeletions: 0 },
  ];
  const groups = buildRepoGroups(cwd, primary, repos, allRoots);

  assert.deepEqual(groups.map((g) => g.repositoryRoot), [aRoot, zRoot]);
});

test("buildRepoGroups skips repositories with no in-scope changes", async () => {
  const { buildRepoGroups } = await loadSubject();
  const cwd = "/proj";
  const primary = "/proj";
  const repos = [{
    root: primary,
    isPrimary: true,
    scopeCwd: cwd,
    entries: [],
    trackedAdditions: 0,
    trackedDeletions: 0,
  }];
  const groups = buildRepoGroups(cwd, primary, repos, new Set([primary]));

  assert.deepEqual(groups, []);
});

// --- Linked-worktree integration tests (real git) -------------------------
// Regression for the Changes view bug where linked git worktrees
// (<repo>/worktrees/<name>) were discovered as separate repo roots: each
// worktree was queried on its own and its branch-vs-HEAD diff became the sole
// surviving group, while parent repos' real changes were swallowed because the
// worktree boundary entries were dropped by the nested-root dedup.

function gitExec(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function initRepo(repoDir) {
  execFileSync("git", ["init", "-q", repoDir], { stdio: ["ignore", "ignore", "ignore"] });
  gitExec(repoDir, ["config", "user.email", "test@example.com"]);
  gitExec(repoDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
  gitExec(repoDir, ["add", "."]);
  gitExec(repoDir, ["commit", "-qm", "base"]);
}

function addWorktree(main, name) {
  const wt = path.join(main, "worktrees", name);
  gitExec(main, ["worktree", "add", "-b", name, wt]);
  return wt;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function allGroupFiles(groups) {
  return groups.flatMap((g) => g.files.map((f) => f.filePath));
}

test("getGitStatus excludes linked worktree groups and keeps the parent repo's real changes", async () => {
  const { getGitStatus } = await loadChanges();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-changes-wt-"));
  try {
    const main = path.join(tmp, "main");
    initRepo(main);
    const wt = addWorktree(main, "feature");
    // Real change in the parent repo.
    fs.writeFileSync(path.join(main, "main-change.txt"), "main\n");
    // Change inside the worktree (parallel checkout — must NOT appear).
    fs.writeFileSync(path.join(wt, "wt-change.txt"), "wt\n");

    const st = await getGitStatus(tmp);

    // (a) the worktree is never reported as its own group.
    const groupRoots = st.groups.map((g) => g.repositoryRoot);
    assert.ok(!groupRoots.includes(wt), `worktree must not be a group root, got: ${JSON.stringify(groupRoots)}`);

    // (b) the parent repo's real change is preserved as a group.
    const mainGroup = st.groups.find((g) => g.repositoryRoot === main);
    assert.ok(mainGroup, "parent repo must appear as a group");
    assert.ok(
      mainGroup.files.some((f) => f.filePath === path.join(main, "main-change.txt")),
      "parent repo's real change must be listed",
    );

    // (c) the parent repo's group does not include the worktree boundary entry.
    assert.ok(
      !mainGroup.files.some((f) => f.filePath === wt),
      "worktree boundary entry must be dropped from the parent group",
    );

    // (d) the worktree's file never shows up anywhere.
    const wtFile = path.join(wt, "wt-change.txt");
    assert.ok(
      !allGroupFiles(st.groups).includes(wtFile),
      "worktree file must not leak into any group",
    );
  } finally {
    rmrf(tmp);
  }
});

test("getGitStatus groups multiple main repos, never their worktrees", async () => {
  const { getGitStatus } = await loadChanges();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-changes-multi-"));
  try {
    const mainA = path.join(tmp, "repo-a");
    const mainB = path.join(tmp, "repo-b");
    initRepo(mainA);
    initRepo(mainB);
    const wtA = addWorktree(mainA, "x");
    const wtB = addWorktree(mainB, "y");
    // Real changes in each parent repo.
    fs.writeFileSync(path.join(mainA, "a-change.txt"), "a\n");
    fs.writeFileSync(path.join(mainB, "b-change.txt"), "b\n");
    // Noise inside each worktree.
    fs.writeFileSync(path.join(wtA, "noise.txt"), "a\n");
    fs.writeFileSync(path.join(wtB, "noise.txt"), "b\n");

    const st = await getGitStatus(tmp);
    const groupRoots = st.groups.map((g) => g.repositoryRoot).sort();

    assert.deepEqual(groupRoots, [mainA, mainB].sort(), "exactly the two main repos");
    assert.ok(!groupRoots.includes(wtA) && !groupRoots.includes(wtB), "no worktree groups");
    // Each main repo keeps its own real change and no worktree boundary.
    const files = allGroupFiles(st.groups);
    assert.ok(files.includes(path.join(mainA, "a-change.txt")));
    assert.ok(files.includes(path.join(mainB, "b-change.txt")));
    assert.ok(!files.includes(wtA) && !files.includes(wtB));
  } finally {
    rmrf(tmp);
  }
});

test("getGitStatus yields no group when a parent repo only has worktree boundary noise", async () => {
  // This is the real workspace-c shape: a repo whose only "changes" are
  // untracked worktree/ dirs. Before the fix, the worktree became the sole
  // group; now the parent is empty (and skipped) and the worktree is excluded.
  const { getGitStatus } = await loadChanges();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-changes-noise-"));
  try {
    const main = path.join(tmp, "main");
    initRepo(main);
    const wt = addWorktree(main, "feature");
    // No real change in main — only the worktree existence produces boundary
    // noise. Put a change only in the worktree.
    fs.writeFileSync(path.join(wt, "wt-change.txt"), "wt\n");

    const st = await getGitStatus(tmp);

    assert.equal(st.groups.length, 0, "no group for pure worktree boundary noise");
    assert.equal(st.additions, 0);
    assert.equal(st.deletions, 0);
  } finally {
    rmrf(tmp);
  }
});
