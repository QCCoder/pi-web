import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 2026-10-26 终局（spec §9）：宪法文件退役——配置面不得再出现宪法面板/标签/草稿逻辑。
const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "LoopsConfig.tsx"), "utf8");

test("LoopsConfig 源断言：无宪法字样、删除文案为「SKILL 不动」", () => {
  assert.ok(!SOURCE.includes("宪法"));
  assert.ok(!SOURCE.includes("constitution"));
  assert.ok(!SOURCE.includes("constraints"));
  assert.ok(!SOURCE.includes("budget"));
  assert.ok(SOURCE.includes("SKILL 不动"));
});
