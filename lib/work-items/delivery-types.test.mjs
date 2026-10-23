import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const dt = await jiti.import("./delivery-types.ts");

test("parseDelivery accepts v1 manual and round-trips optional fields", () => {
  const delivery = dt.parseDelivery({ protocolVersion: 1, mode: "manual" });
  assert.equal(delivery.protocolVersion, 1);
  const full = dt.parseDelivery({
    protocolVersion: 1, mode: "manual",
    designConfirmed: { at: "t", actor: "user", requirementDigest: "a", designDigest: "b" },
    candidates: [{ repositoryId: "r2", commit: "c2" }, { repositoryId: "r1", commit: "c1" }],
  });
  assert.equal(full.candidates.length, 2);
});

test("parseDelivery rejects unknown protocolVersion and non-manual mode", () => {
  assert.throws(() => dt.parseDelivery({ protocolVersion: 2, mode: "manual" }), /Unknown delivery protocolVersion/);
  assert.throws(() => dt.parseDelivery({ protocolVersion: 1, mode: "auto" }), /mode/);
});

test("digests are stable and order-insensitive for candidates", () => {
  const a = dt.candidatesDigest([{ repositoryId: "r1", commit: "c" }, { repositoryId: "r2", commit: "d" }]);
  const b = dt.candidatesDigest([{ repositoryId: "r2", commit: "d" }, { repositoryId: "r1", commit: "c" }]);
  assert.equal(a, b);
  assert.equal(dt.contentDigest("x"), dt.contentDigest("x"));
  assert.notEqual(dt.contentDigest("x"), dt.contentDigest("y"));
});
