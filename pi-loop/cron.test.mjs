import test from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, cronMatches, nextDue } from "./cron.ts";

const shanghaiMonday15 = new Date("2024-01-15T07:05:00.000Z"); // 15:05 Asia/Shanghai, 周一

test("every minute", () => {
  assert.equal(cronMatches("* * * * *", "Asia/Shanghai", shanghaiMonday15), true);
});

test("hour and weekday match", () => {
  assert.equal(cronMatches("5 15 * * 1", "Asia/Shanghai", shanghaiMonday15), true);
});

test("weekday mismatch", () => {
  assert.equal(cronMatches("5 15 * * 2", "Asia/Shanghai", shanghaiMonday15), false);
});

test("range and step", () => {
  // NOTE (task-2 deviation): brief said "1-30/5" → true, but the verbatim-moved
  // implementation is Vixie start-anchored stepping (1,6,11,… for /5) — minute 5
  // is not in that set. "1-30/4" gives 1,5,9,… which does include minute 5.
  assert.equal(cronMatches("1-30/4 14-16 * * *", "Asia/Shanghai", shanghaiMonday15), true);
  assert.equal(cronMatches("1-30/7 14-16 * * *", "Asia/Shanghai", shanghaiMonday15), false);
});

test("restricted both day fields uses OR (Vixie)", () => {
  assert.equal(cronMatches("5 15 20 * 1", "Asia/Shanghai", shanghaiMonday15), true); // 周一命中（日 20 不命中）
});

test("malformed expression returns false, never throws", () => {
  assert.equal(cronMatches("not a cron", "Asia/Shanghai", shanghaiMonday15), false);
  assert.equal(cronMatches("* * * *", "Asia/Shanghai", shanghaiMonday15), false);
});

test("invalid timezone returns false, never throws (one bad declaration must not kill the tick)", () => {
  // Intl.DateTimeFormat 对未知时区抛 RangeError —— 人写 frontmatter 的现实输入。
  // 遵守「畸形输入返回 false」契约，坏声明只错过本轮，不炸整个 spawner。
  assert.equal(cronMatches("* * * * *", "Asia/Shanghao", shanghaiMonday15), false);
  assert.equal(cronMatches("* * * * *", "Not/A_Timezone", shanghaiMonday15), false);
});

test("timezone shifts the match", () => {
  // 07:05 UTC = 15:05 上海 / 02:05 纽约（前一日的 2 点）
  assert.equal(cronMatches("5 15 * * *", "America/New_York", shanghaiMonday15), false);
  assert.equal(cronMatches("5 2 * * *", "America/New_York", shanghaiMonday15), true);
});

test("nextDue 跨日跨周（周五下午 → 周一 9 点）", () => {
  const fri = new Date("2024-01-12T10:00:00.000Z"); // 周五 18:00 上海
  const due = nextDue("0 9 * * 1", "Asia/Shanghai", fri);
  assert.equal(due?.toISOString(), "2024-01-15T01:00:00.000Z"); // 下周一 09:00 上海
});

test("nextDue 半小时 cron 的下一个槽", () => {
  const t = new Date("2024-01-15T07:05:00.000Z"); // 上海 15:05
  assert.equal(nextDue("*/30 9-22 * * 1-5", "Asia/Shanghai", t)?.toISOString(), "2024-01-15T07:30:00.000Z");
});

test("nextDue 畸形输入返回 undefined 且不抛", () => {
  assert.equal(nextDue("bad", "Asia/Shanghai", new Date()), undefined);
  assert.equal(nextDue("* * * * *", "Asia/Shanghao", new Date()), undefined);
});

test("buildMatcher 无效表达式返回恒 false 函数（不含时区，按 UTC 评估）", () => {
  const never = buildMatcher("bad");
  assert.equal(typeof never, "function");
  assert.equal(never(new Date("2024-01-15T07:05:00.000Z")), false);
  const utcMatcher = buildMatcher("5 15 * * 1");
  // 无时区换算：按 Date 的 UTC 字段评估 —— 15:05 UTC 周一命中；同一时刻的上海时间 23:05 UTC 字段不命中
  assert.equal(utcMatcher(new Date("2024-01-15T15:05:00.000Z")), true);
  assert.equal(utcMatcher(new Date("2024-01-15T15:05:00.000+08:00")), false);
});
