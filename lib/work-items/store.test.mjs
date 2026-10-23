import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const store = await jiti.import("./store.ts");

function fakeSnapshot(fetchedAt) {
  return { items: [], archivedItems: [], trashedItems: [], invalid: [], fetchedAt };
}

test("snapshot registry: get/set/clear round-trip per workspace", () => {
  const a1 = fakeSnapshot(1);
  assert.equal(store.getSnapshot("ws-a"), null, "missing workspace yields null");
  store.setSnapshot("ws-a", a1);
  assert.equal(store.getSnapshot("ws-a"), a1, "set then get returns the same snapshot object");
  const b1 = fakeSnapshot(2);
  store.setSnapshot("ws-b", b1);
  assert.equal(store.getSnapshot("ws-b"), b1, "workspaces are isolated");
  assert.equal(store.getSnapshot("ws-a"), a1, "writing ws-b leaves ws-a untouched");
  store.setSnapshot("ws-a", fakeSnapshot(3));
  assert.equal(store.getSnapshot("ws-a").fetchedAt, 3, "re-set replaces the snapshot");
  store.clearSnapshot("ws-a");
  assert.equal(store.getSnapshot("ws-a"), null, "clear removes the snapshot");
  assert.equal(store.getSnapshot("ws-b"), b1, "clear is scoped to one workspace");
  store.clearSnapshot("ws-b");
  store.clearSnapshot("never-existed", "clear on a missing workspace is a no-op");
});

test("shouldRefetch: null snapshot → true (nothing cached yet)", () => {
  assert.equal(store.shouldRefetch(null, 12345), true);
});

test("shouldRefetch: expired snapshot → true, fresh snapshot → false (default maxAge)", () => {
  const now = 100_000;
  assert.equal(store.shouldRefetch(fakeSnapshot(now - 4_999), now), false, "just under maxAge → fresh");
  assert.equal(store.shouldRefetch(fakeSnapshot(now - 5_000), now), true, "exactly maxAge → expired");
  assert.equal(store.shouldRefetch(fakeSnapshot(now - 6_000), now), true, "past maxAge → expired");
  assert.equal(store.shouldRefetch(fakeSnapshot(now + 30_000), now), false, "future fetchedAt (clock skew) → treated fresh");
});

test("shouldRefetch: custom maxAgeMs is honored", () => {
  const now = 100_000;
  assert.equal(store.shouldRefetch(fakeSnapshot(now - 99), now, 100), false);
  assert.equal(store.shouldRefetch(fakeSnapshot(now - 100), now, 100), true);
  assert.equal(store.shouldRefetch(fakeSnapshot(now - 101), now, 100), true);
});

test("subscribers are notified on set and clear, and stop after unsubscribe", () => {
  const seen = [];
  const unsubscribe = store.subscribeWorkItems("ws-c", (snapshot) => seen.push(snapshot));
  const s1 = fakeSnapshot(1);
  store.setSnapshot("ws-c", s1);
  store.clearSnapshot("ws-c");
  unsubscribe();
  store.setSnapshot("ws-c", fakeSnapshot(2));
  assert.deepEqual(seen, [s1, null], "set notifies with the new snapshot, clear with null; nothing after unsubscribe");
});

test("notifications are scoped per workspace", () => {
  const seenA = [];
  const unsubscribeA = store.subscribeWorkItems("ws-d", (snapshot) => seenA.push(snapshot));
  store.setSnapshot("ws-e", fakeSnapshot(9));
  assert.deepEqual(seenA, [], "a ws-e write does not reach a ws-d subscriber");
  const s = fakeSnapshot(10);
  store.setSnapshot("ws-d", s);
  assert.deepEqual(seenA, [s]);
  unsubscribeA();
  store.clearSnapshot("ws-d");
  store.clearSnapshot("ws-e");
});
