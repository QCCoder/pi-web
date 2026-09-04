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

test("unbound / unknown binding, single active loop → auto-route to it", () => {
  const loops = [{ name: "dev-loop", pattern: "dev-loop" }];
  assert.equal(resolveContractPattern(undefined, loops), "dev-loop");
  assert.equal(resolveContractPattern("gone-loop", loops), "dev-loop");
});

test("unbound / unknown binding, ≥2 active loops → ambiguous, undefined", () => {
  assert.equal(resolveContractPattern(undefined, LOOPS), undefined);
  assert.equal(resolveContractPattern("gone-loop", LOOPS), undefined);
});

test("binding to a paused loop is a miss → single remaining active wins", () => {
  const loops = [
    { name: "dev-loop", pattern: "dev-loop", paused: true },
    { name: "triage-loop", pattern: "triage" },
  ];
  assert.equal(resolveContractPattern("dev-loop", loops), "triage");
  assert.equal(resolveContractPattern(undefined, loops), "triage");
});

test("all paused with miss → undefined even though loops exist", () => {
  const loops = [
    { name: "dev-loop", pattern: "dev-loop", paused: true },
    { name: "triage-loop", pattern: "triage", paused: true },
  ];
  assert.equal(resolveContractPattern(undefined, loops), undefined);
});

test("no active loops → undefined (bare prompt degradation)", () => {
  assert.equal(resolveContractPattern("dev-loop", []), undefined);
  assert.equal(resolveContractPattern(undefined, [{ name: "x", pattern: "x", paused: true }]), undefined);
});
