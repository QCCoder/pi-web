import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCron } from "./cron-summary.ts";

test("subset humanization", () => {
  assert.equal(summarizeCron("*/30 9-22 * * 1-5"), "工作日 9–22 点每 30 分钟");
  assert.equal(summarizeCron("0 8 * * 1-5"), "工作日 8:00");
  assert.equal(summarizeCron("*/5 * * * *"), "每 5 分钟");
  assert.equal(summarizeCron("15 9 * * *"), "每天 9:15");
  assert.equal(summarizeCron("*/30 9,12,18 * * *"), "9/12/18 点每 30 分钟");
  // Main preflight 裁定：分钟固定值 0 ≠ 每 60 分钟步进（语义诚实）
  assert.equal(summarizeCron("0 9-22 * * 0,6"), "周末 9–22 点每小时的 0 分");
});

test("unsupported shapes → null (UI falls back to raw cron)", () => {
  assert.equal(summarizeCron("0 0 1 * *"), null); // dom 受限
  assert.equal(summarizeCron("0 0 * 3 *"), null); // month 受限
  assert.equal(summarizeCron("5,35 * * * *"), null); // 分钟列表
  assert.equal(summarizeCron("garbage"), null);
});
