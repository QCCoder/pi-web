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

function recordingExporter(kind, log) {
  return {
    kind,
    async onWorkItemEvent(_ctx, event, _item) { log.push({ kind, id: event.id }); },
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
  const sel = selectEventsSince(snaps, null);
  assert.equal(sel.length, 2);
});

test("selectEventsSince: dedups the same event id across snapshots", () => {
  const i = item("REQ-0001");
  const snaps = [{ item: i, events: [{ id: "01ZZZ", at: "x", type: "t", actor: "a" }] }, { item: i, events: [{ id: "01ZZZ", at: "x", type: "t", actor: "a" }] }];
  assert.equal(selectEventsSince(snaps, null).length, 1);
});

test("dispatchWorkspaceEvents: no exporters => dispatched 0, watermark unchanged", async () => {
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const summary = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [], snaps, null);
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.lastEventId, null);
});

test("dispatchWorkspaceEvents: hands each new event to each exporter, advances watermark", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA", "01BBB"]), snapshot("BUG-0002", ["01CCC"])];
  const summary = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [recordingExporter("a", log)], snaps, "01AAA");
  assert.equal(summary.dispatched, 2);
  assert.equal(summary.lastEventId, "01CCC");
  assert.deepEqual(log.map((e) => e.id), ["01BBB", "01CCC"]);
});

test("dispatchWorkspaceEvents: a throwing exporter is counted but does not stop others or advance loss", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const summary = await dispatchWorkspaceEvents(
    { workspaceId: "ws" },
    [throwingExporter("bad"), recordingExporter("good", log)],
    snaps,
    null,
  );
  assert.equal(summary.dispatched, 1);
  assert.equal(summary.errors.bad, 1);
  assert.equal(log.length, 1);
});

test("dispatchWorkspaceEvents: idempotent — re-running with the new watermark dispatches nothing", async () => {
  const log = [];
  const snaps = [snapshot("REQ-0001", ["01AAA"])];
  const first = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [recordingExporter("a", log)], snaps, null);
  const second = await dispatchWorkspaceEvents({ workspaceId: "ws" }, [recordingExporter("a", log)], snaps, first.lastEventId);
  assert.equal(second.dispatched, 0);
  assert.equal(log.length, 1);
});
