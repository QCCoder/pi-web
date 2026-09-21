import assert from "node:assert/strict";
import test from "node:test";

import {
  clearChatScrollPositionsForTest,
  findChatScrollAnchor,
  readChatScrollPosition,
  writeChatScrollPosition,
} from "./chat-scroll-position.ts";

test("anchors the most recent entry that started before the viewport", () => {
  const anchor = findChatScrollAnchor([
    { entryId: "current-turn", top: 20, bottom: 80 },
    { entryId: "next-turn", top: 420, bottom: 480 },
  ], 200);

  assert.deepEqual(anchor, {
    anchorEntryId: "current-turn",
    anchorOffset: -180,
  });
});

test("falls back to the last entry when the viewport is below all candidates", () => {
  assert.deepEqual(findChatScrollAnchor([
    { entryId: "first", top: 0, bottom: 100 },
    { entryId: "last", top: 100, bottom: 200 },
  ], 250), {
    anchorEntryId: "last",
    anchorOffset: -150,
  });
});

test("uses the first entry when the viewport starts above it", () => {
  assert.deepEqual(findChatScrollAnchor([
    { entryId: "first", top: 120, bottom: 180 },
    { entryId: "second", top: 240, bottom: 300 },
  ], 100), {
    anchorEntryId: "first",
    anchorOffset: 20,
  });
});

test("returns null when the conversation has no anchor candidates", () => {
  assert.equal(findChatScrollAnchor([], 100), null);
});

test("per-session store round-trips positions independently", () => {
  clearChatScrollPositionsForTest();
  assert.equal(readChatScrollPosition("s1"), null);

  writeChatScrollPosition("s1", { atBottom: true });
  writeChatScrollPosition("s2", { atBottom: false, anchorEntryId: "e7", anchorOffset: -42 });

  assert.deepEqual(readChatScrollPosition("s1"), { atBottom: true });
  assert.deepEqual(readChatScrollPosition("s2"), { atBottom: false, anchorEntryId: "e7", anchorOffset: -42 });
  assert.equal(readChatScrollPosition("s3"), null);

  // 最新写入覆盖旧位置（连续捕捉语义）。
  writeChatScrollPosition("s1", { atBottom: false, anchorEntryId: "e1", anchorOffset: 0 });
  assert.deepEqual(readChatScrollPosition("s1"), { atBottom: false, anchorEntryId: "e1", anchorOffset: 0 });

  clearChatScrollPositionsForTest();
  assert.equal(readChatScrollPosition("s1"), null);
});

function installWindowShim(t, backing) {
  const shim = {
    localStorage: {
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => void backing.set(k, v),
      removeItem: (k) => void backing.delete(k),
    },
  };
  const prev = globalThis.window;
  globalThis.window = shim;
  t.after(() => {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  });
  return shim;
}

test("positions survive a reload via localStorage write-through + hydration (本地 #8)", async (t) => {
  const { createJiti } = await import("jiti");
  const backing = new Map();
  installWindowShim(t, backing);
  const jiti = createJiti(import.meta.url, { moduleCache: false });

  const first = await jiti.import("./chat-scroll-position.ts");
  first.writeChatScrollPosition("s1", { atBottom: false, anchorEntryId: "e1", anchorOffset: 42 });
  first.writeChatScrollPosition("s2", { atBottom: true });
  assert.ok(backing.get("chat-scroll-positions"), "write-through must persist the blob");

  // moduleCache:false → 新实例 = 模拟刷新/后台回收后的重新加载，水合只靠 storage。
  const reloaded = await jiti.import("./chat-scroll-position.ts");
  assert.deepEqual(
    reloaded.readChatScrollPosition("s1"),
    { atBottom: false, anchorEntryId: "e1", anchorOffset: 42 },
  );
  assert.deepEqual(reloaded.readChatScrollPosition("s2"), { atBottom: true });
  assert.equal(reloaded.readChatScrollPosition("unknown"), null);
});

test("LRU keeps only the 30 most recently written sessions", async (t) => {
  const { createJiti } = await import("jiti");
  const backing = new Map();
  installWindowShim(t, backing);
  const jiti = createJiti(import.meta.url, { moduleCache: false });

  const store = await jiti.import("./chat-scroll-position.ts");
  for (let i = 0; i < 32; i++) {
    store.writeChatScrollPosition(`s${i}`, { atBottom: true });
  }
  const persisted = JSON.parse(backing.get("chat-scroll-positions"));
  assert.equal(Object.keys(persisted).length, 30);
  assert.equal(persisted["s0"], undefined, "oldest evicted");
  assert.equal(persisted["s1"], undefined, "second-oldest evicted");
  assert.deepEqual(persisted["s2"], { atBottom: true }, "oldest survivor kept");
  assert.deepEqual(persisted["s31"], { atBottom: true }, "newest kept");
  // 淘汰同时作用于内存（两级一致）。
  assert.equal(store.readChatScrollPosition("s0"), null);
  assert.deepEqual(store.readChatScrollPosition("s31"), { atBottom: true });

  const reloaded = await jiti.import("./chat-scroll-position.ts");
  assert.equal(reloaded.readChatScrollPosition("s0"), null, "evicted stays gone after reload");
});

test("storage failures degrade to in-memory semantics", async (t) => {
  const { createJiti } = await import("jiti");
  const backing = new Map();
  const shim = installWindowShim(t, backing);
  shim.localStorage.setItem = () => { throw new Error("quota exceeded"); };
  const jiti = createJiti(import.meta.url, { moduleCache: false });

  const store = await jiti.import("./chat-scroll-position.ts");
  store.writeChatScrollPosition("s1", { atBottom: false, anchorEntryId: "e1", anchorOffset: 7 });
  assert.deepEqual(
    store.readChatScrollPosition("s1"),
    { atBottom: false, anchorEntryId: "e1", anchorOffset: 7 },
    "memory store still works when persistence throws",
  );
});
