import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { DefaultLoopRuntime } = await jiti.import("./runtime.ts");

/** Build a workspace + a mock RoundExecutionBackend. `options` lets each test
 *  shape startRound/resumeRound/abortRound behavior and observe calls. */
async function fixture(options = {}) {
  const path = await mkdtemp(join(tmpdir(), "pi-loop-test-"));
  const directory = join(path, "loops", "check");
  await mkdir(directory, { recursive: true });
  // NOTE: no `autonomy` key — the new engine is autonomy-free.
  await writeFile(join(directory, "loop.yaml"), [
    "schema_version: 1", "id: check", "name: Check", "enabled: true",
    "triggers:", "  - id: manual", "    type: manual", "    enabled: true", "",
  ].join("\n"));
  await writeFile(join(directory, "LOOP.md"), "# Check\n\nFree-run loop.\n");
  const workspace = { id: "ws", name: "Workspace", path };
  const resolver = { get: async () => workspace, list: async () => [workspace] };
  const calls = [];
  // For the in-flight-abort test: a hangable startRound whose promise we control.
  const hang = options.hang === true ? { resolveStart: null } : null;
  const execution = {
    startRound: options.startRound ?? (async (_def, run, onSessionReady) => {
      calls.push(["startRound", run.id]);
      // Await the callback to mirror the real backend, which always lets
      // onSessionReady's side effects complete during the (long) capturePrompt
      // that follows — otherwise the callback's snapshot write could land after
      // the terminal snapshot and corrupt the run's final state.
      if (onSessionReady) await onSessionReady("session-1");
      if (hang) {
        return new Promise((_resolve, reject) => {
          hang.resolveStart = reject;
        });
      }
      return options.gateOnStart
        ? { output: "paused", gateRequest: "need human" }
        : { output: "done", verdict: "ok" };
    }),
    resumeRound: options.resumeRound ?? (async (run, message) => {
      calls.push(["resumeRound", run.id, message]);
      return { output: "finished", verdict: "done" };
    }),
    abortRound: options.abortRound ?? (async (run) => {
      calls.push(["abortRound", run.id]);
      // Simulate destroying the in-flight session: a hanging startRound rejects.
      if (hang?.resolveStart) hang.resolveStart(new Error("session destroyed"));
    }),
  };
  return { path, runtime: new DefaultLoopRuntime(resolver, execution), calls, hang };
}

async function waitFor(runtime, runId, status) {
  // Generous budget: under `npm test` the loop tests run concurrently with
  // heavy workspace/git tests, which can starve the mock's file I/O.
  for (let index = 0; index < 200; index += 1) {
    const run = await runtime.getRun("ws", runId);
    if (run.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run did not reach ${status}`);
}

test("trigger runs startRound, pauses at gate, resumes on free-text answer, succeeds", async () => {
  const { runtime, calls } = await fixture({ gateOnStart: true });
  const receipt = await runtime.trigger({ workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-1" });
  assert.equal(receipt.accepted, true);
  const waiting = await waitFor(runtime, receipt.runId, "waiting_for_gate");
  assert.equal(waiting.sessionId, "session-1");
  assert.equal(waiting.gateRequest, "need human");

  // The gate answer is free text; the engine forwards it verbatim to resumeRound.
  await runtime.answerGate({ workspaceId: "ws", runId: receipt.runId, message: "ok proceed" });
  const complete = await waitFor(runtime, receipt.runId, "succeeded");
  assert.equal(complete.verdict, "done");
  assert.deepEqual(
    calls.find((call) => call[0] === "resumeRound"),
    ["resumeRound", receipt.runId, "ok proceed"],
  );
});

test("trigger de-duplicates by eventId", async () => {
  const { runtime } = await fixture({ gateOnStart: true });
  const command = { workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-1" };
  const receipt = await runtime.trigger(command);
  const duplicate = await runtime.trigger(command);
  assert.deepEqual(duplicate, { accepted: false, duplicate: true, runId: receipt.runId });
});

test("a run with no gate succeeds directly after startRound", async () => {
  const { runtime } = await fixture({ gateOnStart: false });
  const receipt = await runtime.trigger({ workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-direct" });
  const complete = await waitFor(runtime, receipt.runId, "succeeded");
  assert.equal(complete.verdict, "ok");
  assert.equal(complete.gateRequest, undefined);
});

test("abortRun at waiting_for_gate marks the run failed", async () => {
  const { runtime, calls } = await fixture({ gateOnStart: true });
  const receipt = await runtime.trigger({ workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-abort" });
  await waitFor(runtime, receipt.runId, "waiting_for_gate");
  const aborted = await runtime.abortRun("ws", receipt.runId);
  assert.equal(aborted.status, "failed");
  assert.equal(aborted.error, "aborted");
  assert.ok(calls.find((call) => call[0] === "abortRound"));
});

test("abortRun during in-flight startRound wins (aborted guard prevents double-fail)", async () => {
  const { runtime, calls } = await fixture({ hang: true });
  const receipt = await runtime.trigger({ workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-inflight" });
  // startRound is hanging -> the run is "running".
  await waitFor(runtime, receipt.runId, "running");
  const aborted = await runtime.abortRun("ws", receipt.runId);
  assert.equal(aborted.status, "failed");
  assert.equal(aborted.error, "aborted");
  // abortRound destroyed the session -> the hanging startRound rejected -> the
  // start() catch hit the aborted guard and returned WITHOUT overwriting.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = await runtime.getRun("ws", receipt.runId);
  assert.equal(after.status, "failed");
  assert.equal(after.error, "aborted");
  // startRound was attempted exactly once; no spurious resumeRound.
  assert.equal(calls.filter((call) => call[0] === "startRound").length, 1);
  assert.equal(calls.filter((call) => call[0] === "resumeRound").length, 0);
});

test("answerGate on a non-waiting run is rejected", async () => {
  const { runtime } = await fixture({ gateOnStart: false });
  const receipt = await runtime.trigger({ workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-badgate" });
  await waitFor(runtime, receipt.runId, "succeeded");
  await assert.rejects(
    () => runtime.answerGate({ workspaceId: "ws", runId: receipt.runId, message: "late" }),
    /not waiting for a gate/,
  );
});

test("abortRun on a terminal run is rejected", async () => {
  const { runtime } = await fixture({ gateOnStart: false });
  const receipt = await runtime.trigger({ workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-termabort" });
  await waitFor(runtime, receipt.runId, "succeeded");
  await assert.rejects(
    () => runtime.abortRun("ws", receipt.runId),
    /cannot be aborted/,
  );
});

test("evidence log records the free-run lifecycle", async () => {
  const { path, runtime } = await fixture({ gateOnStart: true });
  const receipt = await runtime.trigger({ workspaceId: "ws", loopId: "check", source: "manual", eventId: "event-ev" });
  await waitFor(runtime, receipt.runId, "waiting_for_gate");
  await runtime.answerGate({ workspaceId: "ws", runId: receipt.runId, message: "go" });
  await waitFor(runtime, receipt.runId, "succeeded");
  const evidence = await readFile(join(path, "loops", "check", "RUNS.jsonl"), "utf8");
  assert.match(evidence, /waiting_for_gate/);
  assert.match(evidence, /succeeded/);
  // No retired statuses should be written by the new engine.
  assert.doesNotMatch(evidence, /waiting_for_confirmation/);
  assert.doesNotMatch(evidence, /inferring/);
});
