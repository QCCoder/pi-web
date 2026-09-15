import test from "node:test";
import assert from "node:assert/strict";

test("module tab ids: constants + isModuleTabId", async () => {
  const { FILES_TAB_ID, LOOPS_TAB_ID, MODULE_TAB_IDS, isModuleTabId } = await import("./tab-types.ts");
  assert.equal(FILES_TAB_ID, "__files__");
  assert.equal(LOOPS_TAB_ID, "__loops__");
  assert.deepEqual([...MODULE_TAB_IDS], [FILES_TAB_ID, LOOPS_TAB_ID]);
  // module ids (and null → dock default 文件 handled by callers, not here)
  assert.equal(isModuleTabId(FILES_TAB_ID), true);
  assert.equal(isModuleTabId(LOOPS_TAB_ID), true);
  // file/session tab ids and empties are NOT module tabs
  assert.equal(isModuleTabId("f:/x.ts"), false);
  assert.equal(isModuleTabId(""), false);
  assert.equal(isModuleTabId(null), false);
  assert.equal(isModuleTabId(undefined), false);
});
