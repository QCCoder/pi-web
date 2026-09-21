import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
  jsx: { runtime: "automatic" },
});
const { getSessionListIndices } = await jiti.import("./WorkspaceSessionList.tsx");

test("windows indices around the scroll position with overscan (upstream 5f8f47b 技术移植)", () => {
  // pitch 60, viewport 600 → 10 屏行 + 2×8 overscan = 26 挂载。
  const top = getSessionListIndices(1000, 0, 600);
  assert.equal(top[0], 0);
  assert.equal(top.length, 26);
  assert.equal(top[top.length - 1], 25);

  const scrolled = getSessionListIndices(1000, 60 * 100, 600);
  assert.equal(scrolled[0], 100 - 8);
  assert.equal(scrolled.length, 26);

  // 尾部不越界。
  const tail = getSessionListIndices(1000, 60 * 5000, 600);
  assert.equal(tail[tail.length - 1], 999);
});

test("pins a focused row outside the visible window so confirm state survives scrolling", () => {
  const headPinned = getSessionListIndices(1000, 60 * 100, 600, 5);
  assert.equal(headPinned[0], 5);
  assert.equal(headPinned[1], 92);

  const tailPinned = getSessionListIndices(1000, 60 * 100, 600, 999);
  assert.equal(tailPinned[tailPinned.length - 1], 999);

  // 焦点行本就在窗口内时不重复挂载。
  const inWindow = getSessionListIndices(1000, 60 * 100, 600, 95);
  assert.equal(inWindow.filter((i) => i === 95).length, 1);
});

test("short lists clamp to the full range", () => {
  assert.deepEqual(getSessionListIndices(5, 0, 600), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 0, 600), []);
});
