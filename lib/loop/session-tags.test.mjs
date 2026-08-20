import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { orchestratorWorkItemIndex } = await jiti.import("./session-tags.ts");

/** Temp workspace with one loop (RUNS.jsonl) and one requirement whose
 *  conversations link the first run's orchestrator session. */
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "pi-loop-tags-"));
  const loopDir = join(path, "loops", "dev");
  await mkdir(loopDir, { recursive: true });
  // loop.yaml + LOOP.md are required by listLoopDefinitions (store.ts) —
  // without them listRunSnapshots(workspace) sees no loops at all.
  await writeFile(join(loopDir, "loop.yaml"), [
    "schema_version: 1",
    "id: dev",
    "name: Dev",
    "enabled: true",
    "triggers:",
    "  - id: manual",
    "    type: manual",
    "    enabled: true",
    "",
  ].join("\n"));
  await writeFile(join(loopDir, "LOOP.md"), "# Dev\n");
  const itemDir = join(path, "requirements", "REQ-0001-link");
  await mkdir(itemDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(itemDir, "item.yaml"), [
    "schema_version: 1",
    "id: 01TESTWORKITEM000001",
    "key: REQ-0001",
    "type: requirement",
    "title: Linked item",
    "status: in_progress",
    "phase: intake",
    "priority: P2",
    "revision: 1",
    "repositories: []",
    "tags: []",
    "related_items: []",
    "designs: []",
    "plans: []",
    "created_at: " + now,
    "updated_at: " + now,
    "conversations:",
    "  - orch-session-1",
    "",
  ].join("\n"));
  await writeFile(join(itemDir, "README.md"), "# REQ-0001\n");
  await writeFile(join(itemDir, "events.jsonl"), "");
  await writeFile(join(loopDir, "RUNS.jsonl"), [
    // Idle run: no work item — must NOT appear in the index.
    JSON.stringify({ id: "run-idle", workspaceId: "ws", loopId: "dev", eventId: "cron:1", triggeredBy: "cron", status: "succeeded", verdict: "idle", sessionId: "orch-session-idle", startedAt: now, updatedAt: now }),
    // Linked run (two snapshots — only the latest matters, both carry the session).
    JSON.stringify({ id: "run-1", workspaceId: "ws", loopId: "dev", eventId: "cron:2", triggeredBy: "cron", status: "running", sessionId: "orch-session-1", startedAt: now, updatedAt: now }),
    JSON.stringify({ id: "run-1", workspaceId: "ws", loopId: "dev", eventId: "cron:2", triggeredBy: "cron", status: "succeeded", sessionId: "orch-session-1", startedAt: now, updatedAt: now }),
    // No sessionId yet (just queued) — ignorable.
    JSON.stringify({ id: "run-2", workspaceId: "ws", loopId: "dev", eventId: "cron:3", triggeredBy: "cron", status: "queued", startedAt: now, updatedAt: now }),
    "",
  ].join("\n"));
  return { path, workspace: { id: "ws", name: "Workspace", path } };
}

test("orchestratorWorkItemIndex maps only work-item-linked orchestrator sessions", async () => {
  const { workspace } = await fixture();
  const index = await orchestratorWorkItemIndex(workspace);
  assert.equal(index.size, 1);
  assert.deepEqual(index.get("orch-session-1"), { key: "REQ-0001", title: "Linked item" });
  assert.equal(index.has("orch-session-idle"), false);
});

test("orchestratorWorkItemIndex tolerates a workspace without loops", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-loop-empty-"));
  const index = await orchestratorWorkItemIndex({ id: "ws", name: "Workspace", path });
  assert.equal(index.size, 0);
});
