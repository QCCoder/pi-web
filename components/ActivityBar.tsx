"use client";

import type { ReactNode } from "react";
import type { WorkspaceCapability } from "@/lib/workspaces/types";

/**
 * The single-focus navigation views surfaced by the workspace Activity Bar.
 * Order is significant (redesign §6 decision 6):
 *   sessions → explorer → repositories → knowledge → loop → work-items.
 */
export type SidebarView =
  | "sessions"
  | "explorer"
  | "repositories"
  | "knowledge"
  | "loop"
  | "work-items";

interface ActivityViewDef {
  view: SidebarView;
  /** capability that gates this view, or null for always-on (sessions/explorer). */
  capability: WorkspaceCapability | null;
  label: string;
  title: string;
  icon: ReactNode;
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

/**
 * Canonical Activity Bar definition, in the strict icon order from redesign
 * §6 decision 6. `sessions` and `explorer` are always-on (`capability: null`).
 */
export const ACTIVITY_VIEW_ORDER: ActivityViewDef[] = [
  {
    view: "sessions",
    capability: null,
    label: "会话",
    title: "会话",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    view: "explorer",
    capability: null,
    label: "Explorer",
    title: "文件资源管理器",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    view: "repositories",
    capability: "repositories",
    label: "仓库",
    title: "代码仓库",
    icon: (
      <svg {...ICON_PROPS}>
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    ),
  },
  {
    view: "knowledge",
    capability: "knowledge",
    label: "知识库",
    title: "知识库",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
  },
  {
    view: "loop",
    capability: "loop",
    label: "Loop",
    title: "自动化 Loop",
    icon: (
      <svg {...ICON_PROPS}>
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    ),
  },
  {
    view: "work-items",
    capability: "work-items",
    label: "工作项",
    title: "工作项",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
];

/** The views actually available for a workspace, in canonical order. */
export function visibleActivityViews(capabilities: WorkspaceCapability[]): SidebarView[] {
  return ACTIVITY_VIEW_ORDER.filter(
    (item) => item.capability === null || capabilities.includes(item.capability),
  ).map((item) => item.view);
}

export function activityViewLabel(view: SidebarView): string {
  return ACTIVITY_VIEW_ORDER.find((item) => item.view === view)?.label ?? view;
}

interface Props {
  /** `vertical` = left icon strip (desktop); `horizontal` = bottom tab bar (mobile). */
  variant: "vertical" | "horizontal";
  activeView: SidebarView;
  capabilities: WorkspaceCapability[];
  onSwitch: (view: SidebarView) => void;
  /** Extra non-focus highlight (e.g. when the center panel shows the loops view). */
  highlightView?: SidebarView | null;
}

/**
 * The workspace Activity Bar — a single-focus capability switcher (redesign
 * §3 decision 2). Renders one icon per available view in the canonical order;
 * exactly one view is active at a time. The parent owns `activeView` and
 * renders the matching focused view to the side.
 */
export function ActivityBar({ variant, activeView, capabilities, onSwitch, highlightView }: Props) {
  const items = ACTIVITY_VIEW_ORDER.filter(
    (item) => item.capability === null || capabilities.includes(item.capability),
  );

  const containerStyle: React.CSSProperties =
    variant === "vertical"
      ? {
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          width: 44,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-panel)",
          padding: "4px 0",
          overflowY: "auto",
        }
      : {
          display: "flex",
          flexDirection: "row",
          flexShrink: 0,
          height: 48,
          borderTop: "1px solid var(--border)",
          background: "var(--bg-panel)",
          overflowX: "auto",
        };

  return (
    <nav role="tablist" aria-label="工作区导航" style={containerStyle}>
      {items.map((item) => {
        const isActive = activeView === item.view;
        const isHighlighted = highlightView === item.view;
        const btnStyle: React.CSSProperties = {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          ...(variant === "vertical"
            ? { width: "100%", height: 46 }
            : { flex: "1 0 auto", minWidth: 56, height: "100%" }),
          border: 0,
          background: isActive ? "var(--bg-selected)" : "transparent",
          color: isActive || isHighlighted ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          padding: 0,
          position: "relative",
          transition: "color 0.12s, background 0.12s",
        };
        const indicator = isActive ? (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              background: "var(--accent)",
              ...(variant === "vertical"
                ? { left: 0, top: 8, bottom: 8, width: 2 }
                : { top: 0, left: 10, right: 10, height: 2 }),
            }}
          />
        ) : null;
        return (
          <button
            key={item.view}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={item.title}
            aria-label={item.label}
            style={btnStyle}
            onClick={() => onSwitch(item.view)}
          >
            {indicator}
            {item.icon}
            <span style={{ fontSize: 10, lineHeight: 1 }}>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
