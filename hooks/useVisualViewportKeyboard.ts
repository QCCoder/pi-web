"use client";

import { useEffect } from "react";

/**
 * 移动端虚拟键盘高度同步 —— 修复“键盘和输入框之间有一大片空白”。
 *
 * 现象：键盘弹起时布局视口（100dvh）往往不缩小，浏览器为露出聚焦输入框还会把
 * 页面顶起一段；固定高度的应用被顶出可视区，输入框/底部 tab 栏悬在半空、它们
 * 与键盘之间露出大片空白。
 *
 * 各内核的坑位与对策（本 hook 是唯一的键盘适配层，配合 globals.css / layout.tsx）：
 * - 检测基准用 documentElement.clientHeight，绝不用 window.innerHeight —— iOS
 *   Safari 的 innerHeight 在键盘弹出时也跟着缩（v1 用它导致永远检测不到）。
 *   基准只在“前后都不在键盘态”时采样缓存：开着时 html 已被压短，live 不可信。
 * - 两条键盘判据满足其一即可：① visualViewport 比基准小 ≥150px（iOS / Android
 *   resizes-visual 内核）；② clientHeight 自己比基准小 ≥150px（微信 XWeb 等原生
 *   缩布局视口、但 dvh 不跟随的内核 —— 这时 app 的 100dvh 兜底值是过期的）。
 *   键盘几乎总是 ≥200px；URL 栏/工具栏收缩 <150px 不会误判。
 * - 老 X5 内核没有 window.visualViewport：回退用 innerHeight 当可视高度，配合
 *   轮询（这些内核 innerHeight 会随键盘缩，clientHeight 不缩）。
 * - 事件驱动的内核差异太大（有的键盘弹出只发 window resize、有的一个事件都
 *   不发、reveal 平移发生在事件停止之后）：聚焦期间 + 关闭后 1.2s 内以 250ms
 *   轮询实测兜底，事件只是加速器。
 * - reveal 平移补偿：浏览器为露出聚焦输入框会把页面顶起（scroll 型能从
 *   scrollY 读到；iOS content-inset 型 scrollY/offsetTop 都是 0），每帧实测
 *   -html.getBoundingClientRect().top 得出顶起量设为 --app-lift，body
 *   translateY 反向抵消 —— 两种机制都量得到。
 * - iOS 对 font-size<16px 的输入框聚焦会自动放大页面：globals.css 的
 *   pointer:coarse 规则统一兜底；这里再以 scale≤1.05 作守卫（用户手动放大时
 *   不接管布局）。
 *
 * 键盘收起（blur / 高度恢复）时移除 class 与变量，回到 100dvh。
 * 桌面（非 coarse pointer）零开销：监听器不注册。
 *
 * 调试：URL 加 ?kbdebug=1（持久化到 localStorage，?kbdebug=0 关闭）会在左上角
 * 显示实时指标（可视高度/基准/offset/scale/顶起量/检测状态），用于真机定位。
 */

/** visualViewport / clientHeight 比基准小超过此值才认定为“键盘挡住”。 */
const KEYBOARD_MIN_GAP_PX = 150;
/** 用户手动缩放超出此窗口时不接管布局（防 pinch-zoom 误判成键盘）。双向：
 *  zoom-in（scale>1.05）是最初的守卫；zoom-out（scale<0.95，如手机上“电脑版
 *  网站”缩放显示）时 vv 天然只是布局视口的一个窗口，gap 恒大于 0 却根本没有
 *  键盘 —— 不设下界会把应用错误压短，触屏 PC/宽屏设备上表现为输入区与窗口
 *  底部之间凭空多出大片空白。真键盘弹出时 scale 恒为 1，双向窗口安全。 */
const MIN_VIEWPORT_SCALE = 0.95;
const MAX_VIEWPORT_SCALE = 1.05;
/** 聚焦期间与关闭后的实测轮询间隔（兜不发事件的内核与晚到的 reveal 平移）。 */
const POLL_INTERVAL_MS = 250;
/** focusout 后继续轮询的时长（键盘收起动画 + 平移回落）。 */
const POLL_AFTER_FOCUSOUT_MS = 1200;

function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

function debugProbeEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("kbdebug");
    if (flag === "1") {
      localStorage.setItem("pi-kb-debug", "1");
      return true;
    }
    if (flag === "0") {
      localStorage.removeItem("pi-kb-debug");
      return false;
    }
    return localStorage.getItem("pi-kb-debug") === "1";
  } catch {
    return false;
  }
}

export function useVisualViewportKeyboard(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const vv = window.visualViewport; // 老 X5 内核没有 —— 回退 innerHeight
    const debug = debugProbeEnabled();
    // [TEMP-KBDEBUG] 真机数据自动回传（仅 kbdebug 开启时）：每 ~800ms 最多一条
    // POST /api/kbdebug，服务端落 /tmp/pi-kbdebug.log —— 免去人肉读数。诊断完删除。
    const pointerCoarse = window.matchMedia("(pointer: coarse)").matches;
    let lastBeaconAt = 0;

    let raf = 0;
    let keyboardOpen = false;
    /** 键盘未开时采样的布局视口全高（documentElement.clientHeight）。 */
    let baselineLayoutHeight = 0;
    let lastFocusOutAt = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let debugEl: HTMLDivElement | null = null;

    if (debug) {
      debugEl = document.createElement("div");
      debugEl.style.cssText =
        "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;" +
        "font:10px/1.5 ui-monospace,monospace;background:rgba(0,0,0,.78);color:#4ade80;" +
        "padding:4px 8px;white-space:pre;border-radius:0 0 6px 0";
      document.documentElement.appendChild(debugEl);
    }

    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const root = document.documentElement;
        const liveLayout = root.clientHeight;
        const visualHeight = vv ? vv.height : window.innerHeight;
        const scale = vv ? vv.scale : 1;
        // 双判据：visualViewport 缩了（绝大多数内核）或布局视口自己缩了
        // （微信 XWeb 等原生 resizes-content 但 dvh 不跟随 —— 100dvh 兜底过期）。
        const gap = (baselineLayoutHeight || liveLayout) - visualHeight;
        const layoutGap = (baselineLayoutHeight || liveLayout) - liveLayout;
        const nextOpen =
          isEditableFocused() &&
          scale >= MIN_VIEWPORT_SCALE &&
          scale <= MAX_VIEWPORT_SCALE &&
          (gap > KEYBOARD_MIN_GAP_PX || layoutGap > KEYBOARD_MIN_GAP_PX);
        // 基准只在“前后都不在键盘态”时更新：开着时 html 已被压到 --app-height，
        // 关闭瞬间它还挂着旧值，live 都不可信。
        if (!keyboardOpen && !nextOpen) baselineLayoutHeight = liveLayout;
        if (nextOpen !== keyboardOpen) {
          keyboardOpen = nextOpen;
          root.classList.toggle("pi-keyboard-open", keyboardOpen);
        }
        if (keyboardOpen) {
          root.style.setProperty("--app-height", `${Math.round(visualHeight)}px`);
          // 实测页面被 reveal 平移顶起的量（content-inset 平移下 scrollY/offsetTop
          // 均为 0，只有 rect 量得到），body translateY 反向抵消。
          const lift = -root.getBoundingClientRect().top;
          root.style.setProperty("--app-lift", `${Math.max(0, Math.round(lift))}px`);
          if (window.scrollY !== 0 || root.scrollTop !== 0) window.scrollTo(0, 0);
        } else {
          root.style.removeProperty("--app-height");
          root.style.removeProperty("--app-lift");
        }
        // 聚焦期间 + 关闭后短时间内持续轮询：不少内核键盘弹出/平移不发自适应事件。
        const shouldPoll = isEditableFocused() || Date.now() < lastFocusOutAt + POLL_AFTER_FOCUSOUT_MS;
        if (shouldPoll && pollTimer == null) pollTimer = setInterval(apply, POLL_INTERVAL_MS);
        if (!shouldPoll && pollTimer != null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (debugEl) {
          debugEl.textContent =
            `kb=${keyboardOpen ? 1 : 0} live=${liveLayout} base=${baselineLayoutHeight}\n` +
            `vis=${Math.round(visualHeight)} vvTop=${Math.round(vv ? vv.offsetTop : 0)} scale=${scale.toFixed(2)}\n` +
            `scrollY=${Math.round(window.scrollY)} lift=${keyboardOpen ? root.style.getPropertyValue("--app-lift") : "-"}`;
        }
        if (debug && Date.now() - lastBeaconAt > 800) {
          lastBeaconAt = Date.now();
          void fetch("/api/kbdebug", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kb: keyboardOpen ? 1 : 0,
              focused: isEditableFocused(),
              live: liveLayout,
              base: baselineLayoutHeight,
              vis: Math.round(visualHeight),
              vvTop: Math.round(vv ? vv.offsetTop : 0),
              scale,
              scrollY: Math.round(window.scrollY),
              lift: keyboardOpen ? root.style.getPropertyValue("--app-lift") : null,
              htmlTop: Math.round(root.getBoundingClientRect().top),
              innerH: window.innerHeight,
              hasVv: Boolean(vv),
              pointerCoarse,
              ua: navigator.userAgent,
              url: location.pathname,
            }),
          }).catch(() => {});
        }
      });
    };

    const onFocusOut = () => {
      lastFocusOutAt = Date.now();
      apply();
    };

    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
    window.addEventListener("scroll", apply, { passive: true });
    document.addEventListener("focusin", apply);
    document.addEventListener("focusout", onFocusOut);
    apply();
    return () => {
      if (vv) {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      }
      window.removeEventListener("resize", apply);
      window.removeEventListener("scroll", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", onFocusOut);
      cancelAnimationFrame(raf);
      if (pollTimer != null) clearInterval(pollTimer);
      document.documentElement.classList.remove("pi-keyboard-open");
      document.documentElement.style.removeProperty("--app-height");
      document.documentElement.style.removeProperty("--app-lift");
      if (debugEl) debugEl.remove();
    };
  }, []);
}
