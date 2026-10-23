import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeFiles = [
  "app/api/agent/new/route.ts",
  "app/api/agent/[id]/route.ts",
  "app/api/subagents/[id]/route.ts",
  "app/api/sessions/[id]/state/route.ts",
  "app/api/sessions/[id]/auto-name/route.ts",
  "app/api/sessions/[id]/locate/route.ts",
  "app/api/sessions/[id]/route.ts",
  "app/api/project-trust/route.ts",
];

test("no route imports the daemon proxy or client anymore", async () => {
  for (const file of routeFiles) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /agent-proxy|daemon\/client|daemonProxy|daemonClient/, file);
  }
});

test("agent/new keeps prompt_rejected strictly pre-acceptance", async () => {
  const src = await readFile(new URL("../../app/api/agent/new/route.ts", import.meta.url), "utf8");
  // accepted 标记必须在 createSession 之后、bookkeeping 之前翻转
  const idxCreate = src.indexOf("createSession(");
  const idxAccepted = src.indexOf("promptAccepted = promptCommand.type === \"prompt\";");
  const idxBookkeeping = src.indexOf("allowFileRoot(");
  assert.ok(idxCreate >= 0 && idxAccepted > idxCreate && idxBookkeeping > idxAccepted);
  assert.match(src, /prompt_rejected/);
});

test("session payload merge no longer depends on a daemon client", async () => {
  const src = await readFile(new URL("../../lib/session-payload.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /daemonClient|getClient/);
  assert.match(src, /liveSessions\(\)/);
  assert.match(src, /daemonDown: false/);
});
