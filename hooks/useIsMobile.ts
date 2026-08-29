"use client";

import { useContext, useEffect, useState } from "react";
import { IsMobileContext } from "@/components/shell/context";

// Mobile breakpoint shared with app/globals.css (max-width: 640px).
const MOBILE_QUERY = "(max-width: 640px)";

/**
 * The single viewport subscription behind the shell split.
 *
 * `initial` is the server's User-Agent guess (see `app/page.tsx`): it seeds
 * BOTH the SSR render and the hydration render so the two agree, then is
 * corrected against the real viewport (matchMedia) right after mount. Without
 * a server-side guess every phone SSRs the desktop shell and only flips to
 * mobile once the whole bundle has hydrated — seconds on a slow device.
 */
export function useViewportIsMobile(initial = false): boolean {
  const [isMobile, setIsMobile] = useState(initial);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsMobile(mql.matches);
    sync(); // correct a wrong UA guess immediately after mount
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);
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
