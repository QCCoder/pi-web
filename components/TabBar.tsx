"use client";

import { useState, type ReactNode } from "react";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import { type Tab, FILES_TAB_ID } from "@/lib/tab-types";

// Re-exported for the existing import sites (shell state + shells); the
// definitions live in lib/tab-types.ts (shared with the pure session-tab model).
export type { Tab };
export { FILES_TAB_ID };

/** A pinned, non-closable module tab of the right dock (文件/Loops/… — right-dock
 *  design §2). Rendered before every file/session tab, in order. */
export interface LeadingTabEntry {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Pinned, non-closable leading module tabs of the right dock
   *  (文件/Loops/…). Rendered in order before every file/session tab.
   *  Narrow panels collapse them to icon-only via the `.dock-module-tab`
   *  container-query rules in globals.css (module tabs never scroll away). */
  leadingTabs?: LeadingTabEntry[];
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, leadingTabs }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {leadingTabs?.map((tab) => (
        <div
          key={tab.id}
          className="dock-module-tab"
          onClick={() => onSelectTab(tab.id)}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          title={tab.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 36,
            paddingLeft: 12,
            paddingRight: 12,
            borderRight: "1px solid var(--border)",
            borderTop: tab.id === activeTabId ? "2px solid var(--accent)" : "2px solid transparent",
            background: tab.id === activeTabId ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: 12,
            color: tab.id === activeTabId ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            transition: "background 0.1s, color 0.1s",
          }}
        >
          <span style={{ flexShrink: 0, opacity: tab.id === activeTabId ? 1 : 0.7, display: "flex", alignItems: "center" }}>
            {tab.icon ?? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            )}
          </span>
          <span className="dock-module-tab-label" style={{ fontWeight: tab.id === activeTabId ? 500 : 400 }}>
            {tab.label}
          </span>
        </div>
      ))}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              borderTop: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.kind === "file" ? getFileIcon(tab.label, 13) : tab.kind === "terminal" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.kind === "file" ? tab.filePath : tab.label}
            >
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
               title={t("i18n.close")}
               aria-label={`${t("i18n.close")} ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
