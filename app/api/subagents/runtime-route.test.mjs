import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Flat location on purpose: a "[id]" path segment is a character class in
// the test glob (upstream ships this test flat for the same reason).
const source = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");

test("subagent control route goes through the host facade, never the registry directly", () => {
  assert.match(source, /import \{ controlSubagent, getSubagentRunStatus, SessionHostError \} from "@\/lib\/session-host\/facade";/);
  assert.doesNotMatch(source, /from "@\/lib\/session-host\/registry"/);
  assert.match(source, /getSubagentRunStatus\(id\)/);
  assert.match(source, /controlSubagent\(id, "steer", body\.message\)/);
  assert.match(source, /controlSubagent\(id, "abort"\)/);
});

test("subagent control route keeps the API-request guards and host status passthrough", () => {
  assert.match(source, /isApiRequestAllowed\(req\)/);
  assert.match(source, /hasJsonContentType\(req\)/);
  assert.match(source, /error instanceof SessionHostError[\s\S]*?error\.status/);
});

test("subagent control route keeps the controller-rejection 409 mapping", () => {
  // Rebuilt from the old daemon route (lib/daemon/http-sessions.ts, retired
  // with the single-process host): a controller rejection whose message
  // includes "not running" → 409, any other controller failure → 500.
  assert.match(source, /message\.includes\("not running"\) \? 409 : 500/);
  assert.match(source, /"action must be steer or abort"/);
  assert.match(source, /typeof body\.message !== "string" \|\| !body\.message\.trim\(\)/);
});
