import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./git-status.ts");
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

async function loadChanges() {
  return import("./git-status.ts");
}

function porcelainEntry(path, indexStatus, worktreeStatus) {
  return { path, indexStatus, worktreeStatus };
}

test("buildRepoGroups scopes the primary repo's changes to cwd", async () => {
  const { buildRepoGroups } = await loadChanges();
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
  const { buildRepoGroups } = await loadChanges();
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
  const { buildRepoGroups } = await loadChanges();
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
  const { buildRepoGroups } = await loadChanges();
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
