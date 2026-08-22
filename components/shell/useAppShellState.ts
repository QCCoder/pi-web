"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { visibleActivityViews, GLOBAL_ACTIVITY_VIEWS, isConfigView, type SidebarView, type ConfigView } from "../ActivityBar";
import { type SettingsPage } from "../SettingsPanel";
import { useSessionActivity } from "@/hooks/useSessionActivity";
import { useGlobalAgentEvents } from "@/hooks/useGlobalAgentEvents";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildFileLineMentionText } from "@/lib/file-fuzzy";
import { clearDraft, getDraft } from "@/lib/draft-store";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "../ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { WorkItemDetail, WorkItemRecord } from "@/lib/work-items/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { Tab } from "../TabBar";
import type { LoopDefinition, LoopRun } from "@/lib/loop/types";

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

/** The right column's content view: the overview dashboard is the landing
 *  state, chat takes over once a session is selected / a new session starts.
 *  (The former "settings" / "work-items" / "loops" values moved to the middle
 *  column panels — legacy URLs map onto panel switches in applyUrlToTabs.) */
type WorkspaceView = "overview" | "chat";

/** Loop run terminal statuses (shared by the run polling effect). */
const LOOP_TERMINAL = new Set(["succeeded", "failed"]);

/**
 * One open workspace tab. All per-tab view state (selected session, file tabs,
 * panel state …) lives here, so switching tabs is just changing `activeTabId` —
 * there is no snapshot capture/restore. The URL is a write-only projection of
 * the active tab; popstate (back/forward) and the initial mount are the only
 * places the URL drives state.
 */
export interface WorkspaceTabState {
  id: string;
  workspace: WorkspaceSummary;
  view: WorkspaceView;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  workItemKey: string | null;
  /** When set, this tab is showing a just-triggered Loop run's launching
   *  placeholder / status bar. Cleared once the run reaches a terminal state. */
  loopPending?: { runId?: string; loopName: string; workspaceId: string };
  fileTabs: Tab[];
  activeFileTabId: string | null;
  rightPanelOpen: boolean;
}
const LANGUAGE_MENU_WIDTH = 176;
// Desktop sidebar is drag-resizable (handle between sidebar and center). Width is
// persisted in localStorage; clamped to these bounds. Mobile keeps a fixed drawer.
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_WIDTH_KEY = "pi-sidebar-width";

/**
 * The shared shell-state layer — ALL navigation/session/workspace state and
 * handlers, shell-agnostic. `AppShell` calls this once and provides the result
 * to `DesktopShell` / `MobileShell` via context; the shells only decide WHERE
 * things render and HOW navigation works (three-column vs bottom tabs).
 *
 * Contains no `isMobile` branching — shell-specific reactions (e.g. switching
 * to the mobile 会话 tab when a session opens) happen through the focus
 * signals (`chatFocusKey`, `panelFocus`) that the mobile shell subscribes to
 * and the desktop shell ignores.
 */
export function useAppShellState() {
  // ---- Workspace tabs ---------------------------------------------------------
  // Each open workspace is one entry in `tabs`; the active one is `activeTabId`.
  // Per-tab view state is read directly off the active tab (no snapshot dance),
  // and the URL is a write-only projection of it.
  const [tabs, setTabs] = useState<WorkspaceTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [mruIds, setMruIds] = useState<string[]>([]);
  // False until the initial URL→tab restore has run, to avoid flashing the
  // "select a session" placeholder while the addressed tab is still loading.
  const [navReady, setNavReady] = useState(false);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeWorkspace = activeTab?.workspace ?? null;
  const selectedSession = activeTab?.session ?? null;
  const newSessionCwd = activeTab?.newSessionCwd ?? null;
  const workspaceView = activeTab?.view ?? "overview";
  const selectedWorkItemKey = activeTab?.workItemKey ?? null;
  const fileTabs = activeTab?.fileTabs ?? [];
  const activeFileTabId = activeTab?.activeFileTabId ?? null;
  const rightPanelOpen = activeTab?.rightPanelOpen ?? false;
  const activeCwd = activeTab?.workspace.path ?? null;
  // Middle-column panel selection — one `sidebarView` for everything (module
  // views + the global archive/settings panels). Module views persist per
  // workspace under `pi-active-view:<wsId>`; the global panels persist under
  // the shared `pi-active-panel` key (settings survives workspace switches —
  // archive is transient and falls back to the per-workspace module view).
  // Stale stored values (the former sessions/explorer split, removed views)
  // fail the visible-views check and fall back to "workbench".
  const GLOBAL_PANEL_KEY = "pi-active-panel";
  const [sidebarView, setSidebarView] = useState<SidebarView>("workbench");
  // Config views (模型/Skills/插件) are strict three-column views on desktop:
  // the rail icon puts the config's LIST in the middle column (temporarily
  // replacing the sidebarView panel) and its DETAIL in the right column — the
  // middle-column split panel portals the detail across via configPortalNode.
  // Clicking the active config icon again toggles it off; any panel switch
  // hands the middle column back to sidebarView. Session-only state, never
  // persisted; reset when the active workspace changes. Mobile never sets it
  // (its bar has no config icons — the settings index subpages serve the same
  // content there via the components' embedded mode).
  const [configView, setConfigView] = useState<ConfigView | null>(null);
  // The right column's config portal target (the div under the config view's
  // PanelHeader). The middle-column split panel (ModelsConfig/SkillsConfig/
  // PluginsConfig in `split` mode) portals its DETAIL pane into this node —
  // callback-ref + state so the portal re-renders as soon as the node mounts
  // (same commit, before paint; null target simply renders nothing).
  const [configPortalNode, setConfigPortalNode] = useState<HTMLDivElement | null>(null);
  const handleOpenConfig = useCallback((view: ConfigView) => {
    setConfigView((current) => (current === view ? null : view));
    // The config LIST lives in the middle column — make sure the column is
    // visible when a config view opens (desktop-only entry point; mobile
    // serves the same content via the settings subpages and never gets here).
    setSidebarOpen(true);
  }, []);
  useEffect(() => {
    setConfigView(null);
    if (!activeWorkspace) {
      const storedGlobal = localStorage.getItem(GLOBAL_PANEL_KEY) as SidebarView | null;
      setSidebarView(storedGlobal === "settings" ? "settings" : "workbench");
      return;
    }
    const visible = visibleActivityViews(activeWorkspace.capabilities);
    const storedGlobal = localStorage.getItem(GLOBAL_PANEL_KEY) as SidebarView | null;
    if (storedGlobal === "settings" && visible.includes("settings")) {
      setSidebarView("settings");
      return;
    }
    const stored = localStorage.getItem(`pi-active-view:${activeWorkspace.id}`) as SidebarView | null;
    setSidebarView(stored && visible.includes(stored) && !GLOBAL_ACTIVITY_VIEWS.includes(stored) ? stored : "workbench");
  }, [activeWorkspace]);
  const handleSidebarSwitchView = useCallback((view: SidebarView) => {
    // Defensive: a config view is right-column content, never a middle-column
    // panel — route it to the config handler instead of switching panels.
    if (isConfigView(view)) {
      handleOpenConfig(view);
      return;
    }
    // A config view temporarily owns the middle column (its list renders
    // there) — any panel switch must hand the column back.
    setConfigView(null);
    setSidebarView(view);
    if (GLOBAL_ACTIVITY_VIEWS.includes(view)) {
      try { localStorage.setItem(GLOBAL_PANEL_KEY, view); } catch { /* ignore */ }
      if (view === "settings") setSettingsPage("index");
    } else {
      setLoopEditorOpen(false);
      if (activeWorkspace) {
        try { localStorage.setItem(`pi-active-view:${activeWorkspace.id}`, view); } catch { /* ignore */ }
      }
    }
  }, [activeWorkspace, handleOpenConfig]);
  // The rail's switch behavior: a DIFFERENT icon switches the panel (opening
  // the column if collapsed); the ACTIVE icon toggles the column (VS Code
  // collapse). Config icons toggle the three-column config view (list in the
  // middle column + detail in the right; opening also opens the column). On
  // mobile, module views toggle the drawer; settings opens as a full-screen
  // overlay (the drawer renders full-screen for global panels).
  const handleRailSwitch = useCallback((view: SidebarView) => {
    if (isConfigView(view)) {
      handleOpenConfig(view);
      return;
    }
    // While a config view owns the middle column (its list renders there),
    // any other rail click hands the column back to that panel — never a
    // column toggle.
    if (configView !== null) {
      handleSidebarSwitchView(view);
      setSidebarOpen(true);
      return;
    }
    if (view === sidebarView) {
      setSidebarOpen((open) => !open);
      return;
    }
    handleSidebarSwitchView(view);
    setSidebarOpen(true);
  }, [sidebarView, configView, handleSidebarSwitchView, handleOpenConfig]);
  const [refreshKey, setRefreshKey] = useState(0);
  const sessionActivity = useSessionActivity(selectedSession?.id ?? null, refreshKey);
  // Running-id 集来自 session daemon 的 SSE（/api/agent/running/events 代理它的
  // /v1/sessions/running/events）。daemon 的注册表按真 session id 存交互会话、
  // subagent child 和 loop orchestrator —— 单一集合就是完整答案，不再需要
  // 客户端把「pin 住的 loop 会话」合并进来（那套合并存在的原因是 web 进程的
  // running 集永远不含 Loop-Host 会话）。
  // 全局 SSE：为每个 running session 维护一条事件流，后台 session 事件不丢（决策 8 / B4b）。
  useGlobalAgentEvents(sessionActivity.runningIds);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  // The settings panel's subpage (index → workspace/models/skills/plugins/
  // preferences). Owned here so external entry points (overview 添加仓库, home
  // create-workspace…) can deep-link straight to a subpage.
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("index");
  // The selected workspace's name inside the settings › 工作区 split view —
  // reported up by the middle-column WorkspaceManager (its rail selection is
  // internal state) so the right-column 工作区设置 header can show it.
  const [workspaceSettingsName, setWorkspaceSettingsName] = useState<string | null>(null);
  const handleWorkspaceSettingsSelection = useCallback((workspace: WorkspaceSummary | null) => {
    setWorkspaceSettingsName(workspace?.name ?? null);
  }, []);
  // Leaving the settings › 工作区 split view drops the reported name so a
  // later reopen never flashes a stale header — the manager re-reports on
  // mount.
  useEffect(() => {
    if (!(sidebarView === "settings" && settingsPage === "workspace")) {
      setWorkspaceSettingsName(null);
    }
  }, [sidebarView, settingsPage]);
  // When true and the loop panel is active, the middle column shows the
  // LoopConfig editor instead of the loop list (temporarily widened — see
  // middleColumnWidth below; the widened value is derived, never persisted).
  const [loopEditorOpen, setLoopEditorOpen] = useState(false);
  // Home create-workspace wizard — the one remaining WorkspaceManager modal
  // (creating a workspace is a focused flow; managing one lives in the
  // settings › workspace panel page).
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [createWorkItemRequest, setCreateWorkItemRequest] = useState<{
    type: "requirement" | "bug";
    id: number;
  } | null>(null);
  const [openRepositoryFormRequest, setOpenRepositoryFormRequest] = useState<number | undefined>();
  const [globalSettingsCwd, setGlobalSettingsCwd] = useState<string | null>(null);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // ---- Mobile focus signals ---------------------------------------------------
  // Cross-shell navigation intents. Shared handlers (session open, new session,
  // loop trigger, create work item…) bump these; the mobile shell reacts by
  // switching its active tab. The desktop shell ignores them (its center
  // column is always visible). Signals (not direct tab writes) keep this layer
  // shell-agnostic.
  const [chatFocusKey, setChatFocusKey] = useState(0);
  const focusChat = useCallback(() => setChatFocusKey((key) => key + 1), []);
  const [panelFocus, setPanelFocus] = useState<{ view: SidebarView; key: number } | null>(null);
  const focusPanel = useCallback((view: SidebarView) => {
    setPanelFocus((prev) => ({ view, key: (prev?.key ?? 0) + 1 }));
  }, []);

  // ---- Desktop sidebar resize -------------------------------------------------
  // Default width until localStorage hydrates (SSR-safe: no localStorage in the
  // initializer). `sidebarWidthRef` mirrors state so the mouseup handler can
  // persist the final value without stale-closure issues.
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(n))));
        }
      }
    } catch { /* localStorage unavailable — keep default */ }
  }, []);
  const clampSidebarWidth = (n: number) =>
    Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(n)));
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = sidebarContainerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startWidth = container.getBoundingClientRect().width;
    setSidebarResizing(true);
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + (ev.clientX - startX)));
    };
    const onUp = () => {
      setSidebarResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_DEFAULT_WIDTH)); } catch { /* ignore */ }
  }, []);

  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const pendingWorkItemConversationRef = useRef<{
    workspaceId: string;
    key: string;
  } | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | "language" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "session" | "language") => {
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, []);

  const openSessionStatsPanel = useCallback(() => {
    setActiveTopPanel("session");
  }, []);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "language" && languageBtnRef.current) {
        const buttonRect = languageBtnRef.current.getBoundingClientRect();
        const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
        const left = Math.min(
          buttonRect.left - 1,
          Math.max(topBarRect.left, topBarRect.right - width),
        );
        setTopPanelPos({ top: topBarRect.bottom, left, width });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    if (languageBtnRef.current) ro.observe(languageBtnRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  // ---- Tab mutation helpers ---------------------------------------------------
  // All stable: they mutate tabs via setTabs/updaters, so they never need to
  // appear in a navigation effect's dependency array (the race root cause).
  const updateTab = useCallback((
    id: string,
    patch: Partial<WorkspaceTabState> | ((tab: WorkspaceTabState) => Partial<WorkspaceTabState>),
  ) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      const p = typeof patch === "function" ? patch(t) : patch;
      return { ...t, ...p };
    }));
  }, []);

  const updateActiveTab = useCallback((
    patch: Partial<WorkspaceTabState> | ((tab: WorkspaceTabState) => Partial<WorkspaceTabState>),
  ) => {
    if (activeTabId) updateTab(activeTabId, patch);
  }, [activeTabId, updateTab]);

  // Register a workspace as a tab if it isn't open yet (with its default view),
  // keep the master workspace list in sync, and touch MRU. Returns the tab id.
  const ensureTab = useCallback((workspace: WorkspaceSummary): string => {
    setWorkspaces((current) => current.some((w) => w.id === workspace.id)
      ? current.map((w) => (w.id === workspace.id ? workspace : w))
      : [...current, workspace]);
    setTabs((prev) => {
      if (prev.some((t) => t.id === workspace.id)) return prev;
      const tab: WorkspaceTabState = {
        id: workspace.id,
        workspace,
        // The overview dashboard is the unconditional landing view.
        view: "overview",
        session: null,
        newSessionCwd: null,
        workItemKey: null,
        fileTabs: [],
        activeFileTabId: null,
        rightPanelOpen: false,
      };
      return [...prev, tab];
    });
    return workspace.id;
  }, []);

  // Make a tab active (or go home with null). Closes overlays and clears the
  // per-session UI that ChatWindow will re-populate for the new session.
  const activateTab = useCallback((id: string | null) => {
    setWorkspaceManagerOpen(false);
    setProjectTrustDialogOpen(false);
    setActiveTopPanel(null);
    if (id) setMruIds((ids) => [id, ...ids.filter((x) => x !== id)]);
    setActiveTabId(id);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
  }, []);

  // The URL is a write-only projection of the active tab. We push via the
  // History API (no Next.js navigation → no Suspense churn); popstate is the
  // only reader.
  const navigateUrl = useCallback((query: string | null, replace = false) => {
    const target = query ? `?${query}` : window.location.pathname;
    const current = window.location.pathname + window.location.search;
    if (target === current) return;
    if (replace) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
  }, []);

  const buildTabQuery = useCallback((tab: WorkspaceTabState): string => {
    const parts = [`workspace=${encodeURIComponent(tab.id)}`, `view=${tab.view === "chat" ? "chat" : "overview"}`];
    if (tab.view === "chat" && tab.session) parts.push(`session=${encodeURIComponent(tab.session.id)}`);
    return parts.join("&");
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const response = await fetch("/api/workspaces");
      if (!response.ok) return;
      const data = await response.json() as { workspaces?: WorkspaceSummary[] };
      setWorkspaces(data.workspaces ?? []);
    } catch (error) {
      console.error("Failed to load workspaces:", error);
    } finally {
      setWorkspacesLoaded(true);
    }
  }, []);

  // Translate the current URL into tab state. Used by the initial mount (once
  // workspaces are loaded) and by popstate (back/forward). This is the *only*
  // place the URL drives state, so user clicks can never race a URL→state effect.
  const applyUrlToTabs = useCallback(async (params: URLSearchParams) => {
    if (params.get("tab") === "home" || !params.get("workspace")) {
      setActiveTabId(null);
      return;
    }
    let workspaceId = params.get("workspace")!;
    let workspace = workspaces.find((w) => w.id === workspaceId && w.available) ?? null;
    const rawView = params.get("view");
    const sessionId = params.get("session");
    const itemKey = params.get("item");

    let session: SessionInfo | null = null;
    if (sessionId) {
      session = sessionActivity.sessions.find((s) => s.id === sessionId) ?? null;
      if (!session) {
        try {
          const r = await fetch("/api/sessions");
          const d = r.ok ? await r.json() as { sessions?: SessionInfo[] } : null;
          session = d?.sessions?.find((s) => s.id === sessionId) ?? null;
        } catch {
          // A missing session just falls through to a fresh chat view.
        }
      }
      if (session) {
        // Make sure the session's owning workspace is known & available; import
        // it on the fly when opening via a shared link to an unknown cwd.
        const owner = workspaces
          .filter((w) => w.available && (session!.cwd === w.path || session!.cwd.startsWith(`${w.path.replace(/\/+$/, "")}/`)))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (owner) {
          workspace = owner;
          workspaceId = owner.id;
        } else if (!workspace) {
          try {
            const ir = await fetch("/api/workspaces", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: session.cwd }),
            });
            const imported = ir.ok ? await ir.json() as { workspace?: WorkspaceSummary } : null;
            if (imported?.workspace) {
              const ws = imported.workspace;
              setWorkspaces((cur) => cur.some((w) => w.id === ws.id) ? cur.map((w) => (w.id === ws.id ? ws : w)) : [...cur, ws]);
              workspace = ws;
              workspaceId = ws.id;
            }
          } catch {
            // Leave workspace null → fall back to home.
          }
        }
      }
    }
    if (!workspace) {
      setActiveTabId(null);
      return;
    }

    // Legacy URL views (settings / work-items / loops) map onto middle-column
    // panels — the right column only knows overview/chat now.
    const panelFromLegacy: Partial<Record<string, SidebarView>> = {
      settings: "settings",
      "work-items": "work-items",
      loops: "loop",
    };
    let view: WorkspaceView = rawView === "chat" ? "chat" : "overview";
    const legacyPanel = rawView ? panelFromLegacy[rawView] : undefined;
    if (legacyPanel === "loop" && !workspace.capabilities.includes("loop")) {
      // loop panel gated — fall through to overview
      view = "overview";
    }
    ensureTab(workspace);
    updateTab(workspaceId, {
      view,
      session,
      newSessionCwd: view === "chat" && !session ? workspace.path : null,
      workItemKey: legacyPanel === "work-items" ? itemKey : null,
    });
    // Persist the legacy deep-linked panel BEFORE activating the tab — the
    // activeWorkspace effect re-derives `sidebarView` from these keys on tab
    // switch and would otherwise clobber an immediate setState.
    if (legacyPanel && (legacyPanel !== "loop" || workspace.capabilities.includes("loop"))) {
      try {
        if (legacyPanel === "settings") localStorage.setItem(GLOBAL_PANEL_KEY, "settings");
        else localStorage.setItem(`pi-active-view:${workspaceId}`, legacyPanel);
      } catch { /* ignore */ }
    }
    activateTab(workspaceId);
  }, [workspaces, sessionActivity.sessions, ensureTab, updateTab, activateTab]);

  // Initial restore: once workspaces are loaded, open whatever the URL points at.
  const initialNavDoneRef = useRef(false);
  useEffect(() => {
    if (!workspacesLoaded || initialNavDoneRef.current) return;
    initialNavDoneRef.current = true;
    void applyUrlToTabs(new URLSearchParams(window.location.search)).finally(() => setNavReady(true));
  }, [workspacesLoaded, applyUrlToTabs]);

  // Back/forward: the only other place the URL drives state.
  useEffect(() => {
    const onPop = () => { void applyUrlToTabs(new URLSearchParams(window.location.search)); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyUrlToTabs]);

  // Keep each open tab's workspace in sync with the master list — capabilities,
  // repositories and availability can change while a tab is open (add repo,
  // config becomes ready, …).
  useEffect(() => {
    if (workspaces.length === 0) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const fresh = workspaces.find((w) => w.id === t.id);
        if (fresh && fresh !== t.workspace) {
          changed = true;
          return { ...t, workspace: fresh };
        }
        return t;
      });
      return changed ? next : prev;
    });
  }, [workspaces]);

  useEffect(() => {
    void loadWorkspaces();
    void fetch("/api/home")
      .then(async (response) => response.ok
        ? response.json() as Promise<{ home?: string }>
        : null)
      .then((data) => setGlobalSettingsCwd(data?.home ?? null))
      .catch(() => {});
  }, [loadWorkspaces]);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    if (!activeTabId) return;
    // Opening a session is an explicit “show me the chat” intent — drop the
    // right-column config view so the chat is actually visible.
    setConfigView(null);
    updateTab(activeTabId, { session, newSessionCwd: null, view: "chat" });
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    // Opening a session is a "show me the chat" intent — on mobile that means
    // switching to the 会话 tab (focus signal; the desktop shell ignores it).
    focusChat();
    navigateUrl(`workspace=${encodeURIComponent(activeTabId)}&view=chat&session=${encodeURIComponent(session.id)}`);
  }, [activeTabId, updateTab, navigateUrl, focusChat]);

  // Loop 运行产生的 orchestrator 会话按 id 打开。走专门的 locate 端点：
  // 优先 probe Loop Host 拿权威元信息（session 在 Host 进程里，它最先知道），
  // Host 不可达/旧版本时回退到强制刷新磁盘扫描。两种路径都不依赖 30s 列表缓存，
  // 所以刚触发的一轮能立刻打开，而不是“过一会才出现”。
  const handleOpenLoopSession = useCallback((sessionId: string) => {
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`)
      .then((r) => (r.ok ? (r.json() as Promise<{ session: SessionInfo }>) : null))
      .then((d) => {
        if (d?.session) {
          handleSelectSession(d.session);
          // locate 已让磁盘缓存失效；触发侧边栏重拉，让这个新会话立即出现在会话列表里。
          setRefreshKey((k) => k + 1);
        }
      })
      .catch(() => {});
  }, [handleSelectSession]);

  // ---- Loop 手动触发（v3：选品回合）-------------------------------------------
  // 点击“运行一轮”时立即把当前 tab 切到 chat 并显示启动占位，不等 Loop Host 把
  // 编排会话创建好。后台轮询 run；v3 的终态处理：seededSessionId 出现 → 自动打开
  // 播种的执行会话（合同执行的入口）；无 seed（idle/park-all）→ 清占位，结果看
  // Loop 视图的 run 记录（verdict 就在那里）。
  const [loopRun, setLoopRun] = useState<LoopRun | null>(null);
  // 轮询目标（显式状态而非派生：setLoopRun 每秒写新对象，若作 effect 依赖会把
  // 轮询重置成 300ms 一发）。autoOpen=触发流：seed 一出现就自动切到执行会话。
  const [loopPollTarget, setLoopPollTarget] = useState<{ workspaceId: string; runId: string } | null>(null);
  const loopSeedAutoOpenedRef = useRef<string | null>(null);

  const handleLoopTriggered = useCallback((loop: LoopDefinition) => {
    if (!activeTabId) return;
    const workspaceId = activeTabId;
    // 点击瞬间同步切到 chat + 启动占位，不等 trigger POST 往返——这是“立即打开会话框”的关键。
    setLoopRun({
      id: "", workspaceId, loopId: loop.id, eventId: "", triggeredBy: "manual",
      status: "queued", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    updateTab(workspaceId, {
      view: "chat", session: null, newSessionCwd: null, workItemKey: null,
      loopPending: { loopName: loop.name, workspaceId },
    });
    setSessionKey((k) => k + 1);
    focusChat();
    navigateUrl(`workspace=${encodeURIComponent(workspaceId)}&view=chat`);
    // 后台触发；runId 一返回就写进 loopPending，轮询 effect 随即接管。
    void (async () => {
      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/loop/loops/${encodeURIComponent(loop.id)}/trigger`, { method: "POST" });
        if (!res.ok) throw new Error(`触发失败 (HTTP ${res.status})`);
        const receipt = await res.json() as { runId: string };
        updateTab(workspaceId, (tab) => (tab.loopPending ? { loopPending: { ...tab.loopPending, runId: receipt.runId } } : {}));
        setLoopPollTarget({ workspaceId, runId: receipt.runId });
      } catch (error) {
        setLoopRun((cur) => (cur ? { ...cur, status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() } : cur));
        updateTab(workspaceId, { loopPending: undefined });
        setLoopPollTarget(null);
      }
    })();
  }, [activeTabId, updateTab, navigateUrl, focusChat]);

  // 唯一的 run 轮询：loopPollTarget 存在且 run 未终态时每 1s 拉一次快照。终态时：
  // 有 seededSessionId → 打开执行会话（ref 去重防抢焦点）；无 → 只清占位（verdict
  // 在 Loop 视图 run 记录里看）。
  useEffect(() => {
    const target = loopPollTarget;
    if (!target) return;
    const base = `/api/workspaces/${encodeURIComponent(target.workspaceId)}/loop`;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`${base}/runs/${encodeURIComponent(target.runId)}`);
        if (!res.ok) { if (!stopped) setTimeout(poll, 2000); return; }
        const { run } = await res.json() as { run: LoopRun };
        if (stopped) return;
        setLoopRun(run);
        if (LOOP_TERMINAL.has(run.status)) {
          setLoopPollTarget(null);
          updateTab(target.workspaceId, { loopPending: undefined });
          if (run.seededSessionId && loopSeedAutoOpenedRef.current !== run.seededSessionId) {
            loopSeedAutoOpenedRef.current = run.seededSessionId;
            handleOpenLoopSession(run.seededSessionId);
          }
        } else if (run.seededSessionId && loopSeedAutoOpenedRef.current !== run.seededSessionId) {
          // Seed happens at round settle — effectively terminal for UX purposes.
          loopSeedAutoOpenedRef.current = run.seededSessionId;
          setLoopPollTarget(null);
          updateTab(target.workspaceId, { loopPending: undefined });
          handleOpenLoopSession(run.seededSessionId);
        } else {
          setTimeout(poll, 1000);
        }
      } catch {
        if (!stopped) setTimeout(poll, 2000);
      }
    };
    const timer = setTimeout(poll, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [loopPollTarget, handleOpenLoopSession, updateTab]);

  const handleOpenWorkspace = useCallback((workspace: WorkspaceSummary) => {
    const id = ensureTab(workspace);
    activateTab(id);
    // Project the (possibly already-open) tab to the URL. `tabs` may not yet
    // reflect a brand-new tab, so fall back to the workspace's default view.
    const existing = tabs.find((t) => t.id === id);
    navigateUrl(existing ? buildTabQuery(existing) : `workspace=${encodeURIComponent(id)}&view=overview`);
  }, [ensureTab, activateTab, tabs, buildTabQuery, navigateUrl]);

  const handleWorkspaceNewSession = useCallback(() => {
    if (!activeTabId) return;
    setConfigView(null);
    updateTab(activeTabId, { view: "chat", session: null, newSessionCwd: activeWorkspace?.path ?? null });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    focusChat();
    navigateUrl(`workspace=${encodeURIComponent(activeTabId)}&view=chat`);
  }, [activeTabId, activeWorkspace, updateTab, navigateUrl, focusChat]);

  const handleReturnHome = useCallback(() => {
    activateTab(null);
    navigateUrl("tab=home");
  }, [activateTab, navigateUrl]);

  const handleCloseWorkspaceTab = useCallback((workspaceId: string) => {
    const tab = tabs.find((t) => t.id === workspaceId) ?? null;
    const draftKey = tab?.session?.id ?? (tab?.newSessionCwd ? `new:${tab.newSessionCwd}` : null);
    const draft = draftKey ? getDraft(draftKey) : null;
    if (draft && (draft.value || draft.images.length > 0)) {
      const shouldClose = window.confirm("这个工作区有未发送的聊天草稿。要关闭并丢弃草稿吗？");
      if (!shouldClose) return;
      clearDraft(draftKey!);
    }
    const remaining = tabs.filter((t) => t.id !== workspaceId);
    setTabs(remaining);
    setMruIds((ids) => ids.filter((id) => id !== workspaceId));
    if (activeTabId !== workspaceId) return;

    const nextId = mruIds.find((id) => id !== workspaceId && remaining.some((t) => t.id === id));
    if (nextId) {
      activateTab(nextId);
      const nextTab = remaining.find((t) => t.id === nextId);
      navigateUrl(nextTab ? buildTabQuery(nextTab) : `workspace=${encodeURIComponent(nextId)}`);
    } else {
      activateTab(null);
      navigateUrl("tab=home");
    }
  }, [tabs, activeTabId, mruIds, activateTab, buildTabQuery, navigateUrl]);

  const handleCreateWorkspace = useCallback(() => {
    // Opening the manager from home; don't run it through activateTab (which
    // would close the very modal we're opening).
    setWorkspaceManagerOpen(true);
    setActiveTabId(null);
    navigateUrl("tab=home&view=create-workspace");
  }, [navigateUrl]);

  // Shared directory-import flow used by both the sidebar and the home page.
  // Registers the picked directory as a workspace (with a copy-confirm prompt
  // when it is a duplicate of an existing workspace) and opens it.
  const handleImportDirectory = useCallback(async (path: string) => {
    setImportBusy(true);
    setImportError(null);
    try {
      let asCopy = false;
      let workspace: WorkspaceSummary | undefined;
      while (!workspace) {
        const response = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, ...(asCopy ? { asCopy: true } : {}) }),
        });
        const data = await response.json() as { workspace?: WorkspaceSummary; error?: string };
        if (response.ok && data.workspace) {
          workspace = data.workspace;
          break;
        }
        const message = data.error ?? `HTTP ${response.status}`;
        if (
          !asCopy
          && response.status === 409
          && message.includes("already registered")
          && window.confirm("这个目录是现有 Workspace 的副本。要生成新的 Workspace ID 并作为副本导入吗？")
        ) {
          asCopy = true;
          continue;
        }
        throw new Error(message);
      }
      setImportPickerOpen(false);
      setWorkspaces((current) =>
        current.some((item) => item.id === workspace!.id) ? current : [...current, workspace!],
      );
      handleOpenWorkspace(workspace);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(false);
    }
  }, [handleOpenWorkspace]);

  const handleWorkspaceDeleted = useCallback((workspace: WorkspaceSummary) => {
    setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    handleCloseWorkspaceTab(workspace.id);
  }, [handleCloseWorkspaceTab]);

  // Open a session straight from the home page: resolve its owning workspace
  // (already known from the loaded list) and switch into chat in one step.
  const handleOpenSessionFromHome = useCallback((session: SessionInfo) => {
    const owner = workspaces
      .filter((workspace) => {
        const prefix = `${workspace.path.replace(/\/+$/, "")}/`;
        return workspace.available
          && (session.cwd === workspace.path || session.cwd.startsWith(prefix));
      })
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!owner) return;
    setWorkspaceManagerOpen(false);
    ensureTab(owner);
    updateTab(owner.id, { view: "chat", session, newSessionCwd: null });
    activateTab(owner.id);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    focusChat();
    navigateUrl(`workspace=${encodeURIComponent(owner.id)}&view=chat&session=${encodeURIComponent(session.id)}`);
  }, [workspaces, ensureTab, updateTab, activateTab, navigateUrl, focusChat]);

  const handleCreateWorkItem = useCallback((type: "requirement" | "bug") => {
    // The work-items panel (full manager) receives the create request.
    if (activeWorkspace?.capabilities.includes("work-items")) handleSidebarSwitchView("work-items");
    setCreateWorkItemRequest({ type, id: Date.now() });
    // On mobile, switch to the 工作项 tab so the create form is visible.
    focusPanel("work-items");
  }, [activeWorkspace, handleSidebarSwitchView, focusPanel]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: () => {
      if (activeWorkspace) handleWorkspaceNewSession();
      else handleReturnHome();
    },
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        updateActiveTab((tab) => (tab.session?.id === sessionId && !tab.session.projectRoot ? { session: full } : {}));
      })
      .catch(() => {});
  }, [updateActiveTab]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    if (!activeTabId) return;
    updateTab(activeTabId, { session, newSessionCwd: null });
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    navigateUrl(`workspace=${encodeURIComponent(activeTabId)}&view=chat&session=${encodeURIComponent(session.id)}`, true);
    const pending = pendingWorkItemConversationRef.current;
    pendingWorkItemConversationRef.current = null;
    if (pending) {
      const url = `/api/workspaces/${encodeURIComponent(pending.workspaceId)}/work-items/${encodeURIComponent(pending.key)}`;
      void fetch(url)
        .then(async (response) => {
          if (!response.ok) return;
          const detail = await response.json() as WorkItemDetail;
          const conversations = [...new Set([...detail.item.conversations, session.id])];
          return fetch(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRevision: detail.item.revision,
              conversations,
              actor: "system",
              conversationId: session.id,
            }),
          });
        })
        .catch(() => {});
    }
  }, [activeTabId, updateTab, navigateUrl, hydrateSelectedSession]);

  const handleOpenWorkItemConversation = useCallback(async (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
  ) => {
    // Latest conversation first: a loop-seeded execution session is APPENDED to
    // `conversations`, so the most recent entry is the live/latest contract
    // run. Resolve via /locate (daemon probe + forced disk scan) — never the
    // 30s-cached /api/sessions list, which misses freshly seeded sessions.
    for (let index = item.conversations.length - 1; index >= 0; index -= 1) {
      const conversationId = item.conversations[index];
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(conversationId)}/locate`);
        if (response.ok) {
          const data = await response.json() as { session?: SessionInfo };
          if (data.session) {
            ensureTab(workspace);
            updateTab(workspace.id, { view: "chat", session: data.session, newSessionCwd: null });
            activateTab(workspace.id);
            setSessionKey((k) => k + 1);
            setSystemPrompt(null);
            focusChat();
            navigateUrl(`workspace=${encodeURIComponent(workspace.id)}&view=chat&session=${encodeURIComponent(data.session.id)}`);
            return;
          }
        }
      } catch {
        // Unresolvable conversation (archived/removed) — try the next older one.
      }
    }

    pendingWorkItemConversationRef.current = {
      workspaceId: workspace.id,
      key: item.key,
    };
    ensureTab(workspace);
    updateTab(workspace.id, { view: "chat", session: null, newSessionCwd: workspace.path });
    activateTab(workspace.id);
    setSessionKey((key) => key + 1);
    focusChat();
    navigateUrl(`workspace=${encodeURIComponent(workspace.id)}`, true);
    const prompt = `请继续处理工作项 ${item.key}（${item.title}）。先调用 workspace_get_work_item 读取现状，再按 Workspace 的 AGENTS.md 和已选 Pi skills 协作；只把关键里程碑写回工作项。`;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (chatInputRef.current) {
        chatInputRef.current.insertIfEmpty(prompt);
        window.clearInterval(timer);
      } else if (attempts >= 20) {
        window.clearInterval(timer);
      }
    }, 50);
  }, [ensureTab, updateTab, activateTab, navigateUrl, focusChat]);

  /** dev-loop v3「按合同执行」：POST run-contract → daemon deterministic seeder
   *  (guard + `/skill:` prompt + bookkeeping), then open the seeded execution
   *  session as this workspace's chat tab (gate answers happen in its composer).
   *  Returns the guard's refusal reason when seeding was blocked, or null on
   *  success; throws on transport errors so the caller can surface them. */
  const handleRunContract = useCallback(async (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
    mode: "execute" | "adopt",
  ): Promise<string | null> => {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspace.id)}/work-items/${encodeURIComponent(item.key)}/run-contract`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      },
    );
    const data = await response.json().catch(() => ({})) as {
      seeded?: boolean;
      sessionId?: string;
      reason?: string;
      error?: string;
    };
    if (!response.ok || !data.seeded) {
      return data.reason ?? data.error ?? `HTTP ${response.status}`;
    }
    const sessionId = data.sessionId!;
    // Resolve the freshly seeded daemon session via locate (probe-first — the
    // .jsonl may not be flushed into the 30s-cached session list yet).
    let info: SessionInfo | undefined;
    try {
      const locate = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`);
      if (locate.ok) {
        info = ((await locate.json()) as { session?: SessionInfo }).session;
      }
    } catch { /* fall through with a minimal info */ }
    ensureTab(workspace);
    updateTab(workspace.id, {
      view: "chat",
      session: info ?? {
        id: sessionId,
        path: sessionId,
        cwd: workspace.path,
        name: `${item.key} ${item.title}`,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 0,
        firstMessage: `${item.key} ${item.title}`,
      },
      newSessionCwd: null,
    });
    activateTab(workspace.id);
    setSessionKey((key) => key + 1);
    setSystemPrompt(null);
    focusChat();
    navigateUrl(`workspace=${encodeURIComponent(workspace.id)}&view=chat&session=${encodeURIComponent(sessionId)}`);
    return null;
  }, [ensureTab, updateTab, activateTab, navigateUrl, focusChat]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      updateActiveTab((tab) => (tab.session?.id === sessionId ? { session: { ...tab.session!, name: title } } : {}));
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id, updateActiveTab]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleSessionForked = useCallback((newSessionId: string) => {
    if (!activeTabId) return;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    updateTab(activeTabId, (tab) => ({
      session: { ...(tab.session ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }), id: newSessionId },
      newSessionCwd: null,
    }));
    hydrateSelectedSession(newSessionId);
    navigateUrl(`workspace=${encodeURIComponent(activeTabId)}&view=chat&session=${encodeURIComponent(newSessionId)}`, true);
  }, [activeTabId, updateTab, navigateUrl, hydrateSelectedSession]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" },
  ) => {
    if (!activeTabId) return;
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const fileTabId = `file:${filePath}`;
    updateTab(activeTabId, (tab) => {
      const prev = tab.fileTabs;
      const existing = prev.find((t) => t.id === fileTabId);
      let fileTabs: Tab[];
      if (!existing) {
        fileTabs = [...prev, {
          id: fileTabId,
          kind: "file",
          label: fileName,
          filePath,
          sourceSessionId,
          initialDisplayMode: modeHint,
        }];
      } else if (existing.kind === "file") {
        const sourceUnchanged = !sourceSessionId || existing.sourceSessionId === sourceSessionId;
        const modeUnchanged = !modeHint || existing.initialDisplayMode === modeHint;
        if (sourceUnchanged && modeUnchanged) {
          fileTabs = prev;
        } else {
          fileTabs = prev.map((t) => {
            if (t.id !== fileTabId || t.kind !== "file") return t;
            const next = { ...t };
            if (sourceSessionId) next.sourceSessionId = sourceSessionId;
            if (modeHint) next.initialDisplayMode = modeHint;
            return next;
          });
        }
      } else {
        fileTabs = prev;
      }
      return { fileTabs, activeFileTabId: fileTabId, rightPanelOpen: true };
    });
  }, [activeTabId, updateTab]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  // Open a (subagent) session in the right split pane as a closable tab, so the
  // main conversation stays put. Mirrors handleOpenFile but for sessions.
  // Resolves the id via the locate endpoint (Loop-Host probe first, then a
  // FORCED disk scan) — NOT the cached /api/sessions list: a freshly spawned
  // running subagent isn't in the 30s list cache yet, and the old list lookup
  // made the click silently do nothing until the cache caught up (felt like
  // "you must wait for the subagent to finish before opening it").
  const handleOpenSessionViewer = useCallback(async (sessionId: string) => {
    if (!activeTabId) return;
    let info: SessionInfo | undefined;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`);
      if (res.ok) {
        const data = await res.json() as { session?: SessionInfo };
        info = data.session;
      }
    } catch { /* ignore — cannot resolve */ }
    if (!info) return;
    const sessionInfo = info;
    const tabId = `session:${sessionId}`;
    const label = sessionInfo.name?.trim()
      || (sessionInfo.firstMessage ? sessionInfo.firstMessage.slice(0, 48) : "subagent");
    updateTab(activeTabId, (tab) => {
      if (tab.fileTabs.some((t) => t.id === tabId)) {
        return { activeFileTabId: tabId, rightPanelOpen: true };
      }
      return {
        fileTabs: [...tab.fileTabs, { id: tabId, kind: "session", label, sessionId, sessionInfo }],
        activeFileTabId: tabId,
        rightPanelOpen: true,
      };
    });
  }, [activeTabId, updateTab]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (!activeTabId) return;
    updateTab(activeTabId, (tab) => {
      const next = tab.fileTabs.filter((t) => t.id !== tabId);
      const activeFileTabId = tab.activeFileTabId !== tabId
        ? tab.activeFileTabId
        : (next.length > 0 ? next[next.length - 1].id : null);
      return { fileTabs: next, activeFileTabId, rightPanelOpen: next.length > 0 ? tab.rightPanelOpen : false };
    });
  }, [activeTabId, updateTab]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null || Boolean(activeTab?.loopPending);
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  const settingsCwd = activeWorkspace?.path
    ?? selectedSession?.cwd
    ?? effectiveNewSessionCwd
    ?? activeCwd
    ?? globalSettingsCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = navReady && activeWorkspace !== null && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const workspaceActivity = useMemo(() => {
    const result: Record<string, "running" | "completed" | undefined> = {};
    for (const session of sessionActivity.sessions) {
      const owner = workspaces
        .filter((workspace) => {
          const prefix = `${workspace.path.replace(/\/+$/, "")}/`;
          return workspace.available && (session.cwd === workspace.path || session.cwd.startsWith(prefix));
        })
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (!owner) continue;
      if (sessionActivity.runningIds.has(session.id)) result[owner.id] = "running";
      else if (sessionActivity.completedIds.has(session.id) && result[owner.id] !== "running") result[owner.id] = "completed";
    }
    return result;
  }, [sessionActivity.completedIds, sessionActivity.runningIds, sessionActivity.sessions, workspaces]);

  return {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    mruIds,
    setMruIds,
    navReady,
    setNavReady,
    sidebarView,
    setSidebarView,
    configView,
    setConfigView,
    configPortalNode,
    setConfigPortalNode,
    refreshKey,
    setRefreshKey,
    sessionKey,
    setSessionKey,
    explorerRefreshKey,
    setExplorerRefreshKey,
    modelsRefreshKey,
    setModelsRefreshKey,
    settingsPage,
    setSettingsPage,
    workspaceSettingsName,
    setWorkspaceSettingsName,
    loopEditorOpen,
    setLoopEditorOpen,
    workspaceManagerOpen,
    setWorkspaceManagerOpen,
    importPickerOpen,
    setImportPickerOpen,
    importBusy,
    setImportBusy,
    importError,
    setImportError,
    workspaces,
    setWorkspaces,
    workspacesLoaded,
    setWorkspacesLoaded,
    createWorkItemRequest,
    setCreateWorkItemRequest,
    openRepositoryFormRequest,
    setOpenRepositoryFormRequest,
    globalSettingsCwd,
    setGlobalSettingsCwd,
    projectTrust,
    setProjectTrust,
    projectTrustDialogOpen,
    setProjectTrustDialogOpen,
    projectTrustBusy,
    setProjectTrustBusy,
    projectTrustError,
    setProjectTrustError,
    sidebarOpen,
    setSidebarOpen,
    chatFocusKey,
    setChatFocusKey,
    panelFocus,
    setPanelFocus,
    sidebarWidth,
    setSidebarWidth,
    sidebarResizing,
    setSidebarResizing,
    branchTree,
    setBranchTree,
    branchActiveLeafId,
    setBranchActiveLeafId,
    systemPrompt,
    setSystemPrompt,
    sessionStats,
    setSessionStats,
    autoNameStatus,
    setAutoNameStatus,
    copiedSessionField,
    setCopiedSessionField,
    contextUsage,
    setContextUsage,
    activeTopPanel,
    setActiveTopPanel,
    topPanelPos,
    setTopPanelPos,
    loopRun,
    setLoopRun,
    loopPollTarget,
    setLoopPollTarget,
    handleOpenConfig,
    handleSidebarSwitchView,
    handleRailSwitch,
    handleWorkspaceSettingsSelection,
    focusChat,
    focusPanel,
    sidebarWidthRef,
    sidebarContainerRef,
    startSidebarResize,
    resetSidebarWidth,
    chatInputRef,
    pendingWorkItemConversationRef,
    topBarRef,
    languageBtnRef,
    branchLeafChangeFnRef,
    handleBranchDataChange,
    handleBranchLeafChange,
    systemBtnRef,
    handleSystemPromptChange,
    autoNameTimerRef,
    activeSessionIdRef,
    handleSessionStatsChange,
    sessionCopyTimerRef,
    handleCopySessionField,
    handleContextUsageChange,
    toggleTopPanel,
    openSessionStatsPanel,
    handleFileLineMention,
    updateTab,
    updateActiveTab,
    ensureTab,
    activateTab,
    navigateUrl,
    buildTabQuery,
    loadWorkspaces,
    applyUrlToTabs,
    initialNavDoneRef,
    handleSelectSession,
    handleOpenLoopSession,
    loopSeedAutoOpenedRef,
    handleLoopTriggered,
    handleOpenWorkspace,
    handleWorkspaceNewSession,
    handleReturnHome,
    handleCloseWorkspaceTab,
    handleCreateWorkspace,
    handleImportDirectory,
    handleWorkspaceDeleted,
    handleOpenSessionFromHome,
    handleCreateWorkItem,
    hydrateSelectedSession,
    handleSessionCreated,
    handleOpenWorkItemConversation,
    handleRunContract,
    handleAgentEnd,
    handleAutoName,
    handleSessionForked,
    handleOpenFile,
    handleOpenLinkedFile,
    handleOpenSessionViewer,
    handleCloseFileTab,
    handleViewFullHistory,
    handleTrustProject,
    workspaceActivity,
    activeTab,
    activeWorkspace,
    selectedSession,
    newSessionCwd,
    workspaceView,
    selectedWorkItemKey,
    fileTabs,
    activeFileTabId,
    rightPanelOpen,
    activeCwd,
    GLOBAL_PANEL_KEY,
    sessionActivity,
    clampSidebarWidth,
    effectiveNewSessionCwd,
    showChat,
    projectTrustCwd,
    settingsCwd,
    showPlaceholder,
    activeFileTab,
    activeCwdName,
    windowTitle,
  };
}
