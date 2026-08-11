import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { repoCheckerCommands, resolveChecker, hasChecker } = await jiti.import("./checkers.ts");

test("repoCheckerCommands: cargoware is module-scoped Maven", () => {
  const c = repoCheckerCommands("cargoware");
  assert.ok(c);
  assert.equal(c.moduleScoped, true);
  assert.deepEqual([...c.test], ["mvn", "-pl", "{module}", "test"]);
  assert.ok(c.build?.includes("{module}"));
});

test("repoCheckerCommands: cargoware-h5 is npm test:ci", () => {
  const c = repoCheckerCommands("cargoware-h5");
  assert.ok(c);
  assert.equal(c.moduleScoped, false);
  assert.deepEqual([...c.test], ["npm", "run", "test:ci"]);
  assert.equal(c.build, undefined);
});

test("repoCheckerCommands: cargo-report-server-haichuang is single-module mvn test", () => {
  const c = repoCheckerCommands("cargo-report-server-haichuang");
  assert.ok(c);
  assert.equal(c.moduleScoped, false);
  assert.deepEqual([...c.test], ["mvn", "test"]);
});

test("repoCheckerCommands: cargoapi / cargo-h5-mp have no checker (Phase-0 finding)", () => {
  assert.equal(repoCheckerCommands("cargoapi"), null);
  assert.equal(repoCheckerCommands("cargo-h5-mp"), null);
  assert.equal(repoCheckerCommands("does-not-exist"), null);
});

test("resolveChecker substitutes {module} for module-scoped repos", () => {
  const r = resolveChecker("cargoware", "finance-service");
  assert.ok(r);
  assert.deepEqual([...r.build], ["mvn", "-pl", "finance-service", "-am", "compile", "-q"]);
  assert.deepEqual([...r.test], ["mvn", "-pl", "finance-service", "test"]);
});

test("resolveChecker returns null when module-scoped repo lacks a module", () => {
  assert.equal(resolveChecker("cargoware"), null);
  assert.equal(resolveChecker("cargoware", "  "), null);
});

test("resolveChecker passes through non-module-scoped commands", () => {
  const r = resolveChecker("cargoware-h5");
  assert.ok(r);
  assert.deepEqual([...r.test], ["npm", "run", "test:ci"]);
});

test("resolveChecker returns null for unsupported aliases even with a module", () => {
  assert.equal(resolveChecker("cargoapi", "price"), null);
});

test("hasChecker reflects the registry", () => {
  assert.equal(hasChecker("cargoware"), true);
  assert.equal(hasChecker("cargoware-h5"), true);
  assert.equal(hasChecker("cargoapi"), false);
});
