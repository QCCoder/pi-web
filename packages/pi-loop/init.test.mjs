import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { initLoop } from "./init.ts";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "kit", "templates");

test("init 脚手架：LOOP/STATE/SKILL + .lastrun 落位 + frontmatter 定制", () => {
  const root = mkdtempSync(join(tmpdir(), "init-"));
  initLoop(root, { name: "triage", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai", maxMinutes: 20 });
  assert.ok(existsSync(join(root, ".pi", "loops", "triage", "LOOP.md")));
  assert.ok(existsSync(join(root, ".pi", "loops", "triage", "STATE.md")));
  assert.ok(existsSync(join(root, ".pi", "skills", "triage", "SKILL.md")));
  assert.ok(existsSync(join(root, ".pi", "loops", "triage", ".lastrun")));
  const skill = readFileSync(join(root, ".pi", "skills", "triage", "SKILL.md"), "utf8");
  assert.ok(skill.includes("name: triage"));
  const loop = readFileSync(join(root, ".pi", "loops", "triage", "LOOP.md"), "utf8");
  const front = parse(loop.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  assert.equal(front.cron, "0 9 * * 1-5");
  assert.equal(front.max_minutes, 20);
  assert.equal(front.name, "triage");
  assert.ok(!loop.includes("{{"), "LOOP.md 正文 {{pattern}} 占位符应已替换");
});

test("init 退役面（2026-10-26 终局）：不建 .pi/loop/、不播宪法/ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "init-retire-"));
  initLoop(root, { name: "x", cron: "* * * * *" });
  // .pi/loop/ 是宿主文件目录（pause-all），kit 不创建
  assert.equal(existsSync(join(root, ".pi", "loop")), false);
  // 宪法两件与断路器账本不再属于协议
  assert.equal(existsSync(join(root, ".pi", "loop", "constraints.md")), false);
  assert.equal(existsSync(join(root, ".pi", "loop", "budget.md")), false);
  assert.equal(existsSync(join(root, ".pi", "loops", "x", "loop-ledger.json")), false);
});

test("模板集与播种一致：basic 无 root 宪法/ledger；patrol 模板带 digest 取用指令", () => {
  assert.equal(existsSync(join(TEMPLATES, "basic", "root", "constraints.md")), false);
  assert.equal(existsSync(join(TEMPLATES, "basic", "root", "budget.md")), false);
  assert.equal(existsSync(join(TEMPLATES, "basic", "loop", "loop-ledger.json")), false);
  const patrolSkill = readFileSync(join(TEMPLATES, "patrol", "SKILL.md"), "utf8");
  assert.ok(patrolSkill.includes("/attention?format=digest"));
  const patrolLoop = readFileSync(join(TEMPLATES, "patrol", "LOOP.md"), "utf8");
  const front = parse(patrolLoop.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  assert.equal(front.cron, "0 20 * * 1-5");
});

test("init 幂等保护：已存在的 SKILL.md / LOOP.md 不覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "init2-"));
  initLoop(root, { name: "x", cron: "* * * * *" });
  mkdirSync(join(root, ".pi", "skills", "x"), { recursive: true });
  writeFileSync(join(root, ".pi", "skills", "x", "SKILL.md"), "# 人工改过的 skill");
  initLoop(root, { name: "y", cron: "* * * * *" });
  assert.equal(readFileSync(join(root, ".pi", "skills", "x", "SKILL.md"), "utf8"), "# 人工改过的 skill");
  // x/y pattern 不同（各缺省取 name）：y 得到自己的骨架，x 的既有内容存活
  assert.ok(readFileSync(join(root, ".pi", "skills", "y", "SKILL.md"), "utf8").includes("name: y"));
  // LOOP.md 同幂等规则：已存在则整体跳过（含 frontmatter 定制）— 不得清写正文
  const customLoop = "---\ncron: \"0 3 * * *\"\n---\n# 人工改过的 loop";
  mkdirSync(join(root, ".pi", "loops", "x"), { recursive: true });
  writeFileSync(join(root, ".pi", "loops", "x", "LOOP.md"), customLoop);
  initLoop(root, { name: "x", cron: "* * * * *" });
  assert.equal(readFileSync(join(root, ".pi", "loops", "x", "LOOP.md"), "utf8"), customLoop);
});
