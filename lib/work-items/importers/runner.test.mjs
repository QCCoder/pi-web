import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runImporterForWorkspace } from "./runner.ts";
import { createWorkspace } from "../../workspaces/service.ts";
import { listWorkItems, readWorkItem, updateWorkItem } from "../service.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-importer-"));
  const previous = process.env.PI_WORKSPACES_DIR;
  const previousIndex = process.env.PI_WORKSPACE_INDEX_FILE;
  process.env.PI_WORKSPACES_DIR = root;
  process.env.PI_WORKSPACE_INDEX_FILE = join(root, ".pi", "workspace.yaml");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WORKSPACES_DIR;
    else process.env.PI_WORKSPACES_DIR = previous;
    if (previousIndex === undefined) delete process.env.PI_WORKSPACE_INDEX_FILE;
    else process.env.PI_WORKSPACE_INDEX_FILE = previousIndex;
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createWorkspace(
    { name: "Imp", slug: "imp", capabilities: ["work-items"] },
    root,
  );
  return { root, workspace };
}

/** A mock Importer with canned Chandao-shaped data (bug with an image, task without). */
function mockImporter(items) {
  return {
    kind: "chandao",
    async listAssigned() { return items.map((i) => ({ sourceId: i.sourceId, kind: i.kind, title: i.title, url: i.url })); },
    async getDetail(sourceId) {
      const i = items.find((x) => x.sourceId === sourceId);
      return { sourceId, kind: i.kind, title: i.title, body: i.body, url: i.url };
    },
    async getAttachment() { return { bytes: PNG, ext: "png" }; },
  };
}

test("creates bug+task work items, localizes images, stamps external", async (t) => {
  const { workspace } = await fixture(t);
  const importer = mockImporter([
    { sourceId: "50", kind: "bug", title: "Login blank", url: "https://c/bug-50", body: 'see <img src="/index.php?m=file&f=read&fileID=507">' },
    { sourceId: "3", kind: "task", title: "Add export", url: "https://c/task-3", body: "no images here" },
  ]);

  const summary = await runImporterForWorkspace(workspace.id, importer, { now: () => new Date("2025-06-01T00:00:00Z") });
  assert.equal(summary.created, 2);
  assert.equal(summary.errors, 0);

  // bug -> BUG-0001, task -> REQ-0001
  const bug = await readWorkItem(workspace.path, "BUG-0001");
  assert.equal(bug.item.title, "Login blank");
  assert.equal(bug.item.external.source, "chandao");
  assert.equal(bug.item.external.sourceId, "50");
  assert.equal(bug.item.external.url, "https://c/bug-50");
  assert.equal(bug.item.external.lastSyncedAt, "2025-06-01T00:00:00.000Z");

  // image localized in README Original Description
  assert.match(bug.content, /attachments\/chandao-507\.png/);
  assert.doesNotMatch(bug.content, /fileID=507/);

  // image file persisted
  const image = await readFile(join(bug.path, "attachments", "chandao-507.png"));
  assert.equal(image[0], 0x89); // PNG magic

  const task = await readWorkItem(workspace.path, "REQ-0001");
  assert.equal(task.item.title, "Add export");
  assert.equal(task.item.external.sourceId, "3");

  // imported milestone recorded
  assert.ok(bug.events.some((e) => e.type === "imported" && e.data?.action === "created"));
});

test("second run is idempotent: no new items, all synced", async (t) => {
  const { workspace } = await fixture(t);
  const importer = mockImporter([
    { sourceId: "50", kind: "bug", title: "Login blank", url: "u1", body: "b1" },
    { sourceId: "3", kind: "task", title: "Add export", url: "u2", body: "b2" },
  ]);

  const first = await runImporterForWorkspace(workspace.id, importer);
  assert.equal(first.created, 2);
  const second = await runImporterForWorkspace(workspace.id, importer);
  assert.equal(second.created, 0);
  assert.equal(second.synced, 2);
  assert.equal(second.errors, 0);

  // still only two work items
  const { items } = await listWorkItems(workspace.path);
  assert.equal(items.length, 2);
  // a no-op sync must NOT pollute the timeline: only the one-time
  // `imported:created` provenance row from the first run should exist — no
  // `synced` heartbeat is appended on a nothing-changed re-sync.
  const bug = await readWorkItem(workspace.path, "BUG-0001");
  assert.equal(bug.events.filter((e) => e.type === "imported").length, 1);
  assert.ok(bug.events.every((e) => !(e.type === "imported" && e.data?.action === "synced")));
});

test("archived work items are skipped on re-import", async (t) => {
  const { workspace } = await fixture(t);
  const importer = mockImporter([
    { sourceId: "50", kind: "bug", title: "Login blank", url: "u1", body: "b1" },
  ]);
  const first = await runImporterForWorkspace(workspace.id, importer);
  assert.equal(first.created, 1);

  // archive the imported item
  const bug = await readWorkItem(workspace.path, "BUG-0001");
  await updateWorkItem(workspace.id, "BUG-0001", { expectedRevision: bug.item.revision, archived: true });

  const second = await runImporterForWorkspace(workspace.id, importer);
  assert.equal(second.created, 0);
  assert.equal(second.synced, 0);
  assert.equal(second.skipped, 1);
});

test("empty source description gets a traceable placeholder (not dropped)", async (t) => {
  const { workspace } = await fixture(t);
  const importer = mockImporter([
    { sourceId: "168", kind: "task", title: "Empty desc task", url: "u", body: "" },
  ]);
  const summary = await runImporterForWorkspace(workspace.id, importer);
  assert.equal(summary.created, 1);
  assert.equal(summary.errors, 0);
  const task = await readWorkItem(workspace.path, "REQ-0001");
  assert.match(task.content, /来源描述为空/);
  assert.equal(task.item.external.sourceId, "168");
});

test("a failing item is recorded as error without aborting the run", async (t) => {
  const { workspace } = await fixture(t);
  const importer = {
    kind: "chandao",
    async listAssigned() { return [{ sourceId: "50", kind: "bug", title: "x" }, { sourceId: "3", kind: "task", title: "y" }]; },
    async getDetail(sourceId) {
      if (sourceId === "50") throw new Error("boom");
      return { sourceId, kind: "task", title: "y", body: "ok" };
    },
    async getAttachment() { return { bytes: PNG, ext: "png" }; },
  };
  const summary = await runImporterForWorkspace(workspace.id, importer);
  assert.equal(summary.errors, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.details.find((d) => d.sourceId === "50").action, "error");
});
