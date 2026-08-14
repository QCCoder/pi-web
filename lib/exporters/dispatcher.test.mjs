import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { selectEventsSince, dispatchWorkspaceEvents } = await jiti.import("./dispatcher.ts");

function item(key, overrides = {}) {
  return {
    schemaVersion: 1, id: `id-${key}`, key, revision: 1, type: key.startsWith("BUG") ? "bug" : "requirement",
    title: key, status: "in_progress", phase: "implementation", priority: "P2", repositories: [], tags: [],
    conversations: [], relatedItems: [], designs: [], plans: [], archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

function snapshot(key, ids) {
  return {
    item: item(key),
    events: ids.map((id) => ({ id, at: "2026-01-01T00:00:00.000Z", type: "work_item.updated", actor: "agent" })),
  };
}

/** delivered: true — records every call so we can assert failover short-circuit. */
function deliveringExporter(kind, log) {
  return {
    kind,
    async onWorkItemEvent(_ctx, event) { log.push({ kind, id: event.id }); return { delivered: true }; },
  };
}

function skippingExporter(kind, log) {
  return {
    kind,
    async onWorkItemEvent(_ctx, event) { log.push({ kind, id: event.id }); return { delivered: false, skipped: true }; },
  };
}

function failingExporter(kind, log) {
  return {
    kind,
    async onWorkItemEvent(_ctx, event) { log.push({ kind, id: event.id }); return { delivered: false, error: "boom" }; },
  };
}

function throwingExporter(kind) {
  return {
    kind,
    async onWorkItemEvent() { throw new Error("boom"); },
  };
}

test("selectEventsSince: returns events strictly after watermark, sorted by id", () => {
  const snaps = [snapshot("REQ-0001", ["01AAA", "01CCC"]), snapshot("BUG-0002", ["01BBB"])];
  const sel = selectEventsSince(snaps, "01AAA");
  assert.deepEqual(sel.map((s) => s.event.id), ["01BBB", "01CCC"]);
});

test("selectEventsSince: null watermark selects everything", () => {
  const snaps = [snapshot("REQ-0001", ["01AAA", "01BBB"])];
  assert.equal(selectEventsSince(snaps, null).length, 2);
});

test("selectEventsSince: dedups the same event id across snapshots", () => {
  const i = item("REQ-0001");
  const snaps = [{ item: i, events: [{ id: "01ZZZ", at: "x", type: "t", actor: "a" }] }, { item: i, events: [{ id: "01ZZZ", at: "x", type: "t", actor: "a" }] }];
  assert.equal(selectEventsSince(snaps, null).length, 1);
});

test("dispatch: no exporters => nothing counted, watermark unchanged", async () => {
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const summary = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [], snaps, null);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.lastEventId, null);
});

test("dispatch (all): hands each new event to every exporter, advances watermark", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA", "01BBB"]), snapshot("BUG-0002", ["01CCC"])];
  const summary = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [deliveringExporter("a", log)], snaps, "01AAA", "all");
  assert.equal(summary.delivered, 2);
  assert.equal(summary.lastEventId, "01CCC");
  assert.deepEqual(log.map((e) => e.id), ["01BBB", "01CCC"]);
});

test("dispatch (all): a throwing exporter is counted but does not stop others", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const summary = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [throwingExporter("bad"), deliveringExporter("good", log)],
    snaps, null, "all",
  );
  assert.equal(summary.delivered, 1);
  assert.equal(summary.errors.bad, 1);
  assert.equal(log.length, 1);
});

test("dispatch (failover): stops at first delivered channel (backup not called)", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const summary = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [deliveringExporter("primary", log), deliveringExporter("backup", log)],
    snaps, null, "failover",
  );
  assert.equal(summary.delivered, 1);
  assert.deepEqual(log.map((e) => e.kind), ["primary"]); // backup never called
});

test("dispatch (failover): primary error => falls back to backup, primary counted", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const summary = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [failingExporter("primary", log), deliveringExporter("backup", log)],
    snaps, null, "failover",
  );
  assert.equal(summary.delivered, 1);
  assert.equal(summary.errors.primary, 1);
  assert.deepEqual(log.map((e) => e.kind), ["primary", "backup"]); // both tried
});

test("dispatch: all channels skip => counted as skipped, watermark advances", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA", "01BBB"])];
  const summary = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [skippingExporter("a", log), skippingExporter("b", log)],
    snaps, null, "failover",
  );
  assert.equal(summary.delivered, 0);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.retried, 0);
  assert.equal(summary.lastEventId, "01BBB"); // advanced — skipped is settled
});

test("dispatch: all channels error => held for retry, watermark NOT advanced (head-of-line)", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA", "01BBB"])];
  const summary = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [failingExporter("a", log)],
    snaps, null, "failover",
  );
  assert.equal(summary.delivered, 0);
  assert.equal(summary.retried, 1); // first event held; second never processed
  assert.equal(summary.lastEventId, null); // not advanced
  assert.equal(log.length, 1); // only first event attempted
});

test("dispatch: held event retries on the next tick without re-sending settled ones", async () => {
  // Tick 1: one delivered event then a failing one (head-of-line block at second).
  const snaps = [snapshot("REQ-0001", ["01AAA", "01BBB", "01CCC"])];
  const tick1 = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [
      { kind: "ok", async onWorkItemEvent(_c, e) { return e.id === "01AAA" ? { delivered: true } : { delivered: false, error: "x" }; } },
    ],
    snaps, null, "failover",
  );
  assert.equal(tick1.delivered, 1);
  assert.equal(tick1.retried, 1);
  assert.equal(tick1.lastEventId, "01AAA"); // advanced only past the delivered one

  // Tick 2: resume after 01AAA; the failing 01BBB now delivers, then 01CCC.
  const tick2 = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [deliveringExporter("ok", [])],
    snaps, tick1.lastEventId, "failover",
  );
  assert.equal(tick2.delivered, 2); // 01BBB + 01CCC, no duplicates
  assert.equal(tick2.lastEventId, "01CCC");
});

test("dispatch: idempotent — re-running with the new watermark dispatches nothing", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const first = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [deliveringExporter("a", log)], snaps, null, "all");
  const second = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [deliveringExporter("a", log)], snaps, first.lastEventId, "all");
  assert.equal(second.delivered, 0);
  assert.equal(log.length, 1);
});
