import assert from "node:assert/strict";
import test from "node:test";

const { safeDestination } = await import("./safe-destination.ts");

test("keeps in-app destinations, including their query", () => {
  assert.equal(safeDestination("?next=%2Fworkspaces%3Fid%3D7"), "/workspaces?id=7");
});

test("falls back to / without or with an empty next parameter", () => {
  assert.equal(safeDestination(""), "/");
  assert.equal(safeDestination("?next="), "/");
});

test("rejects protocol-relative destinations", () => {
  assert.equal(safeDestination("?next=%2F%2Fevil.com"), "/");
  assert.equal(safeDestination("?next=//evil.com/path"), "/");
});

test("rejects backslash destinations that browsers normalize to //", () => {
  assert.equal(safeDestination("?next=%2F%5Cevil.com"), "/");
  assert.equal(safeDestination("?next=/\\evil.com/path"), "/");
});

test("rejects absolute URLs and non-path values", () => {
  assert.equal(safeDestination("?next=https%3A%2F%2Fevil.com"), "/");
  assert.equal(safeDestination("?next=evil"), "/");
});
