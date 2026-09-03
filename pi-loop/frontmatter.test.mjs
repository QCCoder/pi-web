import test from "node:test";
import assert from "node:assert/strict";
import { applyLoopFrontmatterPatch, LoopFrontmatterError, splitLoopFile } from "./frontmatter.ts";
import { parseLoopDeclaration } from "./protocol.ts";

const RAW = [
  "---",
  "name: dev-loop",
  "pattern: dev-loop",
  "level: L2",
  "cron: \"*/30 9-22 * * 1-5\"",
  "timezone: Asia/Shanghai",
  "max_minutes: 45",
  "---",
  "",
  "# 合同正文",
  "",
  "正文第一行保留原样（含尾部空格）   ",
  "第二行。",
].join("\n");

test("applyLoopFrontmatterPatch rewrites frontmatter and preserves body bytes", () => {
  const next = applyLoopFrontmatterPatch(RAW, { cron: "0 8-18 * * 1-5", max_minutes: 60 });
  const declaration = parseLoopDeclaration(next, "/ws/loops/dev-loop", "/ws");
  assert.equal(declaration.cron, "0 8-18 * * 1-5");
  assert.equal(declaration.maxMinutes, 60);
  assert.equal(declaration.level, "L2");            // 未动的字段保留
  assert.equal(declaration.timezone, "Asia/Shanghai");
  assert.equal(declaration.loopName, "dev-loop");
  // 正文 byte 保留：applyLoopDeclaration 的 body 是 trim 过的——这里直接断言尾部
  assert.ok(next.includes("正文第一行保留原样（含尾部空格）   \n第二行。"));
  // name/pattern 未丢失（round-trip 保真）
  assert.match(next, /name: dev-loop/);
});

test("applyLoopFrontmatterPatch updates timezone and level", () => {
  const next = applyLoopFrontmatterPatch(RAW, { timezone: "UTC", level: "L1" });
  const declaration = parseLoopDeclaration(next, "/ws/loops/dev-loop", "/ws");
  assert.equal(declaration.timezone, "UTC");
  assert.equal(declaration.level, "L1");
});

test("applyLoopFrontmatterPatch rejects invalid values", () => {
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { cron: "garbage" }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { timezone: "Asia/Shanghao" }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { level: "L9" }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { max_minutes: 0 }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { max_minutes: 1.5 }), LoopFrontmatterError);
});

test("applyLoopFrontmatterPatch throws on input without frontmatter", () => {
  assert.throws(() => applyLoopFrontmatterPatch("no frontmatter here", { cron: "* * * * *" }), LoopFrontmatterError);
});

test("splitLoopFile 拆出 frontmatter 与正文（字节保真）", () => {
  const raw = '---\nname: dev-loop\ncron: "*/30 * * * *"\n---\n# 指针\n\n1. 步骤\n';
  const parts = splitLoopFile(raw);
  assert.ok(parts);
  assert.equal(parts.front, '---\nname: dev-loop\ncron: "*/30 * * * *"\n---\n');
  assert.equal(parts.body, "# 指针\n\n1. 步骤\n");
  assert.equal(parts.front + parts.body, raw);
});

test("splitLoopFile 无 frontmatter 返回 null", () => {
  assert.equal(splitLoopFile("# 只有正文\n"), null);
});

test("splitLoopFile 空 frontmatter 块", () => {
  const parts = splitLoopFile("---\n---\nbody");
  assert.ok(parts);
  assert.equal(parts.front, "---\n---\n");
  assert.equal(parts.body, "body");
});
