/**
 * Mobile-shell 路由决策（纯函数，hooks/useIsMobile.ts 消费，测试见
 * shell-is-mobile.test.mjs）。
 *
 * 为什么不能只看视口宽度（旧实现 = matchMedia(max-width:640px)，毛病即本模块的由来）：
 * 手机的 CSS 布局视口可以长期 >640px，此时挂载期修正会把手机踢进桌面三栏 shell ——
 * 没有 ActivityBar 空间、没有底部 tab，用户「切换不到任何东西」（2026-09 用户报告：
 * “PC 端首页对手机适配不好，底部没有 tab”）。触发场景全部真机出现过（见
 * lib/keyboard-layout.ts 的同源事故记录）：
 * - 「电脑版网站」（request desktop site）：浏览器同时改写 UA 与布局视口（~980px），
 *   UA 嗅探与宽度断点双双失明；
 * - 「站点缩放被记住」的内核（Edge 真机 scale 停在 1.0999）：缩小后的布局视口宽度
 *   按倍数放大，越过断点；
 * - 横屏 / 折叠屏展开 / ≥640dp 平板：物理上就是宽。
 *
 * 决策规则（按序短路）：
 * 1. 布局视口 ≤640px → mobile（手机竖屏；桌面窄窗口也走 mobile —— 保留旧行为）；
 * 2. UA 判为手机（服务端 app/page.tsx 的 MOBILE_UA 种子）→ mobile：手机就是手机，
 *    宽视口（横屏/折叠/缩放/平板）也不降级到桌面 shell；桌面 shell 在触屏窄设备上
 *    不可用，而 mobile shell 是流式单列，宽屏下只是拉伸、不残废；
 * 3. 主指针为粗指针（触屏）且不存在任何精细指针（无鼠标/触控板）→ mobile：兜住
 *    「电脑版网站」改写 UA 后的场景 —— 改写 UA 改不了 pointer 媒体特性。带鼠标的
 *    触屏笔记本（any-pointer:fine 命中）不误伤；桌面纯鼠标（pointer:fine）不命中；
 * 4. 其余 → desktop。
 *
 * 已知取舍：iOS Safari + Apple Pencil（pen 计为 fine）与外接鼠标的 iPad 走 desktop
 * （与旧行为一致）；纯触屏 iPad 从 desktop 翻转为 mobile —— 触屏设备上单列 + 底部
 * tab 比被压缩的三栏可用性更好。
 */

export interface ViewportSignals {
  /** 布局视口 CSS 宽度（window.innerWidth）。 */
  viewportWidth: number;
  /** 服务端 UA 嗅探的手机判定（首帧种子，见 app/page.tsx）。 */
  uaMobile: boolean;
  /** 主指针为粗指针（matchMedia("(pointer: coarse)")）。 */
  pointerCoarse: boolean;
  /** 存在任一精细指针（matchMedia("(any-pointer: fine)")，鼠标/触控板/笔）。 */
  anyPointerFine: boolean;
}

/** 与 globals.css 的 @media (max-width: 640px) 共用的断点。 */
export const MOBILE_BREAKPOINT_PX = 640;

export function decideIsMobile(signals: ViewportSignals): boolean {
  if (signals.viewportWidth <= MOBILE_BREAKPOINT_PX) return true;
  if (signals.uaMobile) return true;
  if (signals.pointerCoarse && !signals.anyPointerFine) return true;
  return false;
}
