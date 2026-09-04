import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./grill-card.ts");
}

const VALID = [
  "问题 2/5：航线负责人能带出，部门没带出。要一并自动带出吗？",
  "```grill",
  JSON.stringify({ n: 2, total: 5, question: "要一并自动带出部门吗？", options: ["是", "否"], recommended: "是" }),
  "```",
].join("\n");

test("parses valid grill block with surrounding text", async () => {
  const { parseGrillMessage } = await loadSubject();
  const text = `先说结论：链路已定位。\n${VALID}\n详情见 ANALYSIS.md §3。`;
  const parsed = parseGrillMessage(text);
  assert.ok(parsed);
  assert.equal(parsed.grill.question, "要一并自动带出部门吗？");
  assert.equal(parsed.grill.n, 2);
  assert.equal(parsed.grill.total, 5);
  assert.deepEqual(parsed.grill.options, ["是", "否"]);
  assert.equal(parsed.grill.recommended, "是");
  assert.ok(parsed.before.startsWith("先说结论"));
  assert.ok(parsed.after.endsWith("§3。"));
});

test("defaults: missing options → [是,否]; missing deadlineMin → 2", async () => {
  const { parseGrillMessage, GRILL_TIMEOUT_MIN_DEFAULT } = await loadSubject();
  const parsed = parseGrillMessage("```grill\n" + JSON.stringify({ question: "刷存量数据吗？" }) + "\n```");
  assert.ok(parsed);
  assert.deepEqual(parsed.grill.options, ["是", "否"]);
  assert.equal(parsed.grill.deadlineMin, GRILL_TIMEOUT_MIN_DEFAULT);
});

test("returns null for plain text without grill block", async () => {
  const { parseGrillMessage } = await loadSubject();
  assert.equal(parseGrillMessage("普通消息，含 ```js 代码块``` 也不误报"), null);
  assert.equal(parseGrillMessage(""), null);
});

test("returns null for invalid JSON or missing question", async () => {
  const { parseGrillMessage } = await loadSubject();
  assert.equal(parseGrillMessage("```grill\n{not json}\n```"), null);
  assert.equal(parseGrillMessage("```grill\n" + JSON.stringify({ options: ["是"] }) + "\n```"), null);
  assert.equal(parseGrillMessage("```grill\n" + JSON.stringify({ question: "   " }) + "\n```"), null);
});

test("stage field normalized: kept when non-empty string, dropped otherwise", async () => {
  const { parseGrillMessage } = await loadSubject();
  const withStage = parseGrillMessage("```grill\n" + JSON.stringify({ stage: "方案确认", question: "推送接口换哪个？" }) + "\n```");
  assert.equal(withStage?.grill.stage, "方案确认");
  const blankStage = parseGrillMessage("```grill\n" + JSON.stringify({ stage: "   ", question: "q" }) + "\n```");
  assert.equal(blankStage?.grill.stage, undefined);
});

test("incomplete streaming block (no closing fence) → null", async () => {
  const { parseGrillMessage } = await loadSubject();
  assert.equal(parseGrillMessage("```grill\n" + JSON.stringify({ question: "在途" })), null);
});

test("grillReplyText format is stable for session-side mapping", async () => {
  const { grillReplyText } = await loadSubject();
  assert.equal(grillReplyText("要一并带出吗？", "是"), "【grill 答复】要一并带出吗？：是");
});
