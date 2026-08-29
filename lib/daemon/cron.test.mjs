import test from "node:test";
import assert from "node:assert/strict";
import { cronMatches } from "./cron.ts";

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

test("timezone shifts the match", () => {
  // 07:05 UTC = 15:05 上海 / 02:05 纽约（前一日的 2 点）
  assert.equal(cronMatches("5 15 * * *", "America/New_York", shanghaiMonday15), false);
  assert.equal(cronMatches("5 2 * * *", "America/New_York", shanghaiMonday15), true);
});
