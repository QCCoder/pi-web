import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-lazy-load.ts");
}

test("shows only the last visible render items", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(200, 50), { startIndex: 150, hasMore: true });
});

test("shows all render items when the visible count reaches the total", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(30, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(50, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(0, 50), { startIndex: 0, hasMore: false });
});

test("continues paging when render items outnumber source messages", async () => {
  const { getNextVisibleCount, getVisibleRenderWindow } = await loadSubject();
  let visibleCount = 50;

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 20, hasMore: true });

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 0, hasMore: false });
});

test("restores the viewport after prepending content", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  const savedDistance = captureScrollDistance(2000, 500);

  assert.equal(savedDistance, 1500);
  assert.equal(restoreScrollTop(2500, savedDistance), 1000);
});

test("restores top and bottom boundary positions", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 0)), 1000);
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 2000)), 3000);
});

test("shows the scroll-to-latest affordance only when the tail is out of reach (upstream 1eb5e66)", async () => {
  const { shouldShowScrollToLatest } = await loadSubject();

  // A view already at, or within the tail tolerance of, the live edge has
  // nothing to jump to.
  assert.equal(shouldShowScrollToLatest(400, 600, 1000), false);
  assert.equal(shouldShowScrollToLatest(392, 600, 1000), false);
  assert.equal(shouldShowScrollToLatest(391.99, 600, 1000), true);

  // No overflow means there is no tail to return to.
  assert.equal(shouldShowScrollToLatest(0, 600, 600), false);
  assert.equal(shouldShowScrollToLatest(0, 600, 400), false);

  // Scrolled up anywhere above the tolerance shows the button.
  assert.equal(shouldShowScrollToLatest(0, 600, 1000), true);
  assert.equal(shouldShowScrollToLatest(300, 600, 4000), true);
});

test("staged first render targets the stable window clamped to the message count", async () => {
  const { getStagedTargetCount, INITIAL_VISIBLE_COUNT, STAGED_VISIBLE_STEP } = await loadSubject();

  // 长会话：补齐目标是稳态窗口（50），分帧链从 INITIAL_VISIBLE_COUNT 起按步长爬升。
  assert.equal(getStagedTargetCount(120), 50);
  // 短会话：目标被实际消息数截断（不会为了补窗多渲染不存在的消息）。
  assert.equal(getStagedTargetCount(8), 8);
  assert.equal(getStagedTargetCount(0), 0);
  // 语义约束：初始窗口与步长都必须小于稳态窗口，否则分帧退化成一帧挂满。
  assert.ok(INITIAL_VISIBLE_COUNT < 50);
  assert.ok(STAGED_VISIBLE_STEP < 50);
  // 分帧每步的增长仍复用既有分页函数（步长参数化）。
  const { getNextVisibleCount } = await loadSubject();
  assert.equal(getNextVisibleCount(INITIAL_VISIBLE_COUNT, STAGED_VISIBLE_STEP), 20);
});
