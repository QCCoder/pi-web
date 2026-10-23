import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("web host round teardown never reaps by workspace cwd", async () => {
  for (const file of [
    "app/api/workspaces/[id]/loops/[name]/stop/route.ts",
  ]) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /reapOrphanedRoundProcesses|reapOrphansByCwd/, file);
  }
  // spawner 的位置会随 Task 6 迁移（lib/daemon → lib/session-host），两处都查：
  for (const file of ["lib/daemon/loop-spawner.ts", "lib/session-host/loop-spawner.ts"]) {
    try {
      const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /reapOrphanedRoundProcesses|reapOrphansByCwd/, file);
    } catch { /* 尚未迁移/已迁移 — 另一处覆盖 */ }
  }
});
