"use client";

import { useContext, useEffect, useState } from "react";
import { IsMobileContext } from "@/components/shell/context";
import { decideIsMobile, MOBILE_BREAKPOINT_PX } from "@/lib/shell-is-mobile";

// Mobile breakpoint shared with app/globals.css (max-width: 640px).
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;
const POINTER_COARSE_QUERY = "(pointer: coarse)";
const ANY_POINTER_FINE_QUERY = "(any-pointer: fine)";

/**
 * The single viewport subscription behind the shell split.
 *
 * `initial` is the server's User-Agent guess (see `app/page.tsx`): it seeds
 * BOTH the SSR render and the hydration render so the two agree, then is
 * corrected by `decideIsMobile` (`lib/shell-is-mobile.ts`) right after mount.
 * Without a server-side guess every phone SSRs the desktop shell and only
 * flips to mobile once the whole bundle has hydrated — seconds on a slow
 * device.
 *
 * The correction is NOT width-only anymore: a phone whose CSS layout viewport
 * is wider than 640px (「电脑版网站」spoofing the UA AND widening the layout,
 * remembered zoom-out, landscape, foldables) used to be kicked into the
 * desktop three-column shell — no bottom tabs, nothing tappable
 * (“PC 端首页、底部没有 tab”). The decision now also trusts the UA seed
 * (never downgrade a UA-mobile guess just because the viewport is wide) and
 * the touch-only pointer signals (catches UA spoofing, which cannot rewrite
 * media features).
 */
export function useViewportIsMobile(initial = false): boolean {
  const [isMobile, setIsMobile] = useState(initial);
  useEffect(() => {
    const narrow = window.matchMedia(MOBILE_QUERY);
    const coarse = window.matchMedia(POINTER_COARSE_QUERY);
    const anyFine = window.matchMedia(ANY_POINTER_FINE_QUERY);
    const sync = () =>
      setIsMobile(
        decideIsMobile({
          viewportWidth: window.innerWidth,
          uaMobile: initial,
          pointerCoarse: coarse.matches,
          anyPointerFine: anyFine.matches,
        }),
      );
    sync(); // correct a wrong UA guess immediately after mount
    narrow.addEventListener("change", sync);
    coarse.addEventListener("change", sync);
    anyFine.addEventListener("change", sync);
    // resize 兜底：部分内核 mql change 事件不可靠（见 keyboard 层同类记录），
    // 决策本身只依赖实时读值，重算一次是廉价的。
    window.addEventListener("resize", sync);
    return () => {
      narrow.removeEventListener("change", sync);
      coarse.removeEventListener("change", sync);
      anyFine.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, [initial]);
  return isMobile;
}

/**
 * Whether the current shell is mobile. Inside `<AppShell>` this reads the
 * shared `IsMobileContext` (one subscription, consistent with the server's
 * UA guess, so every caller SSRs the same shell variant); outside the shell
 * tree (`null`) it falls back to a standalone viewport subscription.
 */
export function useIsMobile(): boolean {
  const fromShell = useContext(IsMobileContext);
  const viewportMobile = useViewportIsMobile();
  return fromShell ?? viewportMobile;
}
