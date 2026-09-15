/**
 * 弹层定位（纯函数 + 浏览器读值助手）：锚点固定、菜单用 position:fixed 挂 body
 * portal 时的坐标计算。核心约束——菜单必须整体落在【可视窗口】内。
 *
 * 为什么不能直接 right = innerWidth - anchorRect.right（2026-09 两起用户报告同源）：
 * - 手机端 tab 栏 ＋ 按钮：tab 条横向滚动后 ＋ 被裁得只剩边缘残影仍可点中，
 *   rect.right > innerWidth → right 为负 → 菜单整体滑出屏幕右缘点不到；
 * - PC 端工作台 WorkspaceSwitcher：绝对定位 right:0 的菜单在贴左锚点上向左生长，
 *   被中栏 overflow:hidden 裁剪并伸出屏幕左缘。
 * 两者都是「锚点部分在可视区外时定位未钳制」。这里把菜单位置与 maxHeight 一律
 * 钳进可视窗口在布局坐标里的范围——visualViewport 存在缩放/平移（捏合缩放、
 * 「电脑版网站」改宽布局视口）时，可视窗口 ≠ [0, innerWidth]，用 offsetLeft/width
 * 换算成布局坐标再钳制；scale=1 时与普通视口完全一致。
 */

export interface ViewportWindow {
  /** 可视窗口在布局坐标里的左缘（visualViewport.offsetLeft，通常 0）。 */
  viewLeft: number;
  /** 可视窗口在布局坐标里的右缘（offsetLeft + width）。 */
  viewRight: number;
  /** 可视窗口在布局坐标里的下缘（offsetTop + height）。 */
  viewBottom: number;
  /** 布局视口总宽 —— position:fixed 的 right 以它为参照。 */
  layoutWidth: number;
}

export interface MenuLayoutInput {
  /** 触发元素的 getBoundingClientRect()（布局坐标）。 */
  anchor: { top: number; bottom: number; right: number };
  /** 菜单 CSS minWidth —— 钳制计算需要的确定宽度下界。 */
  menuMinWidth: number;
  /** 菜单期望最大高度上限（再被可视区下缘余量钳小）。 */
  maxMenuHeight?: number;
  /** 菜单与锚点的垂直间距。 */
  gap?: number;
  /** 距可视窗口边缘的安全边距。 */
  margin?: number;
}

export interface MenuLayout {
  /** position:fixed 的 top（布局坐标）。 */
  top: number;
  /** position:fixed 的 right（相对布局视口右缘）。 */
  right: number;
  maxHeight: number;
}

export const DEFAULT_MENU_MARGIN = 8;
export const DEFAULT_MENU_GAP = 4;
/** maxHeight 的兜底下限：可视区被键盘压到极矮时菜单至少还能滚动。 */
export const MIN_MENU_MAX_HEIGHT = 120;

export function computeMenuLayout(input: MenuLayoutInput, view: ViewportWindow): MenuLayout {
  const gap = input.gap ?? DEFAULT_MENU_GAP;
  const margin = input.margin ?? DEFAULT_MENU_MARGIN;
  const top = Math.max(margin, input.anchor.bottom + gap);
  // 菜单右缘（布局坐标）：跟锚点右缘对齐，但绝不越过可视区右缘；
  // 也不越过可视区左缘（保底菜单宽度 + margin）——可视区比菜单还窄时
  // 对齐可视区左缘（极端缩放，接受右侧溢出，用户滚动后仍可见）。
  let menuRight = Math.min(input.anchor.right, view.viewRight - margin);
  const leftLimit = view.viewLeft + input.menuMinWidth + margin;
  if (menuRight < leftLimit) menuRight = Math.max(menuRight, view.viewLeft + input.menuMinWidth + margin);
  const heightBudget = Math.min(
    input.maxMenuHeight ?? 320,
    view.viewBottom - top - margin,
  );
  return {
    top,
    right: view.layoutWidth - menuRight,
    maxHeight: Math.max(MIN_MENU_MAX_HEIGHT, heightBudget),
  };
}

/** 读当前可视窗口（浏览器环境；SSR/测试里不要调用）。 */
export function readViewportWindow(): ViewportWindow {
  const vv = window.visualViewport;
  return {
    viewLeft: vv ? vv.offsetLeft : 0,
    viewRight: vv ? vv.offsetLeft + vv.width : window.innerWidth,
    viewBottom: vv ? vv.offsetTop + vv.height : window.innerHeight,
    layoutWidth: window.innerWidth,
  };
}
