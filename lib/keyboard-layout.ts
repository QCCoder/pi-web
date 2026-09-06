/**
 * 移动端键盘适配 —— 纯公式层（hooks/useVisualViewportKeyboard 消费）。
 *
 * 键盘弹出时不同内核把“遮挡”表达在不同的信号里，可分两类：
 *
 * ① resizes-visual 类（Android Chrome/Edge、iOS）：布局视口不缩（clientHeight
 *    不变），只有 visualViewport.height 缩。**必须走 native 模式（不接管）**：
 *    这类内核的键盘 reveal 是【窗口级平移】——浏览器把整个页面渲染层向上提
 *    以露出聚焦输入框，该平移发生在 JS 所有可读信号之外（scrollY/vvTop/
 *    html rect.top 全读 0，2026-09-06 Edge 151 真机截图实测）。页面无法测量
 *    它也就无法补偿它；若此时再由 JS 压短应用高度，浏览器不会撤回已发生的
 *    平移，应用被悬在可视区上方，下方留出大段空画布 —— 正是“键盘与输入框
 *    之间大片空白”的根因。native 模式下高度保持 100%/100dvh（= 布局视口），
 *    键盘遮挡与输入框 reveal 全部交给浏览器原生处理。
 * ② squeeze 类（微信 XWeb 等 resizes-content 但 dvh 不跟随的内核、无 vv 的
 *    老内核）：布局视口自己缩（或 innerHeight 缩）。这类内核浏览器不会替页
 *    面处理高度，需要 JS 把应用压到可视高（--app-height）并补偿 reveal 平移。
 *
 * reveal 平移补偿（squeeze 路径用，computeKeyboardLift）：内核把页面顶起的
 * 表达各异 —— iOS scroll 型在 scrollY/rect 与 vvTop 同时可见；iOS content-inset
 * 型只有 rect.top 量得到。三信号取 MAX（同屏平移会在两个信号里重复出现，
 * 求和 = 双重补偿）。
 */

/**
 * 键盘态判定阈值：视口比基准小超过此值才认定为“键盘遮挡”。
 * 键盘几乎总 ≥200px；URL 栏/工具栏收缩 <150px 不会误判。
 */
export const KEYBOARD_MIN_GAP_PX = 150;

/**
 * 键盘开启态的布局策略。
 *  - native：resizes-visual 类内核 —— 不压高、不平移、不锁滚动，但要把应用钉在
 *    布局视口全高（appHeight=live）：此内核的 100dvh 会随键盘缩（Edge 151 真机
 *    实测键盘开启时 dvh=535<live=682），放任 dvh 会在可视带下方留出画布空带；
 *    钉到 live 后应用占满布局视口，浏览器把可视带平移到布局底时，贴底输入框
 *    正好落在地址栏上沿。
 *  - squeeze：布局视口自己缩（或老内核）—— 应用压到 appHeight。
 *
 * @param baselineLayoutHeight 键盘关闭态采样的 documentElement.clientHeight（0 = 尚无基准，按 live 处理）
 * @param liveLayoutHeight     当前 documentElement.clientHeight
 * @param visualHeight         visualViewport.height（无 vv 内核 = innerHeight 兜底）
 * @param hasVisualViewport    window.visualViewport 是否存在
 */
export function resolveKeyboardStrategy(
  baselineLayoutHeight: number,
  liveLayoutHeight: number,
  visualHeight: number,
  hasVisualViewport: boolean,
): KeyboardStrategy {
  const baseline = baselineLayoutHeight > 0 ? baselineLayoutHeight : liveLayoutHeight;
  // 布局视口自己缩了（XWeb 类 / 部分国产壳）：必须压高，否则 100dvh 兜底过期
  if (baseline - liveLayoutHeight > KEYBOARD_MIN_GAP_PX) {
    return { mode: "squeeze", appHeight: Math.max(0, Math.round(visualHeight)) };
  }
  // 只有 vv 缩（resizes-visual / iOS）：不接管变形，只钉住布局视口全高。
  if (hasVisualViewport && baseline - visualHeight > KEYBOARD_MIN_GAP_PX) {
    return { mode: "native", appHeight: Math.max(0, Math.round(liveLayoutHeight)) };
  }
  // 其余（无 vv 老内核：innerHeight 随键盘缩而 clientHeight 不缩）：维持压高
  return { mode: "squeeze", appHeight: Math.max(0, Math.round(visualHeight)) };
}

export type KeyboardStrategy =
  | { mode: "native"; appHeight: number }
  | { mode: "squeeze"; appHeight: number };

/**
 * 计算键盘开启态 body 需要的 translateY 补偿量（px，≥0）。仅 squeeze 路径使用。
 *
 * @param htmlTop  document.documentElement.getBoundingClientRect().top（≤0 表示被顶起）
 * @param vvTop    visualViewport.offsetTop（无 vv 的老内核传 0）
 */
export function computeKeyboardLift(htmlTop: number, vvTop: number): number {
  return Math.max(0, Math.round(-htmlTop), Math.round(vvTop));
}

/**
 * VirtualKeyboard API（Chromium 94+，navigator.virtualKeyboard.overlaysContent=true 后）
 * 路径的键盘态判定。
 *
 * 为什么需要它：resizes-visual 内核里 visualViewport.height 把【键盘 + 浏览器自身
 * 底部 UI（Edge 底部地址栏/工具栏）】一起扣掉（真机实测 2026-09-05：vis=367，但
 * 键盘真实顶边在更下面，红条诊断确认应用底与键盘顶之间有大片空白）。vk.boundingRect
 * 是浏览器自己知道的键盘真实矩形，top 即键盘真实顶边 —— 应用压到 vk.top 就精准贴键。
 *
 * @param rect       navigator.virtualKeyboard.boundingRect（键盘关闭时 height=0）
 * @param liveLayout documentElement.clientHeight（overlays 模式下不随键盘缩，作兑底）
 */
export function computeVkKeyboardState(
  rect: { top: number; height: number },
  liveLayout: number,
): { open: boolean; visibleHeight: number } {
  if (!(rect.height > 0)) return { open: false, visibleHeight: liveLayout };
  // top 异常（≤0，键盘盖住整屏/怪矩形）时退回 live-height
  const visible = rect.top > 0 ? rect.top : Math.max(0, liveLayout - rect.height);
  return { open: true, visibleHeight: visible };
}
