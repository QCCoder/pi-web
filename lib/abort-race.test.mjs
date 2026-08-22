import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { raceAbort, creationTimeoutSignal } = await jiti.import("./abort-race.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("raceAbort resolves with the promise value when the promise wins", async () => {
  const controller = new AbortController();
  const value = await raceAbort(Promise.resolve(42), controller.signal);
  assert.equal(value, 42);
});

test("raceAbort passes an underlying rejection through untouched", async () => {
  const controller = new AbortController();
  await assert.rejects(raceAbort(Promise.reject(new Error("boom")), controller.signal), /boom/);
});

test("raceAbort rejects immediately when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  // The underlying promise never settles — the race must still reject now.
  await assert.rejects(raceAbort(new Promise(() => {}), controller.signal), /aborted/);
});

test("raceAbort rejects with the signal reason when abort fires mid-flight", async () => {
  const controller = new AbortController();
  const raced = raceAbort(new Promise(() => {}), controller.signal);
  controller.abort(new Error("stop waiting"));
  await assert.rejects(raced, /stop waiting/);
});

test("raceAbort hands a late-fulfilled value to onLateSettle after losing to abort", async () => {
  const controller = new AbortController();
  let resolveLate;
  const late = new Promise((resolve) => {
    resolveLate = resolve;
  });
  const lateValues = [];
  const raced = raceAbort(late, controller.signal, { onLateSettle: (v) => lateValues.push(v) });
  controller.abort();
  await assert.rejects(raced, /aborted/);
  assert.deepEqual(lateValues, []);
  resolveLate("session-wrapper");
  await tick();
  assert.deepEqual(lateValues, ["session-wrapper"]);
});

test("raceAbort swallows a late rejection after losing to abort (no unhandled rejection)", async () => {
  const controller = new AbortController();
  let rejectLate;
  const late = new Promise((_resolve, reject) => {
    rejectLate = reject;
  });
  const raced = raceAbort(late, controller.signal);
  controller.abort();
  await assert.rejects(raced, /aborted/);
  rejectLate(new Error("late failure"));
  await tick();
});

test("raceAbort ignores an abort that fires after resolution", async () => {
  const controller = new AbortController();
  const raced = raceAbort(Promise.resolve(1), controller.signal);
  // Let the resolution process through the race first — an abort fired before
  // the microtask queue runs is a legitimate mid-flight abort, not a late one.
  await tick();
  controller.abort();
  assert.equal(await raced, 1);
});

test("creationTimeoutSignal aborts with the timeout message", async () => {
  const { signal, dispose } = creationTimeoutSignal(10, "creation timed out");
  try {
    await assert.rejects(raceAbort(new Promise(() => {}), signal), /creation timed out/);
  } finally {
    dispose();
  }
});

test("creationTimeoutSignal dispose stops the timer before it fires", async () => {
  const { signal, dispose } = creationTimeoutSignal(5, "creation timed out");
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
});
