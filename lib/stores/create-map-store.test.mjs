import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createMapStore } = jiti("./create-map-store");

test("basic read/write/delete", () => {
  const s = createMapStore();
  assert.equal(s.get("a"), undefined);
  assert.equal(s.has("a"), false);
  assert.equal(s.size(), 0);

  s.set("a", 1);
  assert.equal(s.get("a"), 1);
  assert.equal(s.has("a"), true);
  assert.equal(s.size(), 1);
  assert.deepEqual(s.keys(), ["a"]);
  assert.deepEqual(s.entries(), [["a", 1]]);

  s.delete("a");
  assert.equal(s.get("a"), undefined);
  assert.equal(s.size(), 0);
});

test("update computes from previous value", () => {
  const s = createMapStore();
  s.update("n", (prev) => (prev ?? 0) + 5);
  assert.equal(s.get("n"), 5);
  s.update("n", (prev) => (prev ?? 0) + 10);
  assert.equal(s.get("n"), 15);
});

test("set undefined clears the key (delete semantics)", () => {
  const s = createMapStore();
  s.set("a", 1);
  s.set("a", undefined);
  assert.equal(s.has("a"), false);
  // setting undefined on a missing key is a no-op (no version bump)
  const before = s.version();
  s.set("missing", undefined);
  assert.equal(s.version(), before);
});

test("subscribeKey only fires for the subscribed key", () => {
  const s = createMapStore();
  let aCalls = 0;
  let bCalls = 0;
  const unsubA = s.subscribeKey("a", () => { aCalls++; });
  const unsubB = s.subscribeKey("b", () => { bCalls++; });

  s.set("a", 1);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 0);

  s.set("b", 2);
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);

  s.delete("a");
  assert.equal(aCalls, 2);
  assert.equal(bCalls, 1);

  unsubA();
  s.set("a", 9);
  assert.equal(aCalls, 2); // unsubscribed, no more calls
  assert.equal(bCalls, 1);
  unsubB();
});

test("subscribe fires on any key change", () => {
  const s = createMapStore();
  let calls = 0;
  s.subscribe(() => { calls++; });
  s.set("a", 1);
  s.set("b", 2);
  s.delete("a");
  assert.equal(calls, 3);
});

test("keyVersion bumps only for changed key; version bumps globally", () => {
  const s = createMapStore();
  assert.equal(s.keyVersion("a"), 0);
  s.set("a", 1);
  assert.equal(s.keyVersion("a"), 1);
  assert.equal(s.keyVersion("b"), 0); // untouched
  s.set("a", 2);
  assert.equal(s.keyVersion("a"), 2);
  s.delete("a");
  assert.equal(s.keyVersion("a"), 3);
  assert.ok(s.version() > 0);
});

test("LRU evicts oldest when over capacity", () => {
  const s = createMapStore({ maxSize: 2 });
  s.set("a", 1);
  s.set("b", 2);
  assert.deepEqual(s.keys(), ["a", "b"]);
  s.set("c", 3); // a evicted
  assert.deepEqual(s.keys(), ["b", "c"]);
  assert.equal(s.get("a"), undefined);
});

test("LRU promotes touched key to most-recent on set", () => {
  const s = createMapStore({ maxSize: 2 });
  s.set("a", 1);
  s.set("b", 2);
  s.set("a", 10); // touch a -> moves to most recent
  assert.deepEqual(s.keys(), ["b", "a"]);
  s.set("c", 3); // b evicted, not a
  assert.deepEqual(s.keys(), ["a", "c"]);
  assert.equal(s.get("a"), 10);
  assert.equal(s.get("b"), undefined);
});

test("LRU evicted key notifies its subscribers", () => {
  const s = createMapStore({ maxSize: 1 });
  let calls = 0;
  let lastSeen;
  s.subscribeKey("a", () => { calls++; lastSeen = s.get("a"); });
  s.set("a", 1);
  s.set("b", 2); // a evicted
  assert.equal(calls, 2); // set + evict
  assert.equal(lastSeen, undefined);
});

test("multiple subscribers on same key all fire", () => {
  const s = createMapStore();
  let c1 = 0, c2 = 0;
  s.subscribeKey("a", () => { c1++; });
  s.subscribeKey("a", () => { c2++; });
  s.set("a", 1);
  assert.equal(c1, 1);
  assert.equal(c2, 1);
});
