import assert from "node:assert/strict";
import test from "node:test";
import { computeMenuLayout } from "./dropdown-layout.ts";

const base = { menuMinWidth: 220, maxMenuHeight: 320 };

test("锚点完全可见：与旧行为一致，菜单右缘对齐锚点右缘", () => {
  const layout = computeMenuLayout(
    { ...base, anchor: { top: 36, bottom: 72, right: 252 } },
    { viewLeft: 0, viewRight: 390, viewBottom: 844, layoutWidth: 390 },
  );
  assert.equal(layout.top, 76);
  assert.equal(layout.right, 390 - 252);
  assert.equal(layout.maxHeight, 320);
});

test("手机端回放：＋ 被横向滚动裁剪（rect.right 430 > 视口 390），菜单收回可视区内", () => {
  const layout = computeMenuLayout(
    { ...base, anchor: { top: 36, bottom: 72, right: 430.4 } },
    { viewLeft: 0, viewRight: 390, viewBottom: 844, layoutWidth: 390 },
  );
  assert.equal(layout.right, 8);
  // 菜单实际右缘 = layoutWidth - right = 382 ≤ 390，整体可见
  assert.ok(390 - layout.right <= 390);
});

test("「电脑版网站」/捏合缩放：可视窗口是布局视口中间一段，菜单钳进用户看到的那块", () => {
  const layout = computeMenuLayout(
    { ...base, anchor: { top: 36, bottom: 72, right: 944 } },
    { viewLeft: 300, viewRight: 690, viewBottom: 1200, layoutWidth: 980 },
  );
  // 菜单右缘 = 690 - 8 = 682 → CSS right = 980 - 682
  assert.equal(layout.right, 298);
  // 菜单左缘 = 980 - 298 - 220 = 462 ≥ viewLeft 300，整体落在可视窗口内
  assert.ok(980 - layout.right - 220 >= 300);
});

test("可视区比菜单还窄（极端缩放）：对齐可视区左缘保底可见", () => {
  const layout = computeMenuLayout(
    { ...base, anchor: { top: 36, bottom: 72, right: 680 } },
    { viewLeft: 300, viewRight: 500, viewBottom: 800, layoutWidth: 980 },
  );
  // 菜单左缘 = viewLeft + margin = 308
  assert.equal(980 - layout.right - 220, 308);
});

test("PC 端回放：矮视口下 maxHeight 被可视区下缘钳小，且不低于兜底", () => {
  const layout = computeMenuLayout(
    { menuMinWidth: 180, maxMenuHeight: 260, anchor: { top: 5, bottom: 30, right: 152 } },
    { viewLeft: 0, viewRight: 1280, viewBottom: 200, layoutWidth: 1280 },
  );
  assert.equal(layout.maxHeight, 200 - 34 - 8);
  // 键盘压到极矮：兜底 120
  const tiny = computeMenuLayout(
    { menuMinWidth: 180, maxMenuHeight: 260, anchor: { top: 5, bottom: 30, right: 152 } },
    { viewLeft: 0, viewRight: 1280, viewBottom: 60, layoutWidth: 1280 },
  );
  assert.equal(tiny.maxHeight, 120);
});
