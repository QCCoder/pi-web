import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { cronMatches } = await createJiti(import.meta.url).import("./scheduler.ts");

test("cron matcher honors timezone, ranges, lists, and steps", () => {
  const mondayAt1505Shanghai = new Date("2024-01-15T07:05:00.000Z");
  assert.equal(cronMatches("5 15 * * 1-5", "Asia/Shanghai", mondayAt1505Shanghai), true);
  assert.equal(cronMatches("*/10 15 * * 1-5", "Asia/Shanghai", mondayAt1505Shanghai), false);
  assert.equal(cronMatches("5 15 * * 0,6", "Asia/Shanghai", mondayAt1505Shanghai), false);
  assert.equal(cronMatches("5 15 1 * 1", "Asia/Shanghai", mondayAt1505Shanghai), true);
});
