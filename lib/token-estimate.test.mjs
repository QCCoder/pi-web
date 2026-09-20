import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokens, estimateUpdatedTokens } from "./token-estimate.ts";

test("counts CJK chars as ~1 token each instead of 1/4", () => {
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens("あいうえお"), 5);
  assert.equal(estimateTokens("가나다"), 3);
  assert.equal(estimateTokens(String.fromCodePoint(0x20000)), 1);
});

test("keeps ~4 chars/token for non-CJK text", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("mixes CJK and latin text proportionally", () => {
  assert.equal(estimateTokens("你好ab"), 2.5);
  assert.equal(estimateTokens("100~200倍"), 7 / 4 + 1);
});

test("counts an astral code point (surrogate pair) as a single char", () => {
  assert.equal(estimateTokens("😀"), 0.25);
  assert.equal(estimateTokens("😀😀😀😀"), 1);
});

test("incremental estimate matches a full rescan for appended text", () => {
  let text = "";
  let cache;
  let previous;
  for (const chunk of ["你好", "世界 abc", "def 汉字", "g"]) {
    text += chunk;
    const tokens = estimateUpdatedTokens(previous, text);
    assert.equal(tokens, estimateTokens(text));
    cache = { text, tokens };
    previous = cache;
  }
});

test("repairs a surrogate pair completed across streaming updates", () => {
  const partial = "a\ud83d";
  const complete = "a\ud83d\ude00b";
  const previous = { text: partial, tokens: estimateTokens(partial) };

  assert.equal(estimateUpdatedTokens(previous, complete), estimateTokens(complete));
});

test("recomputes from scratch when text is not an append of the previous", () => {
  const previous = { text: "hello", tokens: estimateTokens("hello") };

  assert.equal(estimateUpdatedTokens(previous, "world"), estimateTokens("world"));
  assert.equal(estimateUpdatedTokens(undefined, "你好"), 2);
});
