import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateDrift, resolveThreshold } from "./check-upstream-freshness.mjs";

test("evaluateDrift：阈值内放行，边界值（正好等于阈值）不算超标", () => {
  assert.deepEqual(evaluateDrift({ behind: 0, threshold: 50 }), {
    ok: true, severity: "info", reason: "within_threshold", behind: 0,
  });
  assert.equal(evaluateDrift({ behind: 49, threshold: 50 }).ok, true);
  assert.equal(evaluateDrift({ behind: 50, threshold: 50 }).ok, true);
});

test("evaluateDrift：超过阈值判失败，并带回落后数", () => {
  const verdict = evaluateDrift({ behind: 361, threshold: 50 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.severity, "error");
  assert.equal(verdict.reason, "over_threshold");
  assert.equal(verdict.behind, 361);
});

test("evaluateDrift：分叉数不可信（null/负数/NaN）时降级为警告而不是误报失败", () => {
  for (const behind of [null, undefined, -1, Number.NaN]) {
    const verdict = evaluateDrift({ behind, threshold: 50 });
    assert.equal(verdict.ok, true, `behind=${behind} 应放行`);
    assert.equal(verdict.severity, "warn");
    assert.equal(verdict.reason, "unknown_drift");
  }
});

test("resolveThreshold：非法阈值回退默认 50，不抛错", () => {
  assert.equal(resolveThreshold(undefined), 50);
  assert.equal(resolveThreshold(""), 50);
  assert.equal(resolveThreshold("abc"), 50);
  assert.equal(resolveThreshold("0"), 50);
  assert.equal(resolveThreshold("-5"), 50);
  assert.equal(resolveThreshold("80"), 80);
  assert.equal(resolveThreshold("1"), 1);
});
