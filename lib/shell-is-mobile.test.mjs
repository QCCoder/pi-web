import test from "node:test";
import assert from "node:assert/strict";

/**
 * Mobile-shell 路由决策测试。红态 = 旧逻辑（仅视口宽度 ≤640）在下列手机场景下
 * 全部落到 desktop —— 即用户报告的「手机打开是 PC 首页、没有底部 tab」。
 */
async function loadSubject() {
  return import("./shell-is-mobile.ts");
}

test("phone portrait → mobile (rule 1: narrow viewport)", async () => {
  const { decideIsMobile } = await loadSubject();
  assert.equal(
    decideIsMobile({ viewportWidth: 390, uaMobile: true, pointerCoarse: true, anyPointerFine: false }),
    true,
  );
  // 宽度判定的边界：恰好断点值以内/以外
  assert.equal(
    decideIsMobile({ viewportWidth: 640, uaMobile: false, pointerCoarse: false, anyPointerFine: true }),
    true,
  );
  assert.equal(
    decideIsMobile({ viewportWidth: 641, uaMobile: false, pointerCoarse: false, anyPointerFine: true }),
    false,
  );
});

test("desktop narrow window → mobile (rule 1, keeps old behavior)", async () => {
  const { decideIsMobile } = await loadSubject();
  assert.equal(
    decideIsMobile({ viewportWidth: 500, uaMobile: false, pointerCoarse: false, anyPointerFine: true }),
    true,
  );
});

test("desktop normal → desktop", async () => {
  const { decideIsMobile } = await loadSubject();
  assert.equal(
    decideIsMobile({ viewportWidth: 1920, uaMobile: false, pointerCoarse: false, anyPointerFine: true }),
    false,
  );
});

test("「电脑版网站」spoofed UA + ~980px viewport → mobile (rule 3: touch-only)", async () => {
  // UA 被改写成桌面串、布局视口被撑到 980px —— 只剩 pointer 媒体特性可信。
  const { decideIsMobile } = await loadSubject();
  assert.equal(
    decideIsMobile({ viewportWidth: 980, uaMobile: false, pointerCoarse: true, anyPointerFine: false }),
    true,
  );
});

test("remembered zoom-out / landscape / foldable with mobile UA → mobile (rule 2)", async () => {
  const { decideIsMobile } = await loadSubject();
  // 390px 手机被记住 0.5 缩放 → 布局视口 780px；pointer 媒体特性在坏内核上不可信
  // （X5 老内核假阴性），UA 种子仍然兜住。
  assert.equal(
    decideIsMobile({ viewportWidth: 780, uaMobile: true, pointerCoarse: false, anyPointerFine: false }),
    true,
  );
  assert.equal(
    decideIsMobile({ viewportWidth: 844, uaMobile: true, pointerCoarse: true, anyPointerFine: false }),
    true,
  );
});

test("touch laptop (mouse + touchscreen) → desktop (not rule 3)", async () => {
  const { decideIsMobile } = await loadSubject();
  // 主指针鼠标（pointer:coarse 不命中）的常规触屏笔记本
  assert.equal(
    decideIsMobile({ viewportWidth: 1440, uaMobile: false, pointerCoarse: false, anyPointerFine: true }),
    false,
  );
  // 平板模式（触屏为主）但带触控板 —— any-pointer:fine 命中，不下放 mobile shell
  assert.equal(
    decideIsMobile({ viewportWidth: 1440, uaMobile: false, pointerCoarse: true, anyPointerFine: true }),
    false,
  );
});
