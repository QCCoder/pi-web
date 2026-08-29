import assert from "node:assert/strict";
import test from "node:test";
import { isSubagentChildSession } from "./subagent-child.ts";

// Community @henryqw/pi-subagent children persist with id `pi-subagent-<uuid>`
// and name `pi-subagent <role>` — the prefix replaces the old append-only
// subagent-children.txt registry.
test("isSubagentChildSession matches the id and name prefixes", () => {
  assert.equal(isSubagentChildSession({ id: "pi-subagent-9f1c", name: "pi-subagent implementer" }), true);
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagent reviewer" }), true);
  assert.equal(isSubagentChildSession({ id: "pi-subagent-9f1c" }), true);
});

test("isSubagentChildSession leaves ordinary sessions untagged", () => {
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "REQ-0001 修复登录" }), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc" }), false);
  assert.equal(isSubagentChildSession({ id: "pi-subagent", name: undefined }), false);
});
