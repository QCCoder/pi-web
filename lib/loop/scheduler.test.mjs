import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { cronMatches } = await createJiti(import.meta.url).import("./scheduler.ts");

// cron matcher behavior lives in lib/daemon/cron.test.mjs now (moved verbatim).
// This file guards the re-export: existing ./scheduler.ts importers keep working.
test("scheduler re-exports cronMatches for existing importers", () => {
  assert.equal(typeof cronMatches, "function");
  assert.equal(cronMatches("* * * * *", "Asia/Shanghai", new Date("2024-01-15T07:05:00.000Z")), true);
});
