"use client";

import type { ReactNode } from "react";
import type { WorkspaceCapability } from "@/lib/workspaces/types";

/**
 * The single-focus navigation views surfaced by the workspace Activity Bar
 * (the left icon rail on desktop / the bottom tab bar on mobile).
 *
 * Two groups with different scopes:
 * - MODULE views (workbench / knowledge / loop / work-items) are
 *   workspace-scoped and capability-gated — their icons appear only when the
 *   active workspace has the capability. Order: workbench → knowledge → loop
 *   → work-items. (The former standalone 仓库 view was removed — repo browsing
 *   lives in the workbench file tree, add/manage in settings.)
 * - GLOBAL views are app-scoped. The desktop rail shows 模型/Skills/插件 (config
 *   views — LIST in the middle column + DETAIL in the right column, see
 *   `ConfigView`), then 归档
 *   (which additionally requires an active workspace — its content is
 *   workspace-filtered), with 设置 pinned to the very bottom. A visual
 *   separator marks the module/global scope boundary. The mobile bottom bar
 *   keeps five tabs: the module views + 设置 only — the config views stay in
 *   the settings index subpages on mobile.
 */
/**
 * The config views (模型 / Skills / 插件) — strict three-column views on
 * desktop: their rail icons put the config's LIST in the MIDDLE column and
 * its DETAIL in the RIGHT column (the list portals the detail across, see
 * AppShell's configPortalNode). They never persist into the `pi-active-view`
 * / `pi-active-panel` keys. Mobile has no rail icons for them (the settings
 * index subpages serve the same content there).
 */
export type ConfigView = "models" | "skills" | "plugins";

/** Type guard: is this a config view (list in middle column, detail in the
 *  right column) vs a regular middle-column panel? */
export function isConfigView(view: SidebarView): view is ConfigView {
  return view === "models" || view === "skills" || view === "plugins";
}

export type SidebarView =
  | "workbench"
  | "knowledge"
  | "loop"
  | "work-items"
  | ConfigView
  | "archive"
  | "settings";

interface ActivityViewDef {
  view: SidebarView;
  /** capability that gates this view, or null for always-on views. */
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
 * Canonical module-view order: workbench → knowledge → loop → work-items.
 * `workbench` is always-on (`capability: null`) — it merges the former
 * sessions + explorer views into one stacked layout (会话 above, 文件 below).
 */
export const ACTIVITY_VIEW_ORDER: ActivityViewDef[] = [
  {
    view: "workbench",
    capability: null,
    label: "工作台",
    title: "工作台",
    icon: (
      <svg {...ICON_PROPS}>
        {/* A box split horizontally: two stacked panes (会话 above, 文件 below). */}
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="10" x2="21" y2="10" />
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

/** Desktop rail global order: 模型 → Skills → 插件 → 归档 → 设置 (settings
 *  bottom-pinned). These are the icons rendered after the module separator in
 *  the vertical rail — including the three config views, whose LIST renders
 *  in the middle column with the DETAIL portaled into the right column. */
export const RAIL_GLOBAL_VIEWS: SidebarView[] = [
  "models",
  "skills",
  "plugins",
  "archive",
  "settings",
];

/** App-scoped views that follow the module group (archive), plus the
 *  bottom-pinned settings entry. Archive needs an active workspace — callers
 *  pass `hasWorkspace` to gate it. */
const ARCHIVE_VIEW: ActivityViewDef = {
  view: "archive",
  capability: null,
  label: "归档",
  title: "归档（回收站）",
  icon: (
    <svg {...ICON_PROPS}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  ),
};

/** Config-view rail icons (desktop vertical variant only). Labels match the
 *  settings index rows so the two entry points read as the same thing. */
const MODELS_VIEW: ActivityViewDef = {
  view: "models",
  capability: null,
  label: "模型",
  title: "模型（models.json）",
  icon: (
    <svg {...ICON_PROPS}>
      {/* cpu/chip — model provider configuration */}
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2" />
      <path d="M15 20v2" />
      <path d="M9 2v2" />
      <path d="M9 20v2" />
      <path d="M2 15h2" />
      <path d="M2 9h2" />
      <path d="M20 15h2" />
      <path d="M20 9h2" />
    </svg>
  ),
};

const SKILLS_VIEW: ActivityViewDef = {
  view: "skills",
  capability: null,
  label: "Skills",
  title: "Skills",
  icon: (
    <svg {...ICON_PROPS}>
      {/* sparkles — skill surface */}
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  ),
};

const PLUGINS_VIEW: ActivityViewDef = {
  view: "plugins",
  capability: null,
  label: "插件",
  title: "插件",
  icon: (
    <svg {...ICON_PROPS}>
      {/* puzzle piece — package plugins */}
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
    </svg>
  ),
};

const SETTINGS_VIEW: ActivityViewDef = {
  view: "settings",
  capability: null,
  label: "设置",
  title: "设置",
  icon: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

/** Global (app-scoped) MIDDLE-COLUMN panels, in order: archive then settings.
 *  This is the persistence/validation surface (`pi-active-panel`, the stale-
 *  view fallback in AppShell) — deliberately NOT the rail icon list: the
 *  config views (models/skills/plugins) are three-column split views and
 *  must never be restorable as `sidebarView`. The rail's icon order lives in
 *  RAIL_GLOBAL_VIEWS above. */
export const GLOBAL_ACTIVITY_VIEWS: SidebarView[] = ["archive", "settings"];

/** The views actually available for a workspace, in canonical order. Module
 *  views are capability-filtered; the middle-column global panels (archive /
 *  settings) are always present (the caller decides whether "archive" is
 *  actionable). Config views are NOT included — they are three-column split
 *  views (list in the middle column, detail in the right column; see
 *  RAIL_GLOBAL_VIEWS). Stale persisted values from the former sessions/
 *  explorer split simply fail the `includes` check and fall back to
 *  "workbench" in the caller. */
export function visibleActivityViews(capabilities: WorkspaceCapability[]): SidebarView[] {
  return ACTIVITY_VIEW_ORDER
    .filter((item) => item.capability === null || capabilities.includes(item.capability))
    .map((item) => item.view)
    .concat(GLOBAL_ACTIVITY_VIEWS);
}

export function activityViewLabel(view: SidebarView): string {
  const all = [ ...ACTIVITY_VIEW_ORDER, MODELS_VIEW, SKILLS_VIEW, PLUGINS_VIEW, ARCHIVE_VIEW, SETTINGS_VIEW ];
  return all.find((item) => item.view === view)?.label ?? view;
}

interface Props {
  /** `vertical` = left icon strip (desktop); `horizontal` = bottom tab bar (mobile). */
  variant: "vertical" | "horizontal";
  /** The active panel, or null when nothing is open (mobile drawer closed). */
  activeView: SidebarView | null;
  capabilities: WorkspaceCapability[];
  onSwitch: (view: SidebarView) => void;
  /** Extra non-focus highlight (e.g. when the loop manager is open in the panel). */
  highlightView?: SidebarView | null;
  /** Whether an active workspace exists — gates the archive icon (its content
   *  is workspace-scoped). Settings is always available. */
  hasWorkspace?: boolean;
}

/**
 * The Activity Bar — a single-focus switcher between the middle-column panels
 * (redesign §3 decision 2). Module views render first (capability-gated), then
 * a scope separator and the global views (archive, settings — the latter pinned
 * to the rail bottom on desktop). The parent owns `activeView` and renders the
 * matching panel beside the rail.
 */
export function ActivityBar({ variant, activeView, capabilities, onSwitch, highlightView, hasWorkspace = true }: Props) {
  const moduleItems = ACTIVITY_VIEW_ORDER.filter(
    (item) => item.capability === null || capabilities.includes(item.capability),
  );
  // Desktop rail: config views (models/skills/plugins — LIST in the middle
  // column, DETAIL in the right column) + archive (needs a workspace) +
  // bottom-pinned settings.
  // Mobile bottom bar: settings only (module views above + this = 5 tabs; the
  // config views live in the settings index subpages, archive in a settings
  // index row — one row of five fits a 375px viewport).
  const globalItems: ActivityViewDef[] = variant === "vertical"
    ? [
        MODELS_VIEW,
        SKILLS_VIEW,
        PLUGINS_VIEW,
        ...(hasWorkspace ? [ARCHIVE_VIEW] : []),
        SETTINGS_VIEW,
      ]
    : [SETTINGS_VIEW];

  const renderItem = (item: ActivityViewDef) => {
    const isActive = activeView === item.view;
    const isHighlighted = highlightView === item.view;
    const btnStyle: React.CSSProperties = {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      ...(variant === "vertical"
        ? { width: "100%", height: 46, flexShrink: 0 }
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
  };

  const containerStyle: React.CSSProperties =
    variant === "vertical"
      ? {
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          width: 44,
          height: "100%",
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
      {moduleItems.map(renderItem)}
      {/* Scope separator: module (workspace-scoped) vs global views. Settings
          is bottom-pinned via its own marginTop:auto below, so the separator
          always sits directly under the module group. */}
      {variant === "vertical" ? (
        <div
          aria-hidden="true"
          style={{
            margin: "6px 8px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        />
      ) : (
        <div aria-hidden="true" style={{ width: 1, alignSelf: "stretch", background: "var(--border)", flexShrink: 0 }} />
      )}
      {globalItems.map((item) => (
        <div
          key={item.view}
          style={variant === "vertical" && item.view === "settings" ? { marginTop: "auto" } : undefined}
        >
          {renderItem(item)}
        </div>
      ))}
    </nav>
  );
}
