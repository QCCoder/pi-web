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

// ------------- review 记录（final-arch step-3 Task 1，2026-10-26：先审后跑）

const review = (over = {}) => ({
  outcome: "pass",
  notes: "审查通过：设计与实现一致，边界条件已覆盖。",
  candidateDigest: "c".repeat(64),
  at: "2026-10-26T08:00:00Z",
  attemptId: "01JC8ATTEMPT0000000000000R",
  ...over,
});

test("parseDelivery round-trips a pass review verbatim (source 键不虚构)", () => {
  const delivery = dt.parseDelivery({
    protocolVersion: 1,
    mode: "manual",
    review: review(),
  });
  assert.deepEqual(delivery.review, review());
});

test("parseDelivery round-trips a rework review with source code|spec", () => {
  for (const source of ["code", "spec"]) {
    const record = review({ outcome: "rework", source, notes: "边界条件缺失：大文件上传未覆盖。" });
    const delivery = dt.parseDelivery({ protocolVersion: 1, mode: "manual", review: record });
    assert.deepEqual(delivery.review, record);
  }
});

test("parseDelivery without a review key parses as before (键不虚构)", () => {
  const delivery = dt.parseDelivery({ protocolVersion: 1, mode: "manual" });
  assert.equal(delivery.review, undefined);
});

test("parseDelivery rejects a rework review without source", () => {
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1,
      mode: "manual",
      review: review({ outcome: "rework" }),
    }),
    /delivery\.review\.source/,
  );
  // source 显式 null 同拒（present 语义：在场即校验）。
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1,
      mode: "manual",
      review: review({ outcome: "rework", source: null }),
    }),
    /delivery\.review\.source/,
  );
});

test("parseDelivery rejects a rework review with a source outside code|spec", () => {
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1,
      mode: "manual",
      review: review({ outcome: "rework", source: "vibes" }),
    }),
    /delivery\.review\.source/,
  );
});

test("parseDelivery rejects a pass review carrying a source", () => {
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1,
      mode: "manual",
      review: review({ source: "code" }),
    }),
    /delivery\.review\.source/,
  );
});

test("parseDelivery rejects an outcome outside pass|rework", () => {
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1,
      mode: "manual",
      review: review({ outcome: "approved" }),
    }),
    /delivery\.review\.outcome/,
  );
});

test("parseDelivery: notes required for both outcomes; rework notes must be non-empty (pass 可空)", () => {
  // notes 键缺席 / 非字符串——两种 outcome 同拒（rework 子例带 source，让
  // source 门先行通过、精确命中文案门）。
  for (const outcome of ["pass", "rework"]) {
    const missing = review(
      outcome === "rework" ? { outcome, source: "code" } : { outcome },
    );
    delete missing.notes;
    assert.throws(
      () => dt.parseDelivery({ protocolVersion: 1, mode: "manual", review: missing }),
      /delivery\.review\.notes/,
    );
    assert.throws(
      () => dt.parseDelivery({
        protocolVersion: 1,
        mode: "manual",
        review: review(
          outcome === "rework"
            ? { outcome, source: "code", notes: 42 }
            : { outcome, notes: 42 },
        ),
      }),
      /delivery\.review\.notes/,
    );
  }
  // rework 的 notes 必须非空（重做必须说明缺什么）。
  assert.throws(
    () => dt.parseDelivery({
      protocolVersion: 1,
      mode: "manual",
      review: review({ outcome: "rework", source: "code", notes: "   " }),
    }),
    /delivery\.review\.notes/,
  );
  // pass 的 notes 允许空串（通过审查可以不附说明）。
  const emptyPass = dt.parseDelivery({
    protocolVersion: 1,
    mode: "manual",
    review: review({ notes: "" }),
  });
  assert.equal(emptyPass.review.notes, "");
});

test("parseDelivery rejects reviews missing candidateDigest/at/attemptId", () => {
  for (const field of ["candidateDigest", "at", "attemptId"]) {
    const bad = review();
    delete bad[field];
    assert.throws(
      () => dt.parseDelivery({ protocolVersion: 1, mode: "manual", review: bad }),
      new RegExp(`delivery\\.review\\.${field}`),
      `missing ${field} must be rejected`,
    );
  }
});

// ------------- verification actor 放宽（final-arch step-3 Task 3：system 步落块）

const verification = (over = {}) => ({
  at: "2026-10-26T08:00:00Z",
  actor: "system",
  requirementDigest: "r".repeat(64),
  candidateDigest: "c".repeat(64),
  checks: [
    {
      name: "smoke",
      outcome: "passed",
      evidence: { command: "true", exitCode: 0, durationMs: 12, logRef: "delivery/artifacts/verification-logs/x/smoke.log" },
    },
  ],
  ...over,
});

test("parseDelivery round-trips a verification record with actor system（system 步落块）", () => {
  const record = verification();
  const delivery = dt.parseDelivery({ protocolVersion: 1, mode: "manual", verification: record });
  assert.deepEqual(delivery.verification, record);
});

test("parseDelivery: legacy verification actors user/agent parse unchanged（旧记录永可读）", () => {
  for (const actor of ["user", "agent"]) {
    const delivery = dt.parseDelivery({
      protocolVersion: 1,
      mode: "manual",
      verification: verification({ actor }),
    });
    assert.equal(delivery.verification.actor, actor);
  }
});

test("parseDelivery rejects a verification actor outside user|agent|system", () => {
  for (const actor of ["bot", "reviewer", null]) {
    assert.throws(
      () => dt.parseDelivery({
        protocolVersion: 1,
        mode: "manual",
        verification: verification({ actor }),
      }),
      /delivery\.verification\.actor/,
      `actor=${String(actor)} must be rejected`,
    );
  }
});

// ------------- 澄清 role 放宽（final-arch step-3 Task 1：AnyDeliveryRole）

test("clarification role 为 legacy verifier / 活值 reviewer 均解析（旧数据永可读）", () => {
  const delivery = dt.parseDelivery({
    protocolVersion: 1,
    mode: "manual",
    clarifications: [
      clarification({ id: "01JC8CLARIF0000000000000V", role: "verifier" }),
      clarification({ id: "01JC8CLARIF0000000000000R", role: "reviewer" }),
    ],
  });
  assert.deepEqual(
    delivery.clarifications.map((entry) => entry.role),
    ["verifier", "reviewer"],
  );
});

// ------------- acceptance 记录（final-arch step-4 Task 1：record-release 验收门）

const acceptance = (over = {}) => ({
  notes: "验收通过：候选与需求一致，抽查边界用例无误。",
  candidateDigest: "c".repeat(64),
  at: "2026-10-26T09:00:00Z",
  ...over,
});

test("parseDelivery round-trips an acceptance record verbatim（键不虚构）", () => {
  const record = acceptance();
  const delivery = dt.parseDelivery({ protocolVersion: 1, mode: "manual", acceptance: record });
  assert.deepEqual(delivery.acceptance, record);
  // 无 acceptance 键照常解析、键不虚构。
  const bare = dt.parseDelivery({ protocolVersion: 1, mode: "manual" });
  assert.equal(bare.acceptance, undefined);
  assert.deepEqual(Object.keys(bare).sort(), ["mode", "protocolVersion"]);
});

test("parseDelivery rejects an acceptance record with blank notes", () => {
  for (const bad of ["   ", "", 42, undefined]) {
    const record = acceptance();
    if (bad === undefined) delete record.notes;
    else record.notes = bad;
    assert.throws(
      () => dt.parseDelivery({ protocolVersion: 1, mode: "manual", acceptance: record }),
      /delivery\.acceptance\.notes/,
      `notes=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("parseDelivery rejects an acceptance record missing candidateDigest/at", () => {
  for (const field of ["candidateDigest", "at"]) {
    const bad = acceptance();
    delete bad[field];
    assert.throws(
      () => dt.parseDelivery({ protocolVersion: 1, mode: "manual", acceptance: bad }),
      new RegExp(`delivery\\.acceptance\\.${field}`),
      `missing ${field} must be rejected`,
    );
  }
});
