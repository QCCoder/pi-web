"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { useAppShellState } from "./useAppShellState";

/**
 * The shell-state context. `AppShell` calls `useAppShellState()` once and
 * provides the result here; `DesktopShell` / `MobileShell` consume it through
 * `useShell()`. The state layer is shell-agnostic (no isMobile branches) —
 * cross-shell navigation intents travel as focus signals
 * (`chatFocusKey` / `panelFocus`) that only the mobile shell reacts to.
 */
export type AppShellState = ReturnType<typeof useAppShellState>;

const AppShellContext = createContext<AppShellState | null>(null);

export function AppShellProvider({ value, children }: { value: AppShellState; children: ReactNode }) {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useShell(): AppShellState {
  const value = useContext(AppShellContext);
  if (!value) throw new Error("useShell must be used inside <AppShellProvider>");
  return value;
}

/**
 * The mobile-shell flag. `AppShell` owns the single viewport subscription
 * (`useViewportIsMobile`, seeded by the server's User-Agent guess — see
 * `app/page.tsx`) and provides it here, so every `useIsMobile()` caller SSRs
 * the same shell variant as the server rendered and no phone paints the
 * desktop layout first. `null` = outside the shell tree; callers then fall
 * back to their own viewport subscription.
 */
export const IsMobileContext = createContext<boolean | null>(null);
