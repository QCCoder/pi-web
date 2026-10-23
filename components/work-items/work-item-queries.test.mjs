import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
  jsx: { runtime: "automatic" },
});
const queries = await jiti.import("./work-item-queries.ts");

const { defaultWorkItemFilters, parseStoredWorkItemFilters, filterWorkItems, sortWorkItems } = queries;

function item(overrides) {
  return {
    schemaVersion: 1,
    id: "id-1",
    key: "REQ-0001",
    revision: 1,
    type: "requirement",
    title: "Sample item",
    status: "open",
    phase: "intake",
    priority: "P2",
    repositories: [],
    tags: [],
    conversations: [],
    relatedItems: [],
    designs: [],
    plans: [],
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

test("sortWorkItems: P0→P3 first, updatedAt desc within a priority, key as the stable tiebreak", () => {
  const sorted = sortWorkItems([
    item({ key: "REQ-0002", priority: "P1", updatedAt: "2026-10-03T00:00:00.000Z" }),
    item({ key: "REQ-0003", priority: "P0", updatedAt: "2026-10-01T00:00:00.000Z" }),
    item({ key: "REQ-0001", priority: "P1", updatedAt: "2026-10-05T00:00:00.000Z" }),
    item({ key: "REQ-0004", priority: "P1", updatedAt: "2026-10-05T00:00:00.000Z" }),
    item({ key: "BUG-0001", priority: "P3", updatedAt: "2026-10-09T00:00:00.000Z" }),
  ]);
  assert.deepEqual(sorted.map((i) => i.key), ["REQ-0003", "REQ-0001", "REQ-0004", "REQ-0002", "BUG-0001"]);
});

test("sortWorkItems: returns a copy, never mutates the input", () => {
  const input = [
    item({ key: "REQ-0002", priority: "P2" }),
    item({ key: "REQ-0001", priority: "P1" }),
  ];
  const sorted = sortWorkItems(input);
  assert.deepEqual(input.map((i) => i.key), ["REQ-0002", "REQ-0001"]);
  assert.deepEqual(sorted.map((i) => i.key), ["REQ-0001", "REQ-0002"]);
});

test("default filters keep every item", () => {
  const items = [
    item({ key: "REQ-0001" }),
    item({ key: "BUG-0001", type: "bug", external: { source: "chandao", sourceId: "9", lastSyncedAt: "2026-10-01T00:00:00.000Z" } }),
  ];
  assert.equal(filterWorkItems(items, defaultWorkItemFilters()).length, 2);
});

test("filterWorkItems: search matches key or title case-insensitively", () => {
  const items = [
    item({ key: "REQ-0001", title: "修复登录" }),
    item({ key: "BUG-0002", title: "REQ parser crash" }),
    item({ key: "REQ-0003", title: "别的" }),
  ];
  const filters = { ...defaultWorkItemFilters(), search: "req" };
  assert.deepEqual(filterWorkItems(items, filters).map((i) => i.key), ["REQ-0001", "BUG-0002", "REQ-0003"]);
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), search: "登录" }).map((i) => i.key),
    ["REQ-0001"],
  );
  // 仅空白 = 无搜索条件
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), search: "  " }).length, 3,
  );
});

test("filterWorkItems: type / phase / priority / source predicates", () => {
  const items = [
    item({ key: "REQ-0001" }),
    item({ key: "BUG-0001", type: "bug", phase: "implementation", priority: "P0" }),
    item({
      key: "REQ-0002",
      phase: "analysis",
      external: { source: "chandao", sourceId: "9", lastSyncedAt: "2026-10-01T00:00:00.000Z" },
    }),
  ];
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), type: "bug" }).map((i) => i.key),
    ["BUG-0001"],
  );
  // 阶段筛选按原始 phase 精确匹配（看板投影只影响列，不影响筛选）
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), phase: "analysis" }).map((i) => i.key),
    ["REQ-0002"],
  );
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), priority: "P0" }).map((i) => i.key),
    ["BUG-0001"],
  );
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), source: "chandao" }).map((i) => i.key),
    ["REQ-0002"],
  );
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), source: "manual" }).map((i) => i.key),
    ["REQ-0001", "BUG-0001"],
  );
});

test("filterWorkItems: flaggedOnly keeps blocked items and items awaiting approval", () => {
  const items = [
    item({ key: "REQ-0001" }),
    item({ key: "REQ-0002", status: "blocked" }),
    item({ key: "REQ-0003", phase: "requirement_approval" }),
    item({ key: "REQ-0004", phase: "plan_approval" }),
    item({ key: "REQ-0005", phase: "verification" }),
  ];
  assert.deepEqual(
    filterWorkItems(items, { ...defaultWorkItemFilters(), flaggedOnly: true }).map((i) => i.key),
    ["REQ-0002", "REQ-0003", "REQ-0004"],
  );
});

test("parseStoredWorkItemFilters: valid JSON hydrates, garbage falls back to defaults", () => {
  const filters = { ...defaultWorkItemFilters(), type: "bug", scope: "archived" };
  assert.deepEqual(parseStoredWorkItemFilters(JSON.stringify(filters)), filters);
  assert.deepEqual(parseStoredWorkItemFilters("not json"), defaultWorkItemFilters());
  assert.deepEqual(parseStoredWorkItemFilters(null), defaultWorkItemFilters());
  // 未知枚举值按默认处理（老版本存储 / 手改 localStorage）——"trash" 自 T9
  // 起是合法 scope（回收站恢复面），改用真正未知的值当反例。
  assert.deepEqual(
    parseStoredWorkItemFilters(JSON.stringify({ type: "epic", priority: "P9", scope: "bogus", view: 1 })),
    defaultWorkItemFilters(),
  );
  assert.deepEqual(
    parseStoredWorkItemFilters(JSON.stringify({ scope: "trash" })),
    { ...defaultWorkItemFilters(), scope: "trash" },
  );
});
