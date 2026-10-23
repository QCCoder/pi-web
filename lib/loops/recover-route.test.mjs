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

test("manual run route gates on pending interruptions before launching (409 + recovery pointer)", async () => {
  const src = await readFile(new URL("../../app/api/workspaces/[id]/loops/[name]/run/route.ts", import.meta.url), "utf8");
  // 恢复门禁（spec §5.4）同样管手动起轮：未确认中断记录在场 → 409，
  // 指引用户去 Loops 面板的「重新检查并恢复」，不得绕过门禁直接起轮。
  const gatePos = src.indexOf("await listPendingExecutionRecords");
  assert.notEqual(gatePos, -1, "run route must consult listPendingExecutionRecords");
  assert.match(src, /pending\.length > 0/);
  assert.match(src, /重新检查并恢复/);
  const launchPos = src.indexOf("launchManualRound(");
  assert.ok(launchPos !== -1, "run route must launch manual rounds");
  assert.ok(gatePos < launchPos, "the interruption gate must run BEFORE launchManualRound");
});
