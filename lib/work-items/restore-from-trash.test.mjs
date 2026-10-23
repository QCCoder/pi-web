// M2 Task 5 回收站恢复：restoreWorkItemFromTrashInRoot 直接以 workspacePath
// 驱动（getWorkspace 走全局索引，这里手工搭目录——同 Task 4 import-dedup 手法）。
// 覆盖：最新 mtime 优先 / 回到正确 type 目录 + 事件追加 / key 被占用 409 且
// 不动 trash / 无此 key 404 / 坏 item.yaml → Validation（不裸抛）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readWorkItem,
  restoreWorkItemFromTrashInRoot,
  WorkItemConflictError,
  WorkItemNotFoundError,
  WorkItemValidationError,
} from "./service.ts";

// parseWorkItem 的 snake_case 真实 schema（同 import-dedup.test.mjs）。
const itemYaml = (key, type = "requirement", title = "t") => [
  "schema_version: 1", `id: ${key.toLowerCase()}`, `key: ${key}`, "revision: 1",
  `type: ${type}`, `title: ${title}`, "status: open", "phase: intake", "priority: P2",
  "repositories: []", "tags: []", "conversations: []", "related_items: []", "designs: []", "plans: []",
  "archived_at: null", "created_at: 2026-10-01T00:00:00Z", "updated_at: 2026-10-01T00:00:00Z",
].join("\n");

/** 造一个回收站条目 `<ws>/.pi/trash/work-items/<dirName>/`（key 取目录名前 8 位）。 */
async function trashEntry(ws, dirName, { type = "requirement", title = "t", yaml } = {}) {
  const dir = join(ws, ".pi", "trash", "work-items", dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), yaml ?? itemYaml(dirName.slice(0, 8), type, title));
  await writeFile(join(dir, "README.md"), `# ${title}\n\n## Original Description\n\nbody\n`);
  await writeFile(join(dir, "events.jsonl"), "");
  return dir;
}

async function tempWorkspace(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("restores the newest trashed entry back to its type directory with an event", async () => {
  const ws = await tempWorkspace("pi-restore-");
  try {
    const older = await trashEntry(ws, "REQ-0001-first-2026-10-01T00-00-00-000Z", { title: "older" });
    const newer = await trashEntry(ws, "REQ-0001-second-2026-10-02T00-00-00-000Z", { title: "newest" });
    // mkdtemp 内两次写入的 mtime 可能同毫秒——显式定序：newer 更新。
    // （utimes 传裸数字按【秒】解释，Date.now() 毫秒值会被钳到同一上限成平局。）
    const now = new Date();
    await utimes(older, new Date(now.getTime() - 20_000), new Date(now.getTime() - 20_000));
    await utimes(newer, now, now);

    const detail = await restoreWorkItemFromTrashInRoot(ws, "REQ-0001");

    assert.equal(detail.item.key, "REQ-0001");
    assert.equal(detail.item.title, "newest");
    assert.ok(detail.path.endsWith(
      join(".pi", "work-items", "requirements", "REQ-0001-second-2026-10-02T00-00-00-000Z"),
    ));
    const restored = detail.events.at(-1);
    assert.equal(restored.type, "work_item.restored");
    assert.equal(restored.actor, "user");
    assert.equal(restored.data.restoredFrom, newer);
    // 恢复后普通读取路径可用；未被选中的旧条目留在回收站。
    assert.equal((await readWorkItem(ws, "REQ-0001")).item.title, "newest");
    const trashLeft = await readFile(join(older, "item.yaml"), "utf8");
    assert.match(trashLeft, /REQ-0001/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("rejects with conflict when the key is already live, without touching the trash entry", async () => {
  const ws = await tempWorkspace("pi-restore-conflict-");
  try {
    const liveDir = join(ws, ".pi", "work-items", "bugs", "BUG-0002-live");
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, "item.yaml"), itemYaml("BUG-0002", "bug", "live"));
    await writeFile(join(liveDir, "README.md"), "# live\n");
    await writeFile(join(liveDir, "events.jsonl"), "");
    const trashed = await trashEntry(ws, "BUG-0002-old-2026-10-01T00-00-00-000Z", { type: "bug" });

    await assert.rejects(
      restoreWorkItemFromTrashInRoot(ws, "BUG-0002"),
      WorkItemConflictError,
    );
    // 冲突在移动之前判定：回收站条目原样在位。
    assert.match(await readFile(join(trashed, "item.yaml"), "utf8"), /BUG-0002/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("rejects with not-found when no trashed entry carries the key", async () => {
  const ws = await tempWorkspace("pi-restore-404-");
  try {
    await assert.rejects(restoreWorkItemFromTrashInRoot(ws, "REQ-0007"), WorkItemNotFoundError);
    await trashEntry(ws, "REQ-0008-other-2026-10-01T00-00-00-000Z");
    await assert.rejects(restoreWorkItemFromTrashInRoot(ws, "REQ-0007"), WorkItemNotFoundError);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("malformed trash item.yaml and invalid keys surface validation errors, not crashes", async () => {
  const ws = await tempWorkspace("pi-restore-broken-");
  try {
    const broken = await trashEntry(ws, "REQ-0009-garbage-2026-10-01T00-00-00-000Z", {
      yaml: "broken: true\n",
    });
    await assert.rejects(restoreWorkItemFromTrashInRoot(ws, "REQ-0009"), WorkItemValidationError);
    // 坏条目不被移动，留在回收站等人工处置。
    assert.match(await readFile(join(broken, "item.yaml"), "utf8"), /broken/);
    // 非法 key 形态在进入扫描前就拦下。
    await assert.rejects(restoreWorkItemFromTrashInRoot(ws, "NOPE-1"), WorkItemValidationError);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
