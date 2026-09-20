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
