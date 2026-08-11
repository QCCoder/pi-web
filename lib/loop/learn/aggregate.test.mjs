import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseLearnRecords, aggregate, effectiveTier, isAutoSensitive } = await jiti.import("./aggregate.ts");
const { ACCURACY_FLOOR, MIN_SAMPLES, STRIKE_THRESHOLD } = await jiti.import("./config.ts");

function rec(module, overrides = {}) {
  return {
    runId: `r-${module}-${Math.random().toString(36).slice(2, 6)}`,
    workItemKey: "BUG-0001", module, repo: "cargoware",
    predictedConf: "high", riskTier: "normal", outcome: "merged", tests: "green",
    ts: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

test("parseLearnRecords: skips malformed lines, keeps valid ones", () => {
  const jsonl = [
    JSON.stringify(rec("m1")),
    "not json",
    JSON.stringify({ runId: "x" }), // missing fields
    "",
    JSON.stringify(rec("m2", { outcome: "red" })), // bad enum -> dropped
    JSON.stringify(rec("m2", { tests: "red" })),
  ].join("\n");
  const records = parseLearnRecords(jsonl);
  // only the two well-formed records survive (the outcome:"red" one is dropped)
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.module), ["m1", "m2"]);
});

test("aggregate: high accuracy stays high", () => {
  const records = [
    rec("finance", { outcome: "merged" }),
    rec("finance", { outcome: "merged" }),
    rec("finance", { outcome: "merged" }),
  ];
  const d = aggregate(records);
  const m = d.modules.find((x) => x.module === "finance");
  assert.equal(m.highConfSamples, 3);
  assert.equal(m.highConfAccuracy, 1);
  assert.equal(m.effectiveHighTier, "high");
  assert.equal(effectiveTier("finance", "high", d), "high");
});

test("aggregate: low accuracy demotes high -> med (the §7.4 evolution example)", () => {
  // 3 merged + 2 changes_requested => accuracy 0.6 < 0.7
  const records = [
    rec("finance", { outcome: "merged" }),
    rec("finance", { outcome: "merged" }),
    rec("finance", { outcome: "merged" }),
    rec("finance", { outcome: "changes_requested" }),
    rec("finance", { outcome: "changes_requested" }),
  ];
  const d = aggregate(records);
  const m = d.modules.find((x) => x.module === "finance");
  assert.equal(m.highConfSamples, 5);
  assert.ok(Math.abs((m.highConfAccuracy ?? 1) - 0.6) < 1e-9);
  assert.equal(m.effectiveHighTier, "med");
  // next round sees high demoted to med => trips gate1
  assert.equal(effectiveTier("finance", "high", d), "med");
});

test("aggregate: below MIN_SAMPLES => accuracy null, never demote", () => {
  const records = [rec("m"), rec("m", { outcome: "changes_requested" })];
  const d = aggregate(records);
  const m = d.modules.find((x) => x.module === "m");
  assert.equal(m.highConfAccuracy, null);
  assert.equal(m.effectiveHighTier, "high");
  assert.equal(MIN_SAMPLES, 3);
});

test("aggregate: effectiveTier only demotes high; med/low unchanged", () => {
  const records = [rec("m"), rec("m", { outcome: "changes_requested" }), rec("m", { outcome: "changes_requested" }), rec("m", { outcome: "changes_requested" })];
  const d = aggregate(records);
  assert.equal(effectiveTier("m", "high", d), "med");
  assert.equal(effectiveTier("m", "med", d), "med");
  assert.equal(effectiveTier("m", "low", d), "low");
});

test("aggregate: strikes = consecutive tail of changes_requested/rejected", () => {
  const records = [
    rec("m", { outcome: "merged" }),
    rec("m", { outcome: "changes_requested" }),
    rec("m", { outcome: "rejected" }),
  ];
  const d = aggregate(records);
  assert.equal(d.modules[0].strikes, 2);
});

test("aggregate: merged resets the strike streak", () => {
  const records = [
    rec("m", { outcome: "changes_requested" }),
    rec("m", { outcome: "changes_requested" }),
    rec("m", { outcome: "merged" }),
    rec("m", { outcome: "changes_requested" }),
  ];
  const d = aggregate(records);
  assert.equal(d.modules[0].strikes, 1);
});

test("aggregate: STRIKE_THRESHOLD consecutive strikes auto-adds sensitive (asymmetric tighten)", () => {
  const records = Array.from({ length: STRIKE_THRESHOLD }, () => rec("risk-mod", { outcome: "changes_requested" }));
  const d = aggregate(records);
  assert.ok(isAutoSensitive("risk-mod", d));
  assert.equal(d.sensitiveAuto[0].module, "risk-mod");
});

test("aggregate: stuckRate counts blocked", () => {
  const records = [
    rec("m", { outcome: "merged" }),
    rec("m", { outcome: "blocked" }),
    rec("m", { outcome: "blocked" }),
    rec("m", { outcome: "blocked" }),
  ];
  const d = aggregate(records);
  assert.ok(Math.abs(d.modules[0].stuckRate - 0.75) < 1e-9);
});

test("aggregate: empty records => empty derived", () => {
  const d = aggregate([]);
  assert.deepEqual(d.modules, []);
  assert.deepEqual(d.sensitiveAuto, []);
});

test("aggregate: ACCURACY_FLOOR and STRIKE_THRESHOLD sanity", () => {
  assert.equal(ACCURACY_FLOOR, 0.7);
  assert.ok(STRIKE_THRESHOLD >= 2);
});
