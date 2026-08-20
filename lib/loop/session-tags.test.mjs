import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loopSessionTags } = await jiti.import("./session-tags.ts");

/** Temp workspaces root with one workspace (`workspace-dev`) holding one loop
 *  (RUNS.jsonl). v3: selection-round orchestrators are tagged
 *  `{ orchestrator: true }` — there is no work-item join anymore (runs never
 *  own work items; seeded execution sessions link to items via
 *  `item.conversations` like any conversation). */
async function fixture() {
  const tmp = await mkdtemp(join(tmpdir(), "pi-loop-tags-"));
  const path = join(tmp, "workspaces");
  const wsPath = join(path, "workspace-dev");
  const loopDir = join(wsPath, "loops", "dev");
  await mkdir(loopDir, { recursive: true });
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
  // Minimal manifest so discoverWorkspaces reconciles the dir into the index.
  await mkdir(join(wsPath, ".pi"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(wsPath, ".pi", "workspace.yaml"), [
    "schema_version: 1",
    "id: 01TESTWORKSPACETAGS0001",
    "slug: dev",
    "name: Dev",
    "skills: []",
    "repositories: []",
    "agent: {}",
    "capabilities:",
    "  - sessions",
    "  - explorer",
    "  - loop",
    "git:",
    "  branch_rules:",
    "    requirement: feature/{date}/{slug}",
    "    bug: hotfix/{date}/{slug}",
    "  create_after: plan_approved",
    "work_items:",
    "  next_requirement_number: 1",
    "  next_bug_number: 1",
    "created_at: " + now,
    "updated_at: " + now,
    "",
  ].join("\n"));
  await writeFile(join(loopDir, "RUNS.jsonl"), [
    // Idle selection run.
    JSON.stringify({ id: "run-idle", workspaceId: "ws", loopId: "dev", eventId: "cron:1", triggeredBy: "cron", status: "succeeded", verdict: "idle", sessionId: "orch-session-idle", startedAt: now, updatedAt: now }),
    // Seeded selection run (two snapshots — only the latest matters, both carry the session).
    JSON.stringify({ id: "run-1", workspaceId: "ws", loopId: "dev", eventId: "cron:2", triggeredBy: "cron", status: "running", sessionId: "orch-session-1", startedAt: now, updatedAt: now }),
    JSON.stringify({ id: "run-1", workspaceId: "ws", loopId: "dev", eventId: "cron:2", triggeredBy: "cron", status: "succeeded", sessionId: "orch-session-1", seededSessionId: "exec-session-1", startedAt: now, updatedAt: now }),
    // No sessionId yet (just queued) — ignorable.
    JSON.stringify({ id: "run-2", workspaceId: "ws", loopId: "dev", eventId: "cron:3", triggeredBy: "cron", status: "queued", startedAt: now, updatedAt: now }),
    "",
  ].join("\n"));
  return { tmp, path, workspace: { id: "ws", name: "Workspace", path } };
}

test("loopSessionTags marks every run-backed session as orchestrator (no work-item join)", async () => {
  const { tmp, path } = await fixture();
  const previous = (globalThis).__piLoopSessionTags;
  (globalThis).__piLoopSessionTags = undefined;
  const previousDir = process.env.PI_WORKSPACES_DIR;
  const previousIndex = process.env.PI_WORKSPACE_INDEX_FILE;
  try {
    process.env.PI_WORKSPACES_DIR = path;
    process.env.PI_WORKSPACE_INDEX_FILE = join(tmp, "workspace-index.yaml");
    const tags = await loopSessionTags();
    assert.deepEqual(tags.get("orch-session-idle"), { orchestrator: true });
    assert.deepEqual(tags.get("orch-session-1"), { orchestrator: true });
    // The seeded EXECUTION session is NOT an orchestrator — only the selection
    // round's session is tagged.
    assert.equal(tags.has("exec-session-1"), false);
  } finally {
    (globalThis).__piLoopSessionTags = previous;
    if (previousDir === undefined) delete process.env.PI_WORKSPACES_DIR; else process.env.PI_WORKSPACES_DIR = previousDir;
    if (previousIndex === undefined) delete process.env.PI_WORKSPACE_INDEX_FILE; else process.env.PI_WORKSPACE_INDEX_FILE = previousIndex;
  }
});
