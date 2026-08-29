import assert from "node:assert/strict";
import { utimesSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isSubagentChildSession,
  loadLegacySubagentChildIds,
  PI_SUBAGENT_CHILD_NAME_PREFIX,
} from "./subagent-child.ts";

const EMPTY_LEGACY = new Set();

// Community @henryqw/pi-subagent children persist with id `pi-subagent-<uuid>`
// and name `pi-subagent <role>` — the prefix IS the registry for new children.
test("isSubagentChildSession matches the id and name prefixes", () => {
  assert.equal(
    isSubagentChildSession(
      { id: "pi-subagent-9f1c", name: "pi-subagent implementer" },
      EMPTY_LEGACY,
    ),
    true,
  );
  assert.equal(
    isSubagentChildSession({ id: "1753-abc", name: "pi-subagent reviewer" }, EMPTY_LEGACY),
    true,
  );
  assert.equal(isSubagentChildSession({ id: "pi-subagent-9f1c" }, EMPTY_LEGACY), true);
  assert.equal(PI_SUBAGENT_CHILD_NAME_PREFIX, "pi-subagent ");
});

// F3: generated names are exactly `pi-subagent <role>` — the trailing space
// keeps a user-named session like "pi-subagentive notes" from false-positiving.
test("name prefix requires the trailing space (no 'pi-subagentive notes' false positive)", () => {
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagentive notes" }, EMPTY_LEGACY), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagenting session" }, EMPTY_LEGACY), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagent" }, EMPTY_LEGACY), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagent brainstorm" }, EMPTY_LEGACY), true);
});

test("isSubagentChildSession leaves ordinary sessions untagged", () => {
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "REQ-0001 修复登录" }, EMPTY_LEGACY), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc" }, EMPTY_LEGACY), false);
  assert.equal(isSubagentChildSession({ id: "pi-subagent", name: undefined }, EMPTY_LEGACY), false);
});

// F1: ids recorded by the RETIRED built-in in the frozen subagent-children.txt
// registry still tag as children (prefix match OR legacy membership).
test("isSubagentChildSession also matches ids from the legacy registry", () => {
  const legacy = new Set(["3f9d2b8c-1111-2222-3333-444455556666", "old-child-2"]);
  assert.equal(
    isSubagentChildSession({ id: "3f9d2b8c-1111-2222-3333-444455556666", name: "旧实现者" }, legacy),
    true,
  );
  // The same id with no legacy set stays untagged (it carries no prefix).
  assert.equal(
    isSubagentChildSession({ id: "3f9d2b8c-1111-2222-3333-444455556666", name: "旧实现者" }, EMPTY_LEGACY),
    false,
  );
});

test("loadLegacySubagentChildIds parses a fixture registry and mtime-caches it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, "subagent-children.txt");

  // Missing file → empty set (the common case on fresh machines).
  assert.equal(loadLegacySubagentChildIds(registry).size, 0);

  await writeFile(registry, "child-aaa\n\nchild-bbb\r\n  child-ccc  \n", "utf8");
  const first = loadLegacySubagentChildIds(registry);
  assert.deepEqual([...first].sort(), ["child-aaa", "child-bbb", "child-ccc"]);

  // Same mtime → same cached Set object (no re-read).
  assert.equal(loadLegacySubagentChildIds(registry), first);

  // Appended id + forced mtime bump → re-read picks it up.
  await appendFile(registry, "child-ddd\n", "utf8");
  const bumped = new Date(Date.now() + 5000);
  utimesSync(registry, bumped, bumped);
  const second = loadLegacySubagentChildIds(registry);
  assert.notEqual(second, first);
  assert.equal(second.has("child-ddd"), true);
});
