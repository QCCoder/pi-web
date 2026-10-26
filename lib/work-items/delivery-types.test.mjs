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

// --------------- clarifications 数据面（final-arch step-2 Task 1，2026-10-26）

const clarification = (over = {}) => ({
  id: "01JC8CLARIF0000000000000A",
  role: "developer",
  question: "候选仓库 r1 的迁移脚本要不要跑？",
  askedAt: "2026-10-26T00:00:00Z",
  attemptId: "01JC8ATTEMPT00000000000001",
  ...over,
});

test("parseDelivery round-trips legal clarifications verbatim", () => {
  const delivery = dt.parseDelivery({
    protocolVersion: 1,
    mode: "manual",
    clarifications: [
      clarification({
        options: ["跑", "不跑"],
        recommended: "跑",
        answer: "跑",
        answeredAt: "2026-10-26T01:00:00Z",
      }),
      clarification({ id: "01JC8CLARIF0000000000000B", role: "designer" }),
    ],
  });
  assert.equal(delivery.clarifications.length, 2);
  assert.equal(delivery.clarifications[0].recommended, "跑");
  assert.equal(delivery.clarifications[0].answer, "跑");
  assert.equal(delivery.clarifications[0].answeredAt, "2026-10-26T01:00:00Z");
  // 未回答条目：answer/answeredAt 键整体剥掉（条件展开习语——不虚构键）。
  assert.equal(delivery.clarifications[1].answer, undefined);
  assert.equal(delivery.clarifications[1].answeredAt, undefined);
  assert.equal(delivery.clarifications[1].options, undefined);
});

test("parseDelivery without a clarifications key parses as before (键不虚构)", () => {
  const delivery = dt.parseDelivery({ protocolVersion: 1, mode: "manual" });
  assert.equal(delivery.clarifications, undefined);
  assert.deepEqual(
    Object.keys(delivery).sort(),
    ["mode", "protocolVersion"],
  );
});

test("parseDelivery rejects clarifications missing id/question/askedAt/attemptId", () => {
  for (const field of ["id", "question", "askedAt", "attemptId"]) {
    const bad = clarification();
    delete bad[field];
    assert.throws(
      () => dt.parseDelivery({ protocolVersion: 1, mode: "manual", clarifications: [bad] }),
      new RegExp(`clarifications\\[0\\]\\.${field}`),
      `missing ${field} must be rejected`,
    );
  }
});

test("parseDelivery rejects a clarification role outside DELIVERY_ROLES", () => {
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1, mode: "manual",
      clarifications: [clarification({ role: "boss" })],
    }),
    /clarifications\[0\]\.role/,
  );
});

test("parseDelivery rejects answer/answeredAt half-pairs (同在同缺)", () => {
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1, mode: "manual",
      clarifications: [clarification({ answer: "跑" })],
    }),
    /answer.*answeredAt|answeredAt.*answer/,
  );
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1, mode: "manual",
      clarifications: [clarification({ answeredAt: "2026-10-26T01:00:00Z" })],
    }),
    /answer.*answeredAt|answeredAt.*answer/,
  );
  // 同在同缺的合法对已在上面的 round-trip 用例覆盖。
});

test("parseDelivery rejects options that are not an array of non-empty strings", () => {
  for (const bad of ["跑", [1, 2], [""]]) {
    assert.throws(
      () => dt.parseDelivery({
        protocolVersion: 1, mode: "manual",
        clarifications: [clarification({ options: bad })],
      }),
      /clarifications\[0\]\.options/,
      `options=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("DELIVERY_ACTIONS contains answer-clarification; lastRequest.action accepts it", () => {
  assert.ok(dt.DELIVERY_ACTIONS.includes("answer-clarification"));
  const delivery = dt.parseDelivery({
    protocolVersion: 1,
    mode: "manual",
    lastRequest: { requestId: "req-1", action: "answer-clarification", at: "t" },
  });
  assert.equal(delivery.lastRequest.action, "answer-clarification");
});
