import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { DefaultLoopRuntime } = await jiti.import("./runtime.ts");

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "pi-loop-test-"));
  const directory = join(path, "loops", "check");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "loop.yaml"), [
    "schema_version: 1", "id: check", "name: Check", "enabled: true", "autonomy: L1",
    "triggers:", "  - id: manual", "    type: manual", "    enabled: true", "",
  ].join("\n"));
  await writeFile(join(directory, "LOOP.md"), "# Check\n\nMaker then checker.\n");
  const workspace = { id: "ws", name: "Workspace", path };
  const resolver = { get: async () => workspace, list: async () => [workspace] };
  const execution = {
    infer: async () => ({ sessionId: "session-1", plan: {
      summary: "check", steps: [{ id: "make", maker: "maker", verifier: "checker" }],
      improve: "audit", fingerprint: "abc",
    } }),
    execute: async () => ({ output: "done", verdict: "unchanged" }),
    reject: async () => undefined,
  };
  return { path, runtime: new DefaultLoopRuntime(resolver, execution) };
}

async function waitFor(runtime, runId, status) {
  for (let index = 0; index < 50; index += 1) {
    const run = await runtime.getRun("ws", runId);
    if (run.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run did not reach ${status}`);
}

test("trigger de-duplicates, pauses for confirmation, then executes", async () => {
  const { path, runtime } = await fixture();
  const command = { workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-1" };
  const receipt = await runtime.trigger(command);
  assert.equal(receipt.accepted, true);
  const duplicate = await runtime.trigger(command);
  assert.deepEqual(duplicate, { accepted: false, duplicate: true, runId: receipt.runId });
  const waiting = await waitFor(runtime, receipt.runId, "waiting_for_confirmation");
  assert.equal(waiting.sessionId, "session-1");
  await runtime.answerGate({ workspaceId: "ws", runId: receipt.runId, decision: "approve" });
  const complete = await waitFor(runtime, receipt.runId, "succeeded");
  assert.equal(complete.verdict, "unchanged");
  const evidence = await readFile(join(path, "loops", "check", "RUNS.jsonl"), "utf8");
  assert.match(evidence, /waiting_for_confirmation/);
  assert.match(evidence, /succeeded/);
});
