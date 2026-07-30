import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-index.ts");
}

test("isIgnoredPath flags any segment in the ignore set or ignored suffixes", async () => {
  const { isIgnoredPath } = await loadSubject();

  assert.equal(isIgnoredPath("src/app.ts"), false);
  assert.equal(isIgnoredPath("packages/lib/src/index.ts"), false);
  assert.equal(isIgnoredPath("node_modules/react/index.js"), true);
  assert.equal(isIgnoredPath("src/node_modules/x.ts"), true); // segment anywhere
  assert.equal(isIgnoredPath("dist/bundle.js"), true);
  assert.equal(isIgnoredPath("app/.git/config"), true);
  assert.equal(isIgnoredPath("legacy/app.pyc"), true); // ignored suffix
  assert.equal(isIgnoredPath(""), false); // not ignored — mergeFileLists drops empties
});

test("repoPrefix yields the relative path from cwd to a nested repo root", async () => {
  const { repoPrefix } = await loadSubject();

  assert.equal(repoPrefix("/proj", "/proj"), "");
  assert.equal(repoPrefix("/proj", "/proj/lib"), "lib");
  assert.equal(repoPrefix("/proj", "/proj/packages/core"), "packages/core");
  // trailing slash on cwd is tolerated
  assert.equal(repoPrefix("/proj/", "/proj/lib"), "lib");
  // a root outside cwd has no usable prefix
  assert.equal(repoPrefix("/proj", "/other"), "");
});

test("mergeFileLists dedupes, post-filters ignored paths, and keeps first-seen order", async () => {
  const { mergeFileLists } = await loadSubject();

  const scattered = ["README.md", "notes.txt"];
  const outerGit = ["top.txt", "lib", "node_modules/accidentally-committed.js"];
  const nestedGit = ["lib/nested.txt", "lib/debug.log", "lib/top.txt"]; // lib/top.txt dup of outer? no, different path

  const merged = mergeFileLists([scattered, outerGit, nestedGit]);

  assert.deepEqual(merged, [
    "README.md",
    "notes.txt",
    "top.txt",
    "lib",
    "lib/nested.txt",
    "lib/debug.log",
    "lib/top.txt",
  ]);
});

test("mergeFileLists drops empties and duplicates across repos", async () => {
  const { mergeFileLists } = await loadSubject();

  const merged = mergeFileLists([
    ["", "a.txt", "a.txt"],
    ["a.txt", "b.txt"],
    ["b.txt"],
  ]);

  assert.deepEqual(merged, ["a.txt", "b.txt"]);
});

test("MAX_REPO_ROOTS is a sane backstop value", async () => {
  const { MAX_REPO_ROOTS } = await loadSubject();
  assert.equal(typeof MAX_REPO_ROOTS, "number");
  assert.ok(MAX_REPO_ROOTS >= 64 && MAX_REPO_ROOTS <= 1024);
});
