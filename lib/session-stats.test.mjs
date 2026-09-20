import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { computeCacheHitRatePercent } = await jiti.import("./session-stats.ts");

test("no cache traffic reports no rate", () => {
  assert.equal(computeCacheHitRatePercent({ input: 500, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(computeCacheHitRatePercent({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test("rate covers all input-class tokens in the denominator", () => {
  // reads / (input + writes + reads) = 700 / (100 + 200 + 700) = 70%
  assert.equal(
    computeCacheHitRatePercent({ input: 100, cacheRead: 700, cacheWrite: 200 }),
    70,
  );
});

test("all-cached input yields 100%", () => {
  assert.equal(
    computeCacheHitRatePercent({ input: 0, cacheRead: 900, cacheWrite: 0 }),
    100,
  );
});

test("fractional rates keep one-decimal precision upstream of the UI", () => {
  // 1 / 3 ≈ 33.333…% — the component rounds to one decimal for display.
  const rate = computeCacheHitRatePercent({ input: 1, cacheRead: 1, cacheWrite: 1 });
  assert.ok(Math.abs(rate - 33.33333333333333) < 1e-9);
});
