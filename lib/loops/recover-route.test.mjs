import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recover route refuses when surviving processes exist, even with manual flag", async () => {
  const src = await readFile(new URL("../../app/api/workspaces/[id]/loops/[name]/recover/route.ts", import.meta.url), "utf8");
  assert.match(src, /pids\.length > 0/);
  assert.match(src, /409/);
  assert.match(src, /recovered-manual/);
  assert.match(src, /recovered-auto/);
});

test("loops GET merges pending interruptions", async () => {
  const src = await readFile(new URL("../../app/api/workspaces/[id]/loops/route.ts", import.meta.url), "utf8");
  assert.match(src, /listPendingExecutionRecords/);
  assert.match(src, /interruptions/);
});
