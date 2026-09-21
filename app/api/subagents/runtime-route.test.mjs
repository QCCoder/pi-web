import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Flat location on purpose: a "[id]" path segment is a character class in
// the test glob (upstream ships this test flat for the same reason).
const source = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const httpSessionsSource = await readFile(new URL("../../../lib/daemon/http-sessions.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../../../lib/daemon/client.ts", import.meta.url), "utf8");

test("subagent control route proxies the daemon, never importing rpc-manager in-process", () => {
  assert.match(source, /import \{ daemonClient, DaemonHttpError \} from "@\/lib\/daemon\/client";/);
  assert.doesNotMatch(source, /from "@\/lib\/rpc-manager"/);
  assert.match(source, /daemonClient\.getSubagentRun\(id\)/);
  assert.match(source, /daemonClient\.controlSubagent\(id, "steer", body\.message\)/);
  assert.match(source, /daemonClient\.controlSubagent\(id, "abort"\)/);
});

test("subagent control route keeps the API-request guards and daemon status passthrough", () => {
  assert.match(source, /isApiRequestAllowed\(req\)/);
  assert.match(source, /hasJsonContentType\(req\)/);
  assert.match(source, /error instanceof DaemonHttpError[\s\S]*?error\.status/);
});

test("daemon side exposes the subagent control surface wired to the controller", () => {
  assert.match(httpSessionsSource, /getSubagentRun\(sid\)/);
  assert.match(httpSessionsSource, /steerSubagent\(sid, body\.message\)/);
  assert.match(httpSessionsSource, /abortSubagent\(sid\)/);
  assert.match(clientSource, /getSubagentRun: \(sessionId: string\)/);
  assert.match(clientSource, /controlSubagent: \(sessionId: string, action: "steer" \| "abort"/);
});
