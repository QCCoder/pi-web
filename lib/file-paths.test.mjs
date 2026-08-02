import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-paths.ts");
}

test("abbreviateFilePathParts leaves short paths unchanged", async () => {
  const { abbreviateFilePathParts } = await loadSubject();

  assert.deepEqual(abbreviateFilePathParts("app/api/route.ts", 48), {
    dir: "app/api/",
    name: "route.ts",
  });
  assert.deepEqual(abbreviateFilePathParts("README.md", 48), { dir: "", name: "README.md" });
  // exactly at budget: 9 chars, maxLen 9 -> stays intact
  assert.deepEqual(abbreviateFilePathParts("a/b/c.txt", 9), { dir: "a/b/", name: "c.txt" });
});

test("abbreviateFilePathParts keeps first segment + basename, drops middle", async () => {
  const { abbreviateFilePathParts } = await loadSubject();

  const { dir, name } = abbreviateFilePathParts(
    "packages/frontend/src/components/chat/MessageView.tsx",
    26,
  );
  // name kept in full; only "packages/…/" fits the remaining budget
  assert.equal(name, "MessageView.tsx");
  assert.equal(dir, "packages/…/");
});

test("abbreviateFilePathParts fills trailing segments when budget allows", async () => {
  const { abbreviateFilePathParts } = await loadSubject();

  // budget 34: name(15) leaves 19 -> "packages/…/chat/" (16) fits, adding "components" would overflow
  const r = abbreviateFilePathParts(
    "packages/frontend/src/components/chat/MessageView.tsx",
    34,
  );
  assert.equal(r.name, "MessageView.tsx");
  assert.equal(r.dir, "packages/…/chat/");
});

test("abbreviateFilePathParts keeps first + last dir when both fit", async () => {
  const { abbreviateFilePathParts } = await loadSubject();

  // tests/unit/config.json vs tests/integration/config.json: keep root + immediate parent
  const r = abbreviateFilePathParts("tests/deep/nested/unit/config.json", 28);
  assert.equal(r.name, "config.json");
  assert.equal(r.dir, "tests/…/unit/");
});

test("abbreviateFilePathParts never shortens the basename below budget", async () => {
  const { abbreviateFilePathParts } = await loadSubject();

  // basename longer than budget -> truncate name with ellipsis, empty dir
  const r = abbreviateFilePathParts("dir/AVeryLongFileNameThatExceedsBudget.tsx", 20);
  assert.equal(r.dir, "");
  assert.ok(r.name.endsWith("…"));
  assert.ok(r.name.length <= 20);
});

test("abbreviateFilePathParts falls back to bare ellipsis when head won't fit", async () => {
  const { abbreviateFilePathParts } = await loadSubject();

  // tiny budget: keep name, prefix degrades to "…/"
  const r = abbreviateFilePathParts("verylongroot/short.txt", 12);
  assert.equal(r.name, "short.txt");
  // "verylongroot/…/" (15) > budget(3) -> "…/" (2) fits
  assert.equal(r.dir, "…/");
});

test("abbreviateFilePathParts uses the default budget of 48 when omitted", async () => {
  const { abbreviateFilePathParts, DEFAULT_PATH_ABBREV_MAX } = await loadSubject();
  assert.equal(DEFAULT_PATH_ABBREV_MAX, 48);

  // a path under 48 chars is returned intact
  const intact = abbreviateFilePathParts("packages/core/src/index.ts");
  assert.equal(intact.dir, "packages/core/src/");
  assert.equal(intact.name, "index.ts");

  // a path over 48 chars is abbreviated
  const long = abbreviateFilePathParts(
    "packages/frontend/src/components/deeply/nested/MessageView.tsx",
  );
  assert.ok((long.dir + long.name).length <= DEFAULT_PATH_ABBREV_MAX + 4); // within rounding of …
  assert.equal(long.name, "MessageView.tsx");
});
