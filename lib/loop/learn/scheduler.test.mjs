import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { LearnScheduler } = await jiti.import("./scheduler.ts");
const { createWorkspace } = await jiti.import("../../workspaces/service.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-learn-"));
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
  const workspace = await createWorkspace({ name: "Learn", slug: "learn", capabilities: ["loop"] }, root);
  return workspace;
}

function rec(module, outcome, ts) {
  return JSON.stringify({
    runId: `r-${module}-${ts}`, workItemKey: "BUG-0001", module, repo: "cargoware",
    predictedConf: "high", riskTier: "normal", outcome, tests: outcome === "merged" ? "green" : "red", ts,
  });
}

test("LearnScheduler.runOnce: recomputes STATE derived block from LEARN.jsonl (§7.4 example)", async (t) => {
  const ws = await fixture(t);
  const loopDir = join(ws.path, "loops", "dev-loop");
  await mkdir(join(loopDir), { recursive: true });
  // 3 merged + 2 changes_requested for finance-service => accuracy 0.6 < 0.7 => tier=med
  const learn = [
    rec("finance-service", "merged", "2026-01-01T00:00:00.000Z"),
    rec("finance-service", "merged", "2026-01-02T00:00:00.000Z"),
    rec("finance-service", "merged", "2026-01-03T00:00:00.000Z"),
    rec("finance-service", "changes_requested", "2026-01-04T00:00:00.000Z"),
    rec("finance-service", "changes_requested", "2026-01-05T00:00:00.000Z"),
  ].join("\n");
  await writeFile(join(loopDir, "LEARN.jsonl"), learn, "utf8");
  await writeFile(join(loopDir, "STATE.md"), "# State\n\nbaseline.\n", "utf8");

  const scheduler = new LearnScheduler(1000, () => {});
  const summary = await scheduler.runOnce(ws.id);
  assert.equal(summary.modules, 1);
  const state = await readFile(join(loopDir, "STATE.md"), "utf8");
  assert.match(state, /dev-loop:derived:start/);
  assert.match(state, /finance-service: samples=5/);
  assert.match(state, /high=60%/);
  assert.match(state, /tier=med/); // demoted — evolution visible
  // baseline preserved
  assert.match(state, /baseline\./);
});

test("LearnScheduler.runOnce: returns null when no dev-loop exists", async (t) => {
  const ws = await fixture(t);
  const scheduler = new LearnScheduler(1000, () => {});
  const summary = await scheduler.runOnce(ws.id);
  assert.equal(summary, null);
});

test("LearnScheduler.runOnce: idempotent — re-running keeps a single derived block", async (t) => {
  const ws = await fixture(t);
  const loopDir = join(ws.path, "loops", "dev-loop");
  await mkdir(loopDir, { recursive: true });
  await writeFile(join(loopDir, "LEARN.jsonl"), rec("m", "merged", "2026-01-01T00:00:00.000Z"), "utf8");
  await writeFile(join(loopDir, "STATE.md"), "# State\n", "utf8");
  const scheduler = new LearnScheduler(1000, () => {});
  await scheduler.runOnce(ws.id);
  await scheduler.runOnce(ws.id);
  const state = await readFile(join(loopDir, "STATE.md"), "utf8");
  assert.equal((state.match(/dev-loop:derived:start/g) || []).length, 1);
});

test("LearnScheduler.runOnce: tolerates malformed LEARN lines", async (t) => {
  const ws = await fixture(t);
  const loopDir = join(ws.path, "loops", "dev-loop");
  await mkdir(loopDir, { recursive: true });
  await writeFile(join(loopDir, "LEARN.jsonl"), ["not json", rec("m", "merged", "2026-01-01T00:00:00.000Z"), ""].join("\n"), "utf8");
  await writeFile(join(loopDir, "STATE.md"), "# State\n", "utf8");
  const scheduler = new LearnScheduler(1000, () => {});
  const summary = await scheduler.runOnce(ws.id);
  assert.equal(summary.modules, 1); // the one valid record
});
