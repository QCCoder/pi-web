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
import { WorkItemConflictError, WorkItemValidationError } from "./errors.ts";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const delivery = await jiti.import("./delivery.ts");
const { planDeliveryTransition, legalDeliveryActions } = delivery;

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

test("unmanaged items have no legal delivery actions", () => {
  const item = baseItem();
  delete item.delivery;
  assert.deepEqual(legalDeliveryActions(item), []);
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
  return itemService.createWorkItem(workspaceId, {
    type: "requirement",
    title,
    originalDescription: "The original requirement text.",
    enableDelivery: true,
  });
}

test("applyDeliveryAction walks the flow, seeds design.md and replays idempotently", async (t) => {
  const { workspaceId } = await integrationFixture(t);
  const created = await createFlowItem(workspaceId);
  const key = created.item.key;

  // Unmanaged items reject flow actions outright.
  const plain = await itemService.createWorkItem(workspaceId, {
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
