import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { initLoop } from "./init.ts";

test("init 脚手架：五件套落位（ledger 在 loop 目录）+ frontmatter 定制 + .lastrun=now", () => {
  const root = mkdtempSync(join(tmpdir(), "init-"));
  initLoop(root, { name: "triage", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai", maxMinutes: 20 });
  assert.ok(existsSync(join(root, "loops", "triage", "LOOP.md")));
  assert.ok(existsSync(join(root, "loops", "triage", "STATE.md")));
  assert.ok(existsSync(join(root, "loops", "triage", "loop-ledger.json")));
  assert.ok(existsSync(join(root, "loop-constraints.md")));
  assert.ok(existsSync(join(root, "loop-budget.md")));
  assert.ok(existsSync(join(root, ".agents", "skills", "triage", "SKILL.md")));
  assert.ok(existsSync(join(root, "loops", "triage", ".lastrun")));
  const skill = readFileSync(join(root, ".agents", "skills", "triage", "SKILL.md"), "utf8");
  assert.ok(skill.includes("name: triage"));
  const loop = readFileSync(join(root, "loops", "triage", "LOOP.md"), "utf8");
  const front = parse(loop.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  assert.equal(front.cron, "0 9 * * 1-5");
  assert.equal(front.max_minutes, 20);
  assert.equal(front.name, "triage");
  assert.ok(!loop.includes("{{"), "LOOP.md 正文 {{pattern}} 占位符应已替换");
});

test("init 幂等保护：已存在的 root 宪法文件与 SKILL.md 不覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "init2-"));
  initLoop(root, { name: "x", cron: "* * * * *" });
  writeFileSync(join(root, "loop-budget.md"), "# 人工改过");
  writeFileSync(join(root, ".agents", "skills", "x", "SKILL.md"), "# 人工改过的 skill");
  initLoop(root, { name: "y", cron: "* * * * *" });
  assert.equal(readFileSync(join(root, "loop-budget.md"), "utf8"), "# 人工改过");
  assert.equal(readFileSync(join(root, ".agents", "skills", "x", "SKILL.md"), "utf8"), "# 人工改过的 skill");
  // x/y pattern 不同（各缺省取 name）：y 得到自己的骨架，x 的既有内容存活
  assert.ok(readFileSync(join(root, ".agents", "skills", "y", "SKILL.md"), "utf8").includes("name: y"));
  // LOOP.md 同幂等规则：已存在则整体跳过（含 frontmatter 定制）— 不得清写
  const customLoop = "---\ncron: \"0 3 * * *\"\n---\n# 人工改过的 loop";
  writeFileSync(join(root, "loops", "x", "LOOP.md"), customLoop);
  initLoop(root, { name: "x", cron: "* * * * *" });
  assert.equal(readFileSync(join(root, "loops", "x", "LOOP.md"), "utf8"), customLoop);
});
