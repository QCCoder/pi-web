import assert from "node:assert/strict";
import test from "node:test";
import { buildExternalIndex, externalKey, mapSourceKindToWorkItemType } from "./mapping.ts";

test("mapSourceKindToWorkItemType maps bug->bug, task->requirement", () => {
  assert.equal(mapSourceKindToWorkItemType("bug"), "bug");
  assert.equal(mapSourceKindToWorkItemType("task"), "requirement");
});

test("externalKey joins source and sourceId", () => {
  assert.equal(externalKey("chandao", "50"), "chandao:50");
});

test("buildExternalIndex indexes items with external, skips the rest", () => {
  /** @type {import("../work-items/types.ts").WorkItemRecord[]} */
  const items = [
    { external: { source: "chandao", sourceId: "50", lastSyncedAt: "t1" } },
    { external: { source: "chandao", sourceId: "3", url: "u", lastSyncedAt: "t2" } },
    { /* manually created, no external */ },
    { external: { source: "jira", sourceId: "50", lastSyncedAt: "t3" } },
  ];
  const index = buildExternalIndex(items);
  assert.equal(index.size, 3);
  assert.equal(index.get("chandao:50")?.external?.lastSyncedAt, "t1");
  assert.equal(index.get("chandao:3")?.external?.url, "u");
  assert.equal(index.get("jira:50")?.external?.source, "jira");
  assert.equal(index.get("manual:x"), undefined);
});
