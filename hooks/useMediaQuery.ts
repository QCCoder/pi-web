"use client";

import { useEffect, useState } from "react";

/**
 * Live matchMedia subscription hook. Returns `initial` until mount (SSR /
 * hydration render sees the seed, no mismatch), then tracks the live match —
 * viewport crossing the breakpoint updates without remounting the consumer.
 *
 * Used by MobileShell's 768px form switch: a phone rotating between portrait
 * (<768px, MobileTabShell — bottom tab bar) and landscape (≥768px, permanent
 * left tree) keeps the shared-layer session/tab state and `mobileTab`; only
 * each shell's local page state resets.
 */
export function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const sync = () => setMatches(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [query]);
  return matches;
}
