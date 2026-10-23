// M2 Task 4 导入去重（spec §8.1）：同 source+sourceId 的导入跨
// 活动 ∪ 归档 ∪ 回收站查重——回收站 item.yaml 即来源去重墓碑。
// 纯扫描函数直接驱动（getWorkspace 走全局索引，这里手工搭目录）；
// createWorkItem 锁内查+建的去重行为在 service.test.mjs 的真临时工作区覆盖。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const service = await jiti.import("./service.ts");

// 注意：键名是 parseWorkItem 的 snake_case 真实 schema（schema_version /
// created_at / archived_at / related_items）——brief 草稿里的 camelCase 变体
// 会整体落进 invalid，断言永远不可能通过。
const itemYaml = (key, external) => [
  "schema_version: 1", `id: ${key.toLowerCase()}`, `key: ${key}`, "revision: 1",
  "type: requirement", "title: t", "status: open", "phase: intake", "priority: P2",
  "repositories: []", "tags: []", "conversations: []", "related_items: []", "designs: []", "plans: []",
  "archived_at: null", "created_at: t", "updated_at: t",
  ...(external ? [`external:`, `  source: ${external.source}`, `  sourceId: "${external.sourceId}"`, "  lastSyncedAt: t"] : []),
].join("\n");

test("findExistingByExternal scans active, archived and trash", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-dedup-"));
  await mkdir(join(ws, ".pi/work-items/requirements/REQ-0001-a"), { recursive: true });
  await writeFile(join(ws, ".pi/work-items/requirements/REQ-0001-a/item.yaml"), itemYaml("REQ-0001", { source: "chandao", sourceId: "99" }));
  await mkdir(join(ws, ".pi/work-items/requirements/REQ-0002-b"), { recursive: true });
  await writeFile(join(ws, ".pi/work-items/requirements/REQ-0002-b/item.yaml"), itemYaml("REQ-0002", { source: "chandao", sourceId: "100" })
    .replace("archived_at: null", "archived_at: \"2026-10-01\""));
  await mkdir(join(ws, ".pi/trash/work-items/REQ-0003-c"), { recursive: true });
  await writeFile(join(ws, ".pi/trash/work-items/REQ-0003-c/item.yaml"), itemYaml("REQ-0003", { source: "chandao", sourceId: "101" }));

  assert.equal((await service.findExistingByExternal(ws, "chandao", "99")).outcome, "existing");
  assert.equal((await service.findExistingByExternal(ws, "chandao", "100")).outcome, "existing");
  assert.equal((await service.findExistingByExternal(ws, "chandao", "101")).outcome, "existing_trashed");
  assert.equal((await service.findExistingByExternal(ws, "chandao", "999")).outcome, undefined);
  await rm(ws, { recursive: true, force: true });
});

test("malformed trash entries are skipped without blocking the lookup", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-dedup-broken-"));
  // 回收站里的坏 item.yaml（截断/坏 schema）不能让查重整体失败——跳过继续扫。
  await mkdir(join(ws, ".pi/trash/work-items/REQ-0009-garbage"), { recursive: true });
  await writeFile(join(ws, ".pi/trash/work-items/REQ-0009-garbage/item.yaml"), "broken: true\n");
  await mkdir(join(ws, ".pi/trash/work-items/REQ-0010-empty"), { recursive: true });
  await mkdir(join(ws, ".pi/trash/work-items/REQ-0011-good"), { recursive: true });
  await writeFile(join(ws, ".pi/trash/work-items/REQ-0011-good/item.yaml"), itemYaml("REQ-0011", { source: "chandao", sourceId: "77" }));

  const hit = await service.findExistingByExternal(ws, "chandao", "77");
  assert.equal(hit.outcome, "existing_trashed");
  assert.equal(hit.key, "REQ-0011");
  assert.equal((await service.findExistingByExternal(ws, "chandao", "9")).outcome, undefined);
  await rm(ws, { recursive: true, force: true });
});
