import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-fuzzy.ts");
}

test("builds closed file mentions and quotes paths containing spaces", async () => {
  const { buildAtMentionText, buildFileAtMentionsText } = await loadSubject();

  assert.equal(buildAtMentionText("notes/todo.md", false), "@notes/todo.md ");
  assert.equal(buildAtMentionText("project files/design brief.md", false), "@\"project files/design brief.md\" ");
  assert.equal(
    buildFileAtMentionsText(["notes/todo.md", "project files/design brief.md"]),
    "@notes/todo.md @\"project files/design brief.md\" ",
  );
});

test("builds line-scoped file mentions", async () => {
  const { buildFileLineMentionText } = await loadSubject();

  assert.equal(buildFileLineMentionText("src/app.ts", 12, 12), "@src/app.ts:12 ");
  assert.equal(buildFileLineMentionText("src/app.ts", 18, 12), "@src/app.ts:12-18 ");
  assert.equal(
    buildFileLineMentionText("project files/app.ts", 3, 9),
    "@\"project files/app.ts\":3-9 ",
  );
  assert.equal(buildFileLineMentionText("src/app.ts", 0, 0), "@src/app.ts:1 ");
});

test("ranks hits by filename relevance: exact, prefix, name substring, path substring", async () => {
  const { buildEntriesFromFiles, filterFileEntries } = await loadSubject();
  const entries = buildEntriesFromFiles([
    "xalpha.ts",
    "alpha.ts",
    "alpha",
    "notes/alpha-notes/q.md",
    "unrelated.txt",
  ]);

  const paths = filterFileEntries(entries, "alpha").map((entry) => entry.path);

  // strict score ladder: exact name (100) > prefix (80, +10 for the derived
  // "alpha-notes" directory) > name substring (50) > path substring (30).
  assert.deepEqual(paths, [
    "alpha",
    "notes/alpha-notes",
    "alpha.ts",
    "xalpha.ts",
    "notes/alpha-notes/q.md",
  ]);

  // The explorer search renders files only, dropping derived directory rows.
  const filePaths = filterFileEntries(entries, "alpha")
    .filter((entry) => !entry.isDir)
    .map((entry) => entry.path);
  assert.deepEqual(filePaths, ["alpha", "alpha.ts", "xalpha.ts", "notes/alpha-notes/q.md"]);
});

test("caps results at the requested limit so output stays bounded", async () => {
  const { buildEntriesFromFiles, filterFileEntries, AT_RESULT_LIMIT } = await loadSubject();
  const files = Array.from({ length: 500 }, (_, i) => `src/module-${i}.ts`);
  const entries = buildEntriesFromFiles(files);

  const hits = filterFileEntries(entries, "module-");
  assert.equal(hits.length, AT_RESULT_LIMIT, "default limit applies");
  assert.equal(filterFileEntries(entries, "module-", 7).length, 7, "explicit limit applies");
  // Every capped hit is still a genuine match, best-ranked first.
  for (const entry of hits) assert.ok(entry.path.includes("module-"));
});

test("an empty query just truncates the index instead of ranking it", async () => {
  const { buildEntriesFromFiles, filterFileEntries } = await loadSubject();
  const entries = buildEntriesFromFiles(["b.ts", "a/x.ts", "a.ts"]);

  // Base order: shallow-first then alphabetical, directory entries included.
  assert.deepEqual(
    filterFileEntries(entries, "").map((entry) => entry.path),
    ["a", "a.ts", "b.ts", "a/x.ts"],
  );
  assert.deepEqual(
    filterFileEntries(entries, "", 1).map((entry) => entry.path),
    ["a"],
  );
});
