import test from "node:test";
import assert from "node:assert/strict";
import { resolveContractPattern } from "./contract-prefill.ts";

const LOOPS = [
  { name: "dev-loop", pattern: "dev-loop" },
  { name: "triage-loop", pattern: "triage" },
];

test("binding hit → that loop's pattern", () => {
  assert.equal(resolveContractPattern("triage-loop", LOOPS), "triage");
  assert.equal(resolveContractPattern("dev-loop", LOOPS), "dev-loop");
});

test("unbound / unknown binding → falls back to first active loop", () => {
  assert.equal(resolveContractPattern(undefined, LOOPS), "dev-loop");
  assert.equal(resolveContractPattern("gone-loop", LOOPS), "dev-loop");
});

test("binding to a paused loop is a miss → fallback skips paused loops", () => {
  const loops = [
    { name: "dev-loop", pattern: "dev-loop", paused: true },
    { name: "triage-loop", pattern: "triage" },
  ];
  assert.equal(resolveContractPattern("dev-loop", loops), "triage");
  assert.equal(resolveContractPattern(undefined, loops), "triage");
});

test("no active loops → undefined (bare prompt degradation)", () => {
  assert.equal(resolveContractPattern("dev-loop", []), undefined);
  assert.equal(resolveContractPattern(undefined, [{ name: "x", pattern: "x", paused: true }]), undefined);
});
