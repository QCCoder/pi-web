import assert from "node:assert/strict";
import test from "node:test";
import {
  isSubagentChildSession,
  PI_SUBAGENT_CHILD_NAME_PREFIX,
} from "./subagent-child.ts";

// Community @henryqw/pi-subagent children persist with id `pi-subagent-<uuid>`
// and name `pi-subagent <role>` — the prefix IS the registry for new children.
test("isSubagentChildSession matches the id and name prefixes", () => {
  assert.equal(
    isSubagentChildSession({ id: "pi-subagent-9f1c", name: "pi-subagent implementer" }),
    true,
  );
  assert.equal(
    isSubagentChildSession({ id: "1753-abc", name: "pi-subagent reviewer" }),
    true,
  );
  assert.equal(isSubagentChildSession({ id: "pi-subagent-9f1c" }), true);
  assert.equal(PI_SUBAGENT_CHILD_NAME_PREFIX, "pi-subagent ");
});

// F3: generated names are exactly `pi-subagent <role>` — the trailing space
// keeps a user-named session like "pi-subagentive notes" from false-positiving.
test("name prefix requires the trailing space (no 'pi-subagentive notes' false positive)", () => {
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagentive notes" }), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagenting session" }), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagent" }), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "pi-subagent brainstorm" }), true);
});

test("isSubagentChildSession leaves ordinary sessions untagged", () => {
  assert.equal(isSubagentChildSession({ id: "1753-abc", name: "REQ-0001 修复登录" }), false);
  assert.equal(isSubagentChildSession({ id: "1753-abc" }), false);
  assert.equal(isSubagentChildSession({ id: "pi-subagent", name: undefined }), false);
});
