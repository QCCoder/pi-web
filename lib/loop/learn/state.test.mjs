import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { renderDerivedSection, renderDerivedBlock, mergeStateFile, DERIVED_START, DERIVED_END } = await jiti.import("./state.ts");

function derived(modules = [], sensitiveAuto = [], computedAt = "2026-01-02T00:00:00.000Z") {
  return { computedAt, modules, sensitiveAuto };
}

test("renderDerivedBlock: empty derived => placeholders", () => {
  const block = renderDerivedBlock(derived());
  assert.match(block, /module_calibration: <no samples yet>/);
  assert.match(block, /sensitive_auto: <none>/);
});

test("renderDerivedBlock: modules rendered with accuracy/tier/strikes", () => {
  const d = derived([
    { module: "finance-service", samples: 5, highConfSamples: 5, highConfAccuracy: 0.6, effectiveHighTier: "med", strikes: 2, stuckRate: 0.2 },
  ]);
  const block = renderDerivedBlock(d);
  assert.match(block, /finance-service: samples=5/);
  assert.match(block, /high=60%/);
  assert.match(block, /tier=med/);
  assert.match(block, /strikes=2/);
});

test("renderDerivedSection: wrapped with markers", () => {
  const section = renderDerivedSection(derived());
  assert.ok(section.startsWith(DERIVED_START));
  assert.ok(section.trimEnd().endsWith(DERIVED_END));
});

test("mergeStateFile: appends when markers absent", () => {
  const out = mergeStateFile("# State\n\nbaseline.", derived());
  assert.match(out, /baseline\./);
  assert.match(out, /dev-loop:derived:start/);
  assert.match(out, /dev-loop:derived:end/);
});

test("mergeStateFile: replaces when markers present (idempotent recompute)", () => {
  const initial = mergeStateFile("# State\n", derived());
  const d2 = derived([
    { module: "m", samples: 3, highConfSamples: 3, highConfAccuracy: 1, effectiveHighTier: "high", strikes: 0, stuckRate: 0 },
  ], [], "2026-01-03T00:00:00.000Z");
  const updated = mergeStateFile(initial, d2);
  // exactly one derived section
  assert.equal((updated.match(/dev-loop:derived:start/g) || []).length, 1);
  assert.equal((updated.match(/dev-loop:derived:end/g) || []).length, 1);
  assert.match(updated, /m: samples=3/);
  assert.match(updated, /2026-01-03/);
  assert.doesNotMatch(updated, /<no samples yet>/);
});

test("mergeStateFile: multiple merges stay single-section", () => {
  let s = "# State\n";
  for (let i = 0; i < 3; i++) {
    s = mergeStateFile(s, derived([], [], `2026-01-0${i + 1}T00:00:00.000Z`));
  }
  assert.equal((s.match(/dev-loop:derived:start/g) || []).length, 1);
  assert.match(s, /2026-01-03/);
});
