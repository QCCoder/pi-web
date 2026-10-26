// Standard delivery flow state machine — pure-function rules (planDeliveryTransition /
// legalDeliveryActions). Fifth digests arg per controller Ruling 4: confirm-design and
// record-verification consume { requirement?, design? } computed by applyDeliveryAction.
// The integration section below exercises applyDeliveryAction + the service gates with
// the same temp-workspace fixture conventions as service.test.mjs (native ESM imports).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import * as deliveryNative from "./delivery.ts";
import * as itemService from "./service.ts";
import * as workspaceService from "../workspaces/service.ts";
import { projectDeliveryPool } from "./delivery-runner/pool.ts";
import { WorkItemConflictError, WorkItemValidationError } from "./errors.ts";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const delivery = await jiti.import("./delivery.ts");
const { planDeliveryTransition, legalDeliveryActions } = delivery;
// legalActionBarActions 只在 client-safe 的 legal-actions.ts 上（delivery.ts
// 的 re-export 仅 legalDeliveryActions——详情页动作条直接 import 该模块）。
const { legalActionBarActions } = await jiti.import("./legal-actions.ts");

const baseItem = (over = {}) => ({
  schemaVersion: 1, id: "id", key: "REQ-0001", revision: 1, type: "requirement",
  title: "t", status: "open", phase: "intake", priority: "P2",
  repositories: [], tags: [], conversations: [], relatedItems: [], designs: [], plans: [],
  archivedAt: null, createdAt: "t", updatedAt: "t",
  delivery: { protocolVersion: 1, mode: "manual" }, ...over,
});

test("start-design moves intake to design", () => {
  const plan = planDeliveryTransition(baseItem(), "start-design", {}, new Date("2026-10-23T00:00:00Z"));
  assert.equal(plan.phase, "design");
  assert.match(plan.eventType, /delivery\.start-design/);
});

test("confirm-design requires a design digest and moves to ready_for_implementation", () => {
  const item = baseItem({ phase: "design" });
  const plan = planDeliveryTransition(item, "confirm-design", {}, new Date("2026-10-23T00:00:00Z"),
    { requirement: "d", design: "d" });
  assert.equal(plan.phase, "ready_for_implementation");
  assert.equal(plan.delivery.designConfirmed.actor, "user");
  assert.ok(plan.delivery.designConfirmed.designDigest);
  assert.ok(plan.delivery.designConfirmed.requirementDigest);
});

test("confirm-design is rejected outside design phase", () => {
  assert.throws(() => planDeliveryTransition(baseItem({ phase: "intake" }), "confirm-design", {}, new Date()), /phase/);
});

test("submit-verification requires at least one candidate with repositoryId+commit", () => {
  const item = baseItem({ phase: "implementation", delivery: { protocolVersion: 1, mode: "manual" } });
  assert.throws(() => planDeliveryTransition(item, "submit-verification", { candidates: [] }, new Date()), /candidate/i);
  const plan = planDeliveryTransition(item, "submit-verification",
    { candidates: [{ repositoryId: "r1", commit: "abc" }] }, new Date());
  assert.equal(plan.phase, "verification");
  assert.equal(plan.delivery.candidates.length, 1);
  assert.equal(plan.delivery.verification, undefined);  // 旧通过结果不得沿用
});

test("record-verification passes only when every check passed", () => {
  const cand = [{ repositoryId: "r1", commit: "abc" }];
  const item = baseItem({ phase: "verification", delivery: { protocolVersion: 1, mode: "manual", candidates: cand } });
  assert.throws(() => planDeliveryTransition(item, "record-verification",
    { checks: [{ name: "回归", outcome: "failed" }] }, new Date(), { requirement: "d" }), /rework|未通过/);
  const plan = planDeliveryTransition(item, "record-verification",
    { checks: [{ name: "回归", outcome: "passed" }] }, new Date(), { requirement: "d" });
  assert.equal(plan.phase, "release_ready");
  assert.equal(plan.delivery.verification.checks[0].outcome, "passed");
  assert.ok(plan.delivery.verification.candidateDigest);
});

test("record-release freezes the baseline and marks done", () => {
  const cand = [{ repositoryId: "r1", commit: "abc" }];
  const item = baseItem({ phase: "release_ready", delivery: {
    protocolVersion: 1, mode: "manual", candidates: cand,
    verification: { at: "t", actor: "user", requirementDigest: "d", candidateDigest: "cd", checks: [{ name: "x", outcome: "passed" }] },
  } });
  const plan = planDeliveryTransition(item, "record-release", { version: "v1.2.0" }, new Date());
  assert.equal(plan.phase, "released");
  assert.equal(plan.status, "done");
  assert.equal(plan.delivery.release.version, "v1.2.0");
  assert.deepEqual(plan.delivery.release.candidates, cand);
});

test("record-release requires version", () => {
  const item = baseItem({ phase: "release_ready", delivery: { protocolVersion: 1, mode: "manual", candidates: [{ repositoryId: "r", commit: "c" }] } });
  assert.throws(() => planDeliveryTransition(item, "record-release", {}, new Date()), /version/);
});

test("rework records a reason and rewinds to implementation or design", () => {
  const item = baseItem({ phase: "verification", delivery: { protocolVersion: 1, mode: "manual", candidates: [{ repositoryId: "r", commit: "c" }] } });
  assert.throws(() => planDeliveryTransition(item, "rework", {}, new Date()), /reason/);
  const impl = planDeliveryTransition(item, "rework", { reason: "实现缺陷 X", target: "implementation" }, new Date());
  assert.equal(impl.phase, "implementation");
  assert.equal(impl.delivery.designConfirmed, undefined);      // 下游证据失效
  assert.equal(impl.delivery.verification, undefined);
  const design = planDeliveryTransition(item, "rework", { reason: "方案不成立", target: "design" }, new Date());
  assert.equal(design.phase, "design");
});

test("block/unblock toggle status without touching phase; cancel terminal", () => {
  const item = baseItem({ phase: "implementation", status: "in_progress" });
  assert.equal(planDeliveryTransition(item, "block", { reason: "等环境" }, new Date()).status, "blocked");
  const b = planDeliveryTransition(baseItem({ phase: "implementation", status: "blocked" }), "unblock", {}, new Date());
  assert.equal(b.status, "in_progress");
  assert.equal(planDeliveryTransition(item, "cancel", { reason: "不做" }, new Date()).status, "cancelled");
});

test("released baseline rejects further flow actions except display ones", () => {
  const released = baseItem({ phase: "released", status: "done" });
  assert.throws(() => planDeliveryTransition(released, "start-development", {}, new Date()), /已发布|released/);
  assert.throws(() => planDeliveryTransition(released, "rework", { reason: "x" }, new Date()), /已发布|released/);
});

// answer-clarification（final-arch step-2 Task 4）：人工答复动作——确认/放行
// 同款「人的手」，刻意不做 LLM 工具。phase/status 一概不动（答复只是补全输入，
// 池谓词 awaiting-answer 解除后同阶段重新可领）；答案不可变（改主意 = agent
// 重新提问，不是改写历史）。
// 断言用 constructor.name 而非 instanceof：jiti moduleCache:false 双载下
// errors.ts 的类身份不唯一，类名跨载稳定（Conflict/NotFound 同名异类）。
test("answer-clarification writes answer/answeredAt, keeps phase and other entries untouched", () => {
  const item = baseItem({
    phase: "design",
    status: "in_progress",
    delivery: { protocolVersion: 1, mode: "manual", clarifications: [
      { id: "cl-1", role: "designer", question: "Q1?", askedAt: "2026-10-26T01:00:00Z", attemptId: "att-1" },
      { id: "cl-2", role: "designer", question: "Q2?", askedAt: "2026-10-26T01:05:00Z", attemptId: "att-2", answer: "已答", answeredAt: "2026-10-26T01:06:00Z" },
    ] },
  });
  const plan = planDeliveryTransition(item, "answer-clarification",
    { clarificationId: "cl-1", answer: "  个人开发者  " }, new Date("2026-10-26T02:00:00Z"));
  assert.equal(plan.phase, "design");                    // phase 不动
  assert.equal(plan.status, undefined);                  // status 不动（键省略）
  assert.equal(plan.eventType, "delivery.answered");
  assert.deepEqual(plan.eventData, { clarificationId: "cl-1", phase: "design" });
  assert.equal(plan.delivery.clarifications[0].answer, "个人开发者"); // trim 落盘
  assert.equal(plan.delivery.clarifications[0].answeredAt, "2026-10-26T02:00:00.000Z");
  assert.equal(plan.delivery.clarifications[0].question, "Q1?");      // 其余字段原样
  assert.equal(plan.delivery.clarifications[1].answer, "已答");       // 其他条目不触碰
  assert.equal(plan.delivery.clarifications[1].answeredAt, "2026-10-26T01:06:00Z");
});

test("answer-clarification guards: unknown id → Validation, already answered → Conflict, blank answer → Validation", () => {
  const isValidation = (error) =>
    error instanceof Error && error.constructor?.name === "WorkItemValidationError";
  const isConflict = (error) =>
    error instanceof Error && error.constructor?.name === "WorkItemConflictError";
  const answered = baseItem({ phase: "design", delivery: { protocolVersion: 1, mode: "manual", clarifications: [
    { id: "cl-1", role: "designer", question: "Q1?", askedAt: "t", attemptId: "a", answer: "已答", answeredAt: "t2" },
  ] } });
  const unanswered = baseItem({ phase: "design", delivery: { protocolVersion: 1, mode: "manual", clarifications: [
    { id: "cl-1", role: "designer", question: "Q1?", askedAt: "t", attemptId: "a" },
  ] } });
  assert.throws(
    () => planDeliveryTransition(answered, "answer-clarification",
      { clarificationId: "nope", answer: "x" }, new Date()),
    (error) => isValidation(error) && /clarification not found: nope/.test(error.message),
  );
  assert.throws(
    () => planDeliveryTransition(answered, "answer-clarification",
      { clarificationId: "cl-1", answer: "改主意" }, new Date()),
    (error) => isConflict(error) && /clarification already answered: cl-1/.test(error.message),
  );
  assert.throws(
    () => planDeliveryTransition(unanswered, "answer-clarification",
      { clarificationId: "cl-1", answer: "   " }, new Date()),
    (error) => isValidation(error) && /answer is required/.test(error.message),
  );
  assert.throws(
    () => planDeliveryTransition(unanswered, "answer-clarification",
      { answer: "x" }, new Date()),
    (error) => isValidation(error) && /clarificationId is required/.test(error.message),
  );
});

test("released baseline freezes answer-clarification too", () => {
  const released = baseItem({ phase: "released", status: "done", delivery: {
    protocolVersion: 1, mode: "manual",
    clarifications: [{ id: "cl-1", role: "designer", question: "Q1?", askedAt: "t", attemptId: "a" }],
  } });
  assert.throws(
    () => planDeliveryTransition(released, "answer-clarification",
      { clarificationId: "cl-1", answer: "x" }, new Date()),
    /已发布|released/,
  );
});

test("unblock on a released baseline restores done (never in_progress)", () => {
  const released = baseItem({ phase: "released", status: "done" });
  const blocked = planDeliveryTransition(released, "block", { reason: "等环境" }, new Date());
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.phase, "released");
  const unblocked = planDeliveryTransition(
    baseItem({ phase: "released", status: "blocked" }),
    "unblock", {}, new Date());
  assert.equal(unblocked.status, "done");
  assert.equal(unblocked.phase, "released");
});

test("unmanaged items have no legal delivery actions", () => {
  const item = baseItem();
  delete item.delivery;
  assert.deepEqual(legalDeliveryActions(item), []);
});

// answer-clarification 的合法性（legal-actions.ts，T4）：有未答条目即可答，
// blocked 也合法（人可能先 block 了项再答复；答复本身永不解阻——不会悄悄把
// 状态拉回 in_progress）；released 冻结、cancelled 无任何动作。动作条列表
// （legalActionBarActions）永不含它——答复由详情页的专属面板触发（Task 6），
// 问题全文在动作条无处展示。
const clarificationFixture = { id: "cl-1", role: "designer", question: "Q1?", askedAt: "t", attemptId: "a" };

test("legal actions: an unanswered clarification adds answer-clarification on open AND blocked items", () => {
  const open = baseItem({ phase: "design", status: "in_progress", delivery: {
    protocolVersion: 1, mode: "manual", clarifications: [clarificationFixture],
  } });
  assert.ok(legalDeliveryActions(open).includes("answer-clarification"));
  const blocked = baseItem({ phase: "design", status: "blocked", delivery: {
    protocolVersion: 1, mode: "manual", clarifications: [clarificationFixture],
  } });
  assert.deepEqual(legalDeliveryActions(blocked), ["unblock", "cancel", "answer-clarification"]);
});

test("legal actions: answered, released and cancelled items exclude answer-clarification", () => {
  const answered = baseItem({ phase: "design", status: "in_progress", delivery: {
    protocolVersion: 1, mode: "manual",
    clarifications: [{ ...clarificationFixture, answer: "已答", answeredAt: "t2" }],
  } });
  assert.equal(legalDeliveryActions(answered).includes("answer-clarification"), false);
  const released = baseItem({ phase: "released", status: "done", delivery: {
    protocolVersion: 1, mode: "manual", clarifications: [clarificationFixture],
  } });
  assert.equal(legalDeliveryActions(released).includes("answer-clarification"), false);
  // cancelled 的「拒绝」在合法性层（与 rework/block 等所有动作一致——
  // legalDeliveryActions 返回 []；apply 层对所有动作都无 cancelled 守卫，镜像现状）。
  const cancelled = baseItem({ status: "cancelled", phase: "design", delivery: {
    protocolVersion: 1, mode: "manual", clarifications: [clarificationFixture],
  } });
  assert.deepEqual(legalDeliveryActions(cancelled), []);
});

test("answer-clarification never appears in the action-bar projection", () => {
  for (const status of ["open", "in_progress", "blocked"]) {
    const item = baseItem({ phase: "design", status, delivery: {
      protocolVersion: 1, mode: "manual", clarifications: [clarificationFixture],
    } });
    assert.equal(
      legalActionBarActions(item).includes("answer-clarification"),
      false,
      `action bar excludes answer-clarification for status ${status}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Integration: applyDeliveryAction + service gates (real temp workspace).

async function integrationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-delivery-"));
  const previous = process.env.PI_WORKSPACES_DIR;
  const previousIndex = process.env.PI_WORKSPACE_INDEX_FILE;
  process.env.PI_WORKSPACES_DIR = root;
  process.env.PI_WORKSPACE_INDEX_FILE = join(root, ".pi", "workspace.yaml");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WORKSPACES_DIR;
    else process.env.PI_WORKSPACES_DIR = previous;
    if (previousIndex === undefined) delete process.env.PI_WORKSPACE_INDEX_FILE;
    else process.env.PI_WORKSPACE_INDEX_FILE = previousIndex;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const workspace = await workspaceService.createWorkspace({
    name: "Delivery",
    slug: "delivery",
    capabilities: ["work-items"],
  }, root);
  return { workspaceId: workspace.id };
}

async function createFlowItem(workspaceId, title = "Flow") {
  // createWorkItem 返回 { detail, importOutcome }（M2 Task 4 导入去重）——
  // 交付流程用例只关心 detail。
  const { detail } = await itemService.createWorkItem(workspaceId, {
    type: "requirement",
    title,
    originalDescription: "The original requirement text.",
    enableDelivery: true,
  });
  return detail;
}

test("applyDeliveryAction walks the flow, seeds design.md and replays idempotently", async (t) => {
  const { workspaceId } = await integrationFixture(t);
  const created = await createFlowItem(workspaceId);
  const key = created.item.key;

  // Unmanaged items reject flow actions outright.
  const { detail: plain } = await itemService.createWorkItem(workspaceId, {
    type: "bug", title: "Plain", originalDescription: "no flow",
  });
  await assert.rejects(
    deliveryNative.applyDeliveryAction({
      workspaceId, key: plain.item.key, action: "start-design",
      expectedRevision: 1, requestId: "r-plain",
    }),
    WorkItemValidationError,
  );

  const step = await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "start-design", expectedRevision: 1, requestId: "req-1",
  });
  assert.equal(step.replayed, false);
  assert.equal(step.detail.item.phase, "design");
  assert.equal(step.detail.item.status, "in_progress");
  const design = await deliveryNative.readDesign(workspaceId, key);
  assert.match(design.content, /^# 设计：Flow/);
  assert.equal(design.digest.length, 64);

  // Replay: same requestId+action returns the current detail WITHOUT bumping
  // the revision or appending another event.
  const replay = await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "start-design", expectedRevision: 1, requestId: "req-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.detail.item.revision, 2);
  assert.equal(replay.detail.events.length, step.detail.events.length);

  // Stale expectedRevision → conflict.
  await assert.rejects(
    deliveryNative.applyDeliveryAction({
      workspaceId, key, action: "confirm-design", expectedRevision: 1, requestId: "req-stale",
    }),
    WorkItemConflictError,
  );

  // confirm-design with the seeded (non-empty) design.md.
  const confirmed = await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "confirm-design", expectedRevision: 2, requestId: "req-2",
  });
  assert.equal(confirmed.detail.item.phase, "ready_for_implementation");
  assert.ok(confirmed.detail.item.delivery.designConfirmed.requirementDigest.length === 64);
  assert.ok(confirmed.detail.item.delivery.lastRequest.requestId === "req-2");

  // Requirement change after confirmation → invalidation back to design.
  const invalidated = await itemService.updateWorkItemContent(workspaceId, key, {
    expectedRevision: confirmed.detail.item.revision,
    content: created.content.replace("## Agent Analysis", "## Agent Analysis\n\nNew analysis."),
  });
  assert.equal(invalidated.item.phase, "design");
  assert.equal(invalidated.item.delivery.designConfirmed, undefined);
  const invalidationEvent = invalidated.events.find((event) => event.type === "delivery.invalidated");
  assert.ok(invalidationEvent, "delivery.invalidated event appended");
  assert.equal(invalidationEvent.data.reason, "requirement-changed");
});

test("generic PATCH cannot move managed phase/status; released freezes repositories/loop", async (t) => {
  const { workspaceId } = await integrationFixture(t);
  const created = await createFlowItem(workspaceId, "Frozen");
  const key = created.item.key;

  await assert.rejects(
    itemService.updateWorkItem(workspaceId, key, { expectedRevision: 1, status: "in_progress" }),
    /Standard-flow items/,
  );
  await assert.rejects(
    itemService.updateWorkItem(workspaceId, key, { expectedRevision: 1, phase: "design" }),
    /Standard-flow/,
  );
  // Display fields still patch fine on managed items.
  const tagged = await itemService.updateWorkItem(workspaceId, key, { expectedRevision: 1, tags: ["ui"] });
  assert.deepEqual(tagged.item.tags, ["ui"]);

  // Walk to released, then assert the freeze.
  const walk = [
    ["start-design", 2, {}],
    ["confirm-design", 3, {}],
    ["start-development", 4, {}],
    ["submit-verification", 5, { candidates: [{ repositoryId: "r1", commit: "abc123" }] }],
    ["record-verification", 6, { checks: [{ name: "回归", outcome: "passed" }] }],
    ["record-release", 7, { version: "v1.0.0" }],
  ];
  let revision = 2;
  let detail;
  for (const [action, expectedRevision, payload] of walk) {
    assert.equal(expectedRevision, revision, `walk setup intact at ${action}`);
    detail = await deliveryNative.applyDeliveryAction({
      workspaceId, key, action, expectedRevision, requestId: `walk-${action}`, payload,
    });
    revision = detail.detail.item.revision;
  }
  assert.equal(detail.detail.item.phase, "released");
  assert.equal(detail.detail.item.status, "done");
  assert.equal(detail.detail.item.delivery.release.version, "v1.0.0");

  await assert.rejects(
    itemService.updateWorkItem(workspaceId, key, { expectedRevision: revision, repositories: [] }),
    /Released baseline is frozen/,
  );
  await assert.rejects(
    itemService.updateWorkItem(workspaceId, key, { expectedRevision: revision, loop: "dev-loop" }),
    /Released baseline is frozen/,
  );
  await assert.rejects(
    deliveryNative.applyDeliveryAction({
      workspaceId, key, action: "rework", expectedRevision: revision,
      requestId: "after-release", payload: { reason: "x" },
    }),
    /已发布/,
  );
});

test("updateDesignContent edits design.md; a diverging confirmed design invalidates", async (t) => {
  const { workspaceId } = await integrationFixture(t);
  const created = await createFlowItem(workspaceId, "DesignEdit");
  const key = created.item.key;

  // Design route 404s before start-design seeds the file.
  await assert.rejects(
    () => deliveryNative.readDesign(workspaceId, key),
    (error) => error.code === "ENOENT" || /Design document not found/.test(error.message),
  );

  await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "start-design", expectedRevision: 1, requestId: "d-1",
  });
  // Unconfirmed design edit: plain content update, revision bump, no invalidation.
  const edited = await deliveryNative.updateDesignContent(workspaceId, key, {
    expectedRevision: 2, content: "# 设计：DesignEdit\n\n## 方案\n\n新的方案\n",
  });
  assert.equal(edited.item.revision, 3);
  assert.equal(edited.item.phase, "design");
  assert.equal(
    (await deliveryNative.readDesign(workspaceId, key)).content,
    "# 设计：DesignEdit\n\n## 方案\n\n新的方案\n",
  );

  const confirmed = await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "confirm-design", expectedRevision: 3, requestId: "d-2",
  });
  assert.equal(confirmed.detail.item.phase, "ready_for_implementation");

  // Diverging edit after confirmation → same invalidation as a requirement change.
  const invalidated = await deliveryNative.updateDesignContent(workspaceId, key, {
    expectedRevision: confirmed.detail.item.revision,
    content: "# 设计：DesignEdit\n\n## 方案\n\n推翻重来的方案\n",
  });
  assert.equal(invalidated.item.phase, "design");
  assert.equal(invalidated.item.delivery.designConfirmed, undefined);
  const event = invalidated.events.find((entry) => entry.type === "delivery.invalidated");
  assert.equal(event.data.reason, "design-changed");
});

// --- answer-clarification 集成（final-arch step-2 Task 4）---
// 澄清条目直接写 item.yaml（T2 的 askHumanQuestion 需要活跃 claim 凭据——
// 这里测的是答复事务，fixture 走 store helpers 最短路径）。池门断言用纯投影
// projectDeliveryPool（pool.ts 导出）：答前 awaiting-answer 在场、答后消失。

async function addUnansweredClarification(workspaceId, key, entry = {}) {
  const { path: workspacePath } = await workspaceService.getWorkspace(workspaceId);
  const current = await itemService.readWorkItem(workspacePath, key);
  const next = structuredClone(current.item);
  next.delivery = {
    ...next.delivery,
    clarifications: [
      ...(next.delivery.clarifications ?? []),
      {
        id: "cl-1", role: "designer", question: "第一批目标用户是谁？",
        askedAt: "2026-10-26T01:00:00Z", attemptId: "att-1", ...entry,
      },
    ],
  };
  next.revision += 1;
  next.updatedAt = "2026-10-26T01:00:00Z";
  await itemService.writeAtomic(join(current.path, "item.yaml"), itemService.serializeWorkItem(next));
  return itemService.readWorkItem(workspacePath, key);
}

function poolReasonsFor(record) {
  const entries = projectDeliveryPool([{
    key: record.key, title: record.title, priority: record.priority,
    status: record.status, phase: record.phase, archivedAt: record.archivedAt,
    repositories: record.repositories, requirementDigest: "",
    delivery: record.delivery ?? null,
  }], {
    enabled: true, activeClaims: new Set(), pendingInterruptions: new Set(),
    paused: new Set(), failureCountByKey: new Map(), maxAttemptsPerInput: 3,
    registeredRepos: new Map(),
  });
  return entries[0].reasons;
}

test("applyDeliveryAction answers a clarification: answer persisted, phase/status untouched, pool gate clears, replay idempotent", async (t) => {
  const { workspaceId } = await integrationFixture(t);
  const created = await createFlowItem(workspaceId);
  const key = created.item.key;

  await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "start-design", expectedRevision: 1, requestId: "ac-0",
  });
  const asked = await addUnansweredClarification(workspaceId, key);
  assert.equal(asked.item.revision, 3);
  assert.ok(poolReasonsFor(asked.item).includes("awaiting-answer"), "unanswered entry parks the item");

  const outcome = await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "answer-clarification", expectedRevision: 3, requestId: "ac-1",
    payload: { clarificationId: "cl-1", answer: "个人开发者" },
  });
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.detail.item.revision, 4);                    // revision+1
  assert.equal(outcome.detail.item.phase, "design");                // phase 不动
  assert.equal(outcome.detail.item.status, "in_progress");          // status 不动
  const answered = outcome.detail.item.delivery.clarifications[0];
  assert.equal(answered.answer, "个人开发者");
  assert.ok(answered.answeredAt, "answeredAt recorded");
  assert.equal(outcome.detail.item.delivery.lastRequest.action, "answer-clarification");

  const event = outcome.detail.events.find((entry) => entry.type === "delivery.answered");
  assert.ok(event, "delivery.answered appended");
  assert.equal(event.actor, "user");
  assert.equal(event.data.clarificationId, "cl-1");
  assert.equal(event.data.revision, 4);

  // 答复即恢复：awaiting-answer 消失，项回到同 phase 的可领投影。
  assert.equal(poolReasonsFor(outcome.detail.item).includes("awaiting-answer"), false);

  // requestId 重放：现态直返，不 bump 不追加。
  const replay = await deliveryNative.applyDeliveryAction({
    workspaceId, key, action: "answer-clarification", expectedRevision: 3, requestId: "ac-1",
    payload: { clarificationId: "cl-1", answer: "个人开发者" },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.detail.item.revision, 4);
  assert.equal(replay.detail.events.length, outcome.detail.events.length);

  // 已答条目不可再答（答案不可变——改主意是 agent 的新问题，不是改写历史）。
  await assert.rejects(
    deliveryNative.applyDeliveryAction({
      workspaceId, key, action: "answer-clarification", expectedRevision: 4, requestId: "ac-2",
      payload: { clarificationId: "cl-1", answer: "改主意" },
    }),
    WorkItemConflictError,
  );

  // 不存在的条目 → Validation（400）。
  await assert.rejects(
    deliveryNative.applyDeliveryAction({
      workspaceId, key, action: "answer-clarification", expectedRevision: 4, requestId: "ac-3",
      payload: { clarificationId: "cl-missing", answer: "x" },
    }),
    WorkItemValidationError,
  );
});

// final-arch step-3 T2：共享返工过渡（reworkTransition）——「回退 + 清全部下游
// 证据」的唯一实现（claim.ts verifier 失败路径 / reviewer 打回 / M2 人工 rework
// 三处共用同一份「清什么」清单，无第二副本）。纯函数：返回调用方需施加的
// {phase, status, delivery}，不改传入对象（M2 case 是纯 plan 组装、claim 侧
// 由调用方 structuredClone 后施加）。
test("reworkTransition returns the landing fields and clears all downstream evidence", () => {
  const { reworkTransition } = deliveryNative;
  const item = baseItem({
    phase: "verification",
    delivery: {
      protocolVersion: 1, mode: "manual",
      designConfirmed: { at: "t", actor: "user" },
      candidates: [{ repositoryId: "r", commit: "c" }],
      verification: { candidateDigest: "d" },
      releasePlan: { notes: "n" },
      review: { outcome: "rework", source: "code", notes: "缺什么", candidateDigest: "d", at: "t", attemptId: "a" },
    },
  });
  const next = structuredClone(item);
  const transition = reworkTransition(next, "implementation", "open");
  assert.equal(transition.phase, "ready_for_implementation", "agent rework lands at the developer-ready phase");
  assert.equal(transition.status, "open");
  assert.equal(transition.delivery.designConfirmed, undefined);
  assert.equal(transition.delivery.candidates, undefined);
  assert.equal(transition.delivery.verification, undefined);
  assert.equal(transition.delivery.releasePlan, undefined);
  assert.ok(transition.delivery.review, "review verdict survives (人要看为什么打回)");

  assert.equal(reworkTransition(next, "design", "open").phase, "design");
  // M2 人工路径落点（显式 implementation 阶段 + in_progress——历史语义，测试钉死）。
  const human = reworkTransition(next, "implementation", "in_progress", "implementation");
  assert.equal(human.phase, "implementation");
  assert.equal(human.status, "in_progress");

  // 纯函数：不改传入对象。
  assert.equal(next.phase, "verification");
  assert.equal(next.delivery.candidates.length, 1);
  assert.ok(next.delivery.designConfirmed);
});

test("delivery rework case is wired through the shared reworkTransition (source assertion)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./delivery.ts", import.meta.url), "utf8");
  const caseBody = source.slice(
    source.indexOf('case "rework":'),
    source.indexOf('case "block":'),
  );
  assert.ok(caseBody.includes("reworkTransition("), "the rework case must use the shared transition");
});
