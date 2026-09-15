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
import { clearDraft, getDraft, setDraft } from "@/lib/draft-store";
import { resolveContractPattern } from "@/lib/loops/contract-prefill";
import { defaultHomeNewSessionWorkspaceId, workspaceForSession } from "@/lib/home-quick-switch";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "../ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { WorkItemDetail, WorkItemRecord } from "@/lib/work-items/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { type Tab, FILES_TAB_ID } from "@/lib/tab-types";
import {
  type SessionTabState,
  createSessionTab,
  createNewSessionTab,
  createHomeTab,
  sessionTabId,
  homeTabId,
  newSessionTabId,
  resolveOpenSessionTarget,
  nextActiveTabId,
  tabQuery,
  serializeTabs,
  parseStoredTabs,
  restoreTabs,
} from "@/lib/session-tabs";

type SessionCopyField = "file" | "id";

/** 工作区家 tab（总览）内的 hub 子视图：overview 仪表盘 / 工作项管理面 /
 * 知识库浏览（W-中收敛，docs/session-tabs-design.md Phase 2）。 */
export type HubView = "overview" | "work-items" | "knowledge";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const LANGUAGE_MENU_WIDTH = 176;
// Desktop sidebar is drag-resizable (handle between sidebar and center). Width is
// persisted in localStorage; clamped to these bounds. Mobile keeps a fixed drawer.
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_WIDTH_KEY = "pi-sidebar-width";

// Right (file) panel resize — same shape as the sidebar, but the DEFAULT is
// the CSS 42% fallback (rightPanelWidth === null → no --pi-right-panel-width
// override); dragging stores a px width. The max keeps the center chat area
// usable (≥620px for toolbar + tabs + composer).
const RIGHT_PANEL_MIN_WIDTH = 300;
const RIGHT_PANEL_WIDTH_KEY = "pi-right-panel-width";

// R2：会话 tab 条持久化（身份 + 顺序 + active；fileTabs/右栏开合不持久化，
// 重载后为默认态）。失效 id（会话已删/归档、工作区不可用）在恢复时静默跳过。
const SESSION_TABS_STORAGE_KEY = "pi-session-tabs";

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
  // ---- Session tabs ----------------------------------------------------------
  // Each open tab (session / new-session placeholder / workspace home) is one
  // entry in `tabs`; the active one is `activeTabId`. Per-tab view state is
  // read directly off the active tab (no snapshot dance), and the URL is a
  // write-only projection of it. The workspace context (`activeWorkspace`)
  // follows the ACTIVE tab — the same chain the old workspace-tab model used.
  const [tabs, setTabs] = useState<SessionTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // MRU of WORKSPACE ids (for the home composer's default workspace pick) —
  // activateTab pushes the activated tab's workspace.id.
  const [mruIds, setMruIds] = useState<string[]>([]);
  // Tabs mirror for stable callbacks (activateTab reads it to resolve the
  // workspace for MRU without depending on `tabs`).
  const tabsRef = useRef<SessionTabState[]>([]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  // 首页无主新会话页（B1 原地切换）：open 时首页主区渲染工作区选择器 + composer；
  // 任何 tab 切换（含点首页返回）都会将其重置（见 activateTab）。
  const [homeNewSession, setHomeNewSession] = useState<{ open: boolean; workspaceId: string | null }>({ open: false, workspaceId: null });
  // 从首页打开的会话（反馈修订：不跳工作区 tab）：聊天直接落在首页主区的
  // ChatWindow，左侧中栏保持首页菜单；会话归属工作区不变（磁盘/daemon 决定）。
  const [homeSession, setHomeSession] = useState<SessionInfo | null>(null);
  // 首页右栏文件面板（反馈：首页也要文件区）：与工作区 tab 的右栏同构，但
  // 状态独立（无 tab 可挂）。默认关闭，右上角按钮切换；上下文工作区 =
  // 首页会话所属 / composer 所选工作区（DesktopShell 计算）。
  const [homeFileTabs, setHomeFileTabs] = useState<Tab[]>([]);
  const [homeActiveFileTabId, setHomeActiveFileTabId] = useState<string | null>(null);
  const [homeRightPanelOpen, setHomeRightPanelOpen] = useState(false);
  // False until the initial URL→tab restore has run, to avoid flashing the
  // "select a session" placeholder while the addressed tab is still loading.
  const [navReady, setNavReady] = useState(false);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeWorkspace = activeTab?.workspace ?? null;
  const selectedSession = activeTab?.kind === "session" ? activeTab.session : null;
  const newSessionCwd = activeTab?.kind === "new-session" ? activeTab.workspace.path : null;
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
  // 家 tab（工作区总览）内的 hub 子视图（W-中：知识库/工作项/Loops 面板收进
  // 总览 hub；Loops 本就是总览区块）。Session-only：随 activateTab 重置，不持久化。
  const [hubView, setHubView] = useState<HubView>("overview");
  // The right column's config portal target (the div under the config view's
  // PanelHeader). The middle-column split panel (ModelsConfig/SkillsConfig/
  // PluginsConfig in `split` mode) portals its DETAIL pane into this node —
  // callback-ref + state so the portal re-renders as soon as the node mounts
  // (same commit, before paint; null target simply renders nothing).
  const [configPortalNode, setConfigPortalNode] = useState<HTMLDivElement | null>(null);
  // The work-item DETAIL split (desktop): clicking a work item in the
  // middle-column 工作项 panel opens its detail in the right column (the same
  // config area the 模型/Skills/插件 split views use — the middle column keeps
  // the LIST). `workItemDetail` is the shell-side mirror of the manager's
  // selection (key/title, for the right-column PanelHeader); the close tick
  // tells the manager to clear its selection (the × button — request-counter
  // pattern, like createWorkItemRequest). Cleared wherever configView clears
  // (panel switch / session select / new session / workspace switch): those
  // are all “show me something else in the right column” intents.
  const [workItemDetail, setWorkItemDetail] = useState<{ key: string; title: string } | null>(null);
  // Loops 面板 → 工作台文件区的定位意图（一次性信号，非持久视图状态——无需清空
  // 点位）：loop 名点击时写入 `loops/<name>`，nonce 保证同一路径可重复触发；
  // 两 shell 把它透传给 WorkspaceSidebar（filesReveal → FileExplorer reveal +
  // openFilesRequest 展开文件 section）。
  const [loopFilesReveal, setLoopFilesReveal] = useState<{ path: string; nonce: number } | null>(null);
  const [closeWorkItemDetailTick, setCloseWorkItemDetailTick] = useState(0);
  const handleCloseWorkItemDetail = useCallback(() => {
    setWorkItemDetail(null);
    setCloseWorkItemDetailTick((tick) => tick + 1);
  }, []);
  const handleOpenConfig = useCallback((view: ConfigView) => {
    setConfigView((current) => (current === view ? null : view));
    // The config view takes over the right column — drop a stale work-item
    // detail so closing the config view doesn't resurrect it.
    setWorkItemDetail(null);
    // The config LIST lives in the middle column — make sure the column is
    // visible when a config view opens (desktop-only entry point; mobile
    // serves the same content via the settings subpages and never gets here).
    setSidebarOpen(true);
  }, []);
  useEffect(() => {
    setConfigView(null);
    setWorkItemDetail(null);
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
    setWorkItemDetail(null);
    setSidebarView(view);
    if (GLOBAL_ACTIVITY_VIEWS.includes(view)) {
      try { localStorage.setItem(GLOBAL_PANEL_KEY, view); } catch { /* ignore */ }
      if (view === "settings") setSettingsPage("index");
    } else {
      // 离开全局面板（如设置）切到模块视图 = 终结粘性：否则工作区切换 effect
      // 里 storedGlobal==="settings" 的分支永远劫持每工作区视图（用户点过
      // 工作台也无效）。停留在设置时切工作区的粘性由进入设置时写入的键保留。
      try { localStorage.removeItem(GLOBAL_PANEL_KEY); } catch { /* ignore */ }
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
  // subagent child 和 kit 轮会话 —— 单一集合就是完整答案，不再需要
  // 客户端把「pin 住的 loop 会话」合并进来（那套合并存在的原因是 web 进程的
  // running 集永远不含 daemon 会话）。
  // 全局 SSE：为每个 running session 维护一条事件流，后台 session 事件不丢（决策 8 / B4b）。
  useGlobalAgentEvents(sessionActivity.runningIds);
  const [sessionKey, setSessionKey] = useState(0);
  // Composer prefill epoch — bumped when a handler writes a NEW-session draft
  // (contract prefill, D11) for a composer that may ALREADY be mounted with
  // the same draftKey. ChatWindow keys its ChatInput mount on this value, so
  // the bump forces a remount and the input re-reads the draft store
  // (ChatInput hydrates from the draft only on mount / draftKey change).
  const [composerEpoch, setComposerEpoch] = useState(0);
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
  // create work item…) bump these; the mobile shell reacts by
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

  // ---- Desktop right (file) panel resize --------------------------------------
  // Mirrors the sidebar resize: `rightPanelWidthRef` mirrors state so mouseup
  // can persist the final value; null width = CSS 42% default (double-click
  // reset removes the stored key). Clamp keeps the chat area ≥620px wide.
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelWidthRef = useRef<number | null>(null);
  const rightPanelContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rightPanelWidthRef.current = rightPanelWidth; }, [rightPanelWidth]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
      if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) setRightPanelWidth(Math.round(n));
      }
    } catch { /* localStorage unavailable — keep default */ }
  }, []);
  const clampRightPanelWidth = (n: number) =>
    Math.min(Math.max(window.innerWidth - 620, RIGHT_PANEL_MIN_WIDTH), Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(n)));
  const startRightPanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = rightPanelContainerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startWidth = container.getBoundingClientRect().width;
    setRightPanelResizing(true);
    const onMove = (ev: MouseEvent) => {
      // dragging the handle LEFT widens the right panel
      setRightPanelWidth(clampRightPanelWidth(startWidth + (startX - ev.clientX)));
    };
    const onUp = () => {
      setRightPanelResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        if (rightPanelWidthRef.current != null) {
          localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidthRef.current));
        } else {
          localStorage.removeItem(RIGHT_PANEL_WIDTH_KEY);
        }
      } catch { /* ignore */ }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  const resetRightPanelWidth = useCallback(() => {
    setRightPanelWidth(null);
    try { localStorage.removeItem(RIGHT_PANEL_WIDTH_KEY); } catch { /* ignore */ }
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
    patch: Partial<SessionTabState> | ((tab: SessionTabState) => Partial<SessionTabState>),
  ) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      const p = typeof patch === "function" ? patch(t) : patch;
      return { ...t, ...p };
    }));
  }, []);

  const updateActiveTab = useCallback((
    patch: Partial<SessionTabState> | ((tab: SessionTabState) => Partial<SessionTabState>),
  ) => {
    if (activeTabId) updateTab(activeTabId, patch);
  }, [activeTabId, updateTab]);

  /** 家 tab（U1：每工作区一个）：已开则返回既有 id，未开则追加。同时同步
   *  workspaces 主列表（capability/仓库等在 tab 打开期间会变）。 */
  const ensureHomeTab = useCallback((workspace: WorkspaceSummary): string => {
    setWorkspaces((current) => current.some((w) => w.id === workspace.id)
      ? current.map((w) => (w.id === workspace.id ? workspace : w))
      : [...current, workspace]);
    const id = homeTabId(workspace.id);
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, createHomeTab(workspace)]));
    return id;
  }, []);

  // Make a tab active (or go home with null). Closes overlays and clears the
  // per-session UI that ChatWindow will re-populate for the new session.
  const activateTab = useCallback((id: string | null) => {
    setWorkspaceManagerOpen(false);
    setProjectTrustDialogOpen(false);
    setActiveTopPanel(null);
    setHubView("overview");
    if (id) {
      // MRU 记的是工作区 id（首页 composer 默认工作区的选源）；新 tab 尚未
      // 进入 tabsRef 时跳过本次（best-effort，不影响正确性）。
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab) setMruIds((ids) => [tab.workspace.id, ...ids.filter((x) => x !== tab.workspace.id)]);
    }
    setActiveTabId(id);
    setHomeNewSession({ open: false, workspaceId: null });
    setHomeSession(null);
    setHomeFileTabs([]);
    setHomeActiveFileTabId(null);
    setHomeRightPanelOpen(false);
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

  /** U1 会话 tab 唯一性：已开则聚焦（制新 session 信息），未开则新建并激活。
   *  归属工作区由 session.cwd 派生（最长前缀）；无归属时回退当前 tab 的工作区
   *  上下文，两者皆无则不开（与旧模型「无归属会话不可开」一致）。 */
  const openSessionTab = useCallback((session: SessionInfo): string | null => {
    const owner = workspaceForSession(session, workspaces) ?? activeWorkspace;
    if (!owner) return null;
    const id = sessionTabId(session.id);
    setTabs((prev) => prev.some((t) => t.id === id)
      ? prev.map((t) => (t.id === id ? { ...t, session, workspace: owner } : t))
      : [...prev, createSessionTab(owner, session)]);
    activateTab(id);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    focusChat();
    navigateUrl(tabQuery(createSessionTab(owner, session)));
    return id;
  }, [workspaces, activeWorkspace, activateTab, navigateUrl, focusChat]);

  const openNewSessionTab = useCallback((workspace: WorkspaceSummary): string => {
    const id = newSessionTabId(
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setTabs((prev) => [...prev, createNewSessionTab(workspace, id)]);
    activateTab(id);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    focusChat();
    navigateUrl(`workspace=${encodeURIComponent(workspace.id)}&view=chat`);
    return id;
  }, [activateTab, navigateUrl, focusChat]);

  /** X1 关 tab：草稿确认（会话 tab 用 session.id 键，占位 tab 用 tab.id 键）
   *  → 邻居规则回落（先左后右；一个不剩 → 首页）。会话删除/归档的自动关
   *  闭路径传 skipDraftConfirm（草稿已无意义）。 */
  const closeTab = useCallback((id: string, options?: { skipDraftConfirm?: boolean }) => {
    const tab = tabs.find((t) => t.id === id) ?? null;
    if (tab && !options?.skipDraftConfirm) {
      const draftKey = tab.kind === "session" && tab.session ? tab.session.id : tab.id;
      const draft = getDraft(draftKey);
      if (draft && (draft.value || draft.images.length > 0)) {
        if (!window.confirm("这个 tab 有未发送的聊天草稿。要关闭并丢弃草稿吗？")) return;
        clearDraft(draftKey);
      }
    }
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeTabId !== id) return;
    const nextId = nextActiveTabId(tabs, id);
    if (nextId) {
      activateTab(nextId);
      const nextTab = remaining.find((t) => t.id === nextId);
      navigateUrl(nextTab ? tabQuery(nextTab) : null);
    } else {
      activateTab(null);
      navigateUrl("tab=home");
    }
  }, [tabs, activeTabId, activateTab, navigateUrl]);

  /** 会话删除/归档：其 tab 自动关闭（X1 邻居回落；草稿随会话失效免确认）+ 列表刷新。 */
  const handleSessionRemoved = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    const id = sessionTabId(sessionId);
    if (tabsRef.current.some((t) => t.id === id)) {
      closeTab(id, { skipDraftConfirm: true });
    }
  }, [closeTab]);

  /** tab 条点击：激活既有 tab + URL 投影 + ChatWindow 重建信号（M1：切 tab =
   *  与切会话同构的重建）。家 tab 不需要重建信号（无 ChatWindow）。 */
  const handleSelectTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    activateTab(id);
    if (tab.kind !== "workspace-home") {
      setSessionKey((k) => k + 1);
      setSystemPrompt(null);
      focusChat();
    }
    navigateUrl(tabQuery(tab));
  }, [activateTab, navigateUrl, focusChat]);

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

    // Legacy URL views: settings → 全局面板；work-items → 家 tab hub（W-中后
    // 工作项面板收进总览 hub，不再有中栏面板可落）。
    const isChat = rawView === "chat";
    const legacySettings = rawView === "settings";
    const legacyWorkItems = rawView === "work-items";
    // Persist the legacy settings deep-link BEFORE activating the tab — the
    // activeWorkspace effect re-derives `sidebarView` from this key on tab
    // switch and would otherwise clobber an immediate setState.
    if (legacySettings) {
      try {
        localStorage.setItem(GLOBAL_PANEL_KEY, "settings");
      } catch { /* ignore */ }
    }
    if (isChat && session) {
      // 会话 tab：已开则刷新 session 信息（保留 F1 文件 tab 状态），未开则新建。
      const id = sessionTabId(session.id);
      setTabs((prev) => prev.some((t) => t.id === id)
        ? prev.map((t) => (t.id === id ? { ...t, session, workspace } : t))
        : [...prev, createSessionTab(workspace, session)]);
      activateTab(id);
      return;
    }
    if (isChat) {
      // 新会话占位 tab（view=chat 无 session）：复用该工作区已有的最新占位 tab，
      // 避免 popstate 来回导航叠加占位。
      const existing = [...tabsRef.current].reverse().find((t) => t.kind === "new-session" && t.workspace.id === workspaceId);
      if (existing) {
        activateTab(existing.id);
        return;
      }
      const id = newSessionTabId(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
      setTabs((prev) => [...prev, createNewSessionTab(workspace, id)]);
      activateTab(id);
      return;
    }
    // 家 tab（overview 落地；legacy work-items 深链落到 hub 工作项视图——
    // 必须在 activateTab 之后 set（activateTab 会重置 hubView）。）
    const homeId = ensureHomeTab(workspace);
    activateTab(homeId);
    if (legacyWorkItems) {
      setHubView("work-items");
      if (itemKey) updateTab(homeId, { workItemKey: itemKey });
    }
  }, [workspaces, sessionActivity.sessions, ensureHomeTab, updateTab, activateTab]);

  // Initial restore: once workspaces are loaded, (a) R2 恢复 tab 条全量（URL
  // 深链优先决定 active；URL 为首页则停在首页；URL 为空才用恢复的 active），
  // (b) 打开 URL 指向的 tab。恢复用的会话列表自取一次（不依赖 sessionActivity
  // 的异步时序）；两者都是 best-effort，失败不阻断导航。
  const initialNavDoneRef = useRef(false);
  useEffect(() => {
    if (!workspacesLoaded || initialNavDoneRef.current) return;
    initialNavDoneRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const urlPointsSomewhere = Boolean(params.get("workspace") || params.get("tab"));
    void (async () => {
      let restoredTabs: SessionTabState[] = [];
      let restoredActive: string | null = null;
      try {
        const stored = parseStoredTabs(localStorage.getItem(SESSION_TABS_STORAGE_KEY));
        if (stored && stored.tabs.length > 0) {
          let sessions = sessionActivity.sessions;
          if (sessions.length === 0) {
            try {
              const r = await fetch("/api/sessions");
              const d = r.ok ? await r.json() as { sessions?: SessionInfo[] } : null;
              sessions = d?.sessions ?? [];
            } catch { /* fall through with empty list — session tabs skip */ }
          }
          const result = restoreTabs(stored, workspaces, sessions);
          restoredTabs = result.tabs;
          restoredActive = result.activeTabId;
        }
      } catch { /* restore is best-effort */ }
      await applyUrlToTabs(params);
      if (restoredTabs.length > 0) {
        // 合并：URL 深链新建的 tab 靠右（浏览器「恢复会话 + 新开 tab」的惯例）；
        // 与恢复项重复的（同会话/同家）以 URL 侧为准。
        setTabs((prev) => {
          const ids = new Set(prev.map((t) => t.id));
          return [...restoredTabs.filter((t) => !ids.has(t.id)), ...prev];
        });
        if (!urlPointsSomewhere && restoredActive) {
          setActiveTabId(restoredActive);
        }
      }
    })().finally(() => setNavReady(true));
  }, [workspacesLoaded, workspaces, sessionActivity.sessions, applyUrlToTabs]);

  // R2 写入：tab 身份 + 顺序 + active（便宜：纯序列化）。navReady 前不写，避免
  // 把恢复前的空态覆盖进存储。
  useEffect(() => {
    if (!navReady) return;
    try {
      localStorage.setItem(SESSION_TABS_STORAGE_KEY, JSON.stringify(serializeTabs(tabs, activeTabId)));
    } catch { /* ignore */ }
  }, [tabs, activeTabId, navReady]);

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
        const fresh = workspaces.find((w) => w.id === t.workspace.id);
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

  // 首页点会话 = 打开它的会话 tab 并激活（会话 tab 模型；无归属会话在
  // openSessionTab 内回退当前上下文工作区或忽略）。首页保持纯启动器。
  const handleOpenSessionFromHome = useCallback((session: SessionInfo) => {
    setWorkspaceManagerOpen(false);
    setConfigView(null);
    setWorkItemDetail(null);
    openSessionTab(session);
  }, [openSessionTab]);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    // 首页（无活动 tab）点会话 = 跨工作区直达，委托给首页管道，不再静默吞掉。
    if (!activeTabId) {
      handleOpenSessionFromHome(session);
      return;
    }
    // U1：该会话已有 tab → 聚焦即可（会话全局唯一 tab）。
    const existingId = sessionTabId(session.id);
    if (tabs.some((t) => t.id === existingId)) {
      setConfigView(null);
      setWorkItemDetail(null);
      activateTab(existingId);
      setSessionKey((k) => k + 1);
      setSystemPrompt(null);
      focusChat();
      const tab = tabs.find((t) => t.id === existingId);
      if (tab) navigateUrl(tabQuery(tab));
      return;
    }
    const target = resolveOpenSessionTarget(activeTab);
    // 家 tab 是枢纽锚点：列表点击开新会话 tab，不吃掉家 tab。
    if (target === "new-tab") {
      handleOpenSessionFromHome(session);
      return;
    }
    // C1 morph：当前会话/占位 tab 原地变身（保留 F1 文件 tab 状态）。
    setConfigView(null);
    setWorkItemDetail(null);
    const owner = workspaceForSession(session, workspaces) ?? activeTab?.workspace ?? null;
    if (!owner) return;
    const fresh = createSessionTab(owner, session);
    setTabs((prev) => prev.map((t) => (t.id === activeTabId
      ? { ...fresh, fileTabs: t.fileTabs, activeFileTabId: t.activeFileTabId, rightPanelOpen: t.rightPanelOpen }
      : t)));
    activateTab(existingId);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    focusChat();
    navigateUrl(tabQuery(fresh));
  }, [activeTabId, activeTab, tabs, workspaces, handleOpenSessionFromHome, activateTab, navigateUrl, focusChat]);

  // 按会话 id 打开（subagent 子会话 / 工作项关联会话）。走专门的 locate 端点：
  // 优先 probe daemon 拿权威元信息（会话在 daemon 进程里，它最先知道），
  // daemon 不可达/旧版本时回退到强制刷新磁盘扫描。两种路径都不依赖 30s 列表缓存，
  // 所以新建的会话能立刻打开，而不是“过一会才出现”。
  const handleOpenConversation = useCallback((sessionId: string) => {
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`)
      .then((r) => (r.ok ? (r.json() as Promise<{ session: SessionInfo }>) : null))
      .then((d) => {
        if (d?.session) {
          openSessionTab(d.session);
          // locate 已让磁盘缓存失效；触发侧边栏重拉，让这个新会话立即出现在会话列表里。
          setRefreshKey((k) => k + 1);
        }
      })
      .catch(() => {});
  }, [openSessionTab]);

  const handleOpenWorkspace = useCallback((workspace: WorkspaceSummary) => {
    // P1：开工作区 = 开/激活它的家 tab（总览落地；会话 tab 模型下「进入工作区」
    // 与「看它的总览」是同一件事）。
    const id = ensureHomeTab(workspace);
    activateTab(id);
    navigateUrl(`workspace=${encodeURIComponent(workspace.id)}&view=overview`);
  }, [ensureHomeTab, activateTab, navigateUrl]);

  /** Overview（家 tab）的回头路：工作台 PanelHeader「总览」按钮 → 开/激活当前
   *  工作区的家 tab；移动端由 MobileShell 用本地栈接管（onShowOverview prop）。 */
  const handleShowOverview = useCallback(() => {
    if (!activeWorkspace) return;
    setConfigView(null);
    setWorkItemDetail(null);
    const id = ensureHomeTab(activeWorkspace);
    activateTab(id);
    navigateUrl(`workspace=${encodeURIComponent(activeWorkspace.id)}&view=overview`);
  }, [activeWorkspace, ensureHomeTab, activateTab, navigateUrl]);

  const handleWorkspaceNewSession = useCallback(() => {
    // 新建会话 = 开一个新的占位 tab（U1 豁免：同工作区可并存多个 composer）；
    // 当前会话视图不被替换。
    if (!activeWorkspace) return;
    setConfigView(null);
    setWorkItemDetail(null);
    openNewSessionTab(activeWorkspace);
  }, [activeWorkspace, openNewSessionTab]);

  const handleReturnHome = useCallback(() => {
    activateTab(null);
    navigateUrl("tab=home");
  }, [activateTab, navigateUrl]);

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
    // 关掉该工作区的全部 tab（家 tab + 会话/占位 tab）；活动 tab 在其中则落到
    // 移除块位置的最近残留 tab，一个不剩 → 首页。工作区删除无需草稿确认。
    const index = tabs.findIndex((t) => t.workspace.id === workspace.id);
    const remaining = tabs.filter((t) => t.workspace.id !== workspace.id);
    setTabs(remaining);
    if (index !== -1 && activeTab && activeTab.workspace.id === workspace.id) {
      const next = remaining[Math.min(index, remaining.length - 1)] ?? null;
      if (next) {
        activateTab(next.id);
        navigateUrl(tabQuery(next));
      } else {
        activateTab(null);
        navigateUrl("tab=home");
      }
    }
  }, [tabs, activeTab, activateTab, navigateUrl]);

  // ---- 首页无主新会话页（grill 共识：B1 原地切换）-----------------------------
  // 打开时默认选中最近活跃工作区（最近会话所属 → MRU tab → 第一个可用）。
  const handleHomeNewSession = useCallback(() => {
    const workspaceId = defaultHomeNewSessionWorkspaceId(workspaces, sessionActivity.sessions, mruIds);
    setHomeSession(null);
    setHomeNewSession({ open: true, workspaceId });
    focusChat();
  }, [workspaces, sessionActivity.sessions, mruIds, focusChat]);

  const handleHomeNewSessionSelect = useCallback((workspaceId: string) => {
    setHomeNewSession((current) => (current.open ? { ...current, workspaceId } : current));
  }, []);

  const handleExitHomeNewSession = useCallback(() => {
    setHomeNewSession({ open: false, workspaceId: null });
  }, []);

  // 首页 composer 首次发送后：会话聊天原地落在首页主区（不跳工作区 tab）。
  // homeNewSession 关闭 → 主区切到 homeSession 分支的 ChatWindow（按 session
  // 加载上下文；若首条回复仍在流式，state 探测 isStreaming 后 SSE 自动接上）。
  const handleHomeSessionCreated = useCallback((session: SessionInfo) => {
    setHomeSession(session);
    setHomeNewSession({ open: false, workspaceId: null });
    setSessionKey((key) => key + 1);
    focusChat();
  }, [focusChat]);

  const handleCreateWorkItem = useCallback((type: "requirement" | "bug") => {
    // W-中：工作项面收进家 tab hub——开/激活家 tab 并切到工作项 hub 视图，
    // 创建请求送进挂在那里的 WorkspaceManager。移动端由 MobileShell 自己接管
    // （overview 栈），不经此路径。
    if (!activeWorkspace?.capabilities.includes("work-items")) {
      setCreateWorkItemRequest({ type, id: Date.now() });
      return;
    }
    const homeId = ensureHomeTab(activeWorkspace);
    activateTab(homeId);
    setHubView("work-items");
    setCreateWorkItemRequest({ type, id: Date.now() });
    // On mobile, switch to the 工作台 tab（overview 栈在那里）。
    focusPanel("workbench");
  }, [activeWorkspace, ensureHomeTab, activateTab, focusPanel]);

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
  // 按 s:<sessionId> 定位（不按活动 tab：占位转正/fork 后 tab id 会变，
  // 调用时闭包里的 activeTabId 可能已过期）。
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        updateTab(sessionTabId(sessionId), (tab) => (tab.session?.id === sessionId && !tab.session.projectRoot ? { session: full } : {}));
      })
      .catch(() => {});
  }, [updateTab]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    // 占位 tab 原地转正（U1）：id 换成 s:<sessionId>；若该会话已有 tab（并发
    // 边角）则并入既有 tab 并关占位。F1 文件 tab 状态随 tab 保留。
    const newId = sessionTabId(session.id);
    if (tabs.some((t) => t.id === newId)) {
      setTabs((prev) => prev
        .filter((t) => t.id !== tab.id)
        .map((t) => (t.id === newId ? { ...t, session } : t)));
      activateTab(newId);
    } else {
      setTabs((prev) => prev.map((t) => (t.id === tab.id
        ? { ...createSessionTab(t.workspace, session), fileTabs: t.fileTabs, activeFileTabId: t.activeFileTabId, rightPanelOpen: t.rightPanelOpen }
        : t)));
      activateTab(newId);
    }
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    navigateUrl(`workspace=${encodeURIComponent(tab.workspace.id)}&view=chat&session=${encodeURIComponent(session.id)}`, true);
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
  }, [activeTabId, tabs, activateTab, navigateUrl, hydrateSelectedSession]);

  const handleOpenWorkItemConversation = useCallback(async (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
  ) => {
    // Opening the conversation is an explicit “show me the chat” intent — drop
    // the right-column config/work-item-detail views so the chat is visible
    // (the button itself lives inside the portaled work-item detail).
    setConfigView(null);
    setWorkItemDetail(null);
    // Latest conversation first: a kit round (or run-contract prefill) session is
    // APPENDED to `conversations`, so the most recent entry is the live/latest
    // contract run. Resolve via /locate (daemon probe + forced disk scan) — never the
    // 30s-cached /api/sessions list, which misses freshly seeded sessions.
    for (let index = item.conversations.length - 1; index >= 0; index -= 1) {
      const conversationId = item.conversations[index];
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(conversationId)}/locate`);
        if (response.ok) {
          const data = await response.json() as { session?: SessionInfo };
          if (data.session) {
            openSessionTab(data.session);
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
    openNewSessionTab(workspace);
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
  }, [openSessionTab, openNewSessionTab]);

  /** 「立即跑一轮」的公共主体（WorkspaceOverview B 按钮与 LoopsPanel「运行」
   *  共用）：POST run 路由（daemon 现有会话面起轮；itemKey 存在时才带优
   *  先工作项），成功后把新轮会话开成 workspace 的 chat tab（SSE 实时观
   *  看；locate 直接命中——run 路由已播种 cacheSessionPath）。409（本轮流
   *  已在跑）等错误用 alert 直陈。 */
  const runLoopAndOpen = useCallback(async (
    workspace: WorkspaceSummary,
    loopName: string,
    itemKey?: string,
  ): Promise<void> => {
    let sessionId: string | undefined;
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(loopName)}/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(itemKey ? { itemKey } : {}),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { sessionId?: string; error?: string };
      if (!response.ok || !body.sessionId) {
        window.alert(body.error || `起轮失败（HTTP ${response.status}）`);
        return;
      }
      sessionId = body.sessionId;
    } catch (error) {
      window.alert(`起轮失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setConfigView(null);
    setWorkItemDetail(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`);
      if (response.ok) {
        const data = await response.json() as { session?: SessionInfo };
        if (data.session) {
          openSessionTab(data.session);
          return;
        }
      }
    } catch { /* fall through */ }
    window.alert("轮已启动，但打开会话视图失败——请从会话列表进入。");
  }, [openSessionTab]);

  /** 「立即跑一轮」（spec §4 B 按钮）：带工作项优先键起轮并打开轮会话 tab。 */
  const handleRunLoopRound = useCallback(async (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
    loopName: string,
  ): Promise<void> => {
    await runLoopAndOpen(workspace, loopName, item.key);
  }, [runLoopAndOpen]);

  /** LoopsPanel「运行」按钮：不带工作项直接手动起一轮并打开轮会话 tab。 */
  const handleRunLoopDirect = useCallback(async (
    workspace: WorkspaceSummary,
    loopName: string,
  ): Promise<void> => {
    await runLoopAndOpen(workspace, loopName);
  }, [runLoopAndOpen]);

  /** Kit 时代「按合同执行」/「收养续跑」（D11）：不再 POST daemon seed — 改为
   *  客户端预填。取该 workspace 的 kit loop 合同（GET /loops，纯文件发现），
   *  把 `/skill:<pattern> 执行|收养 <KEY>` 写进其新会话 composer 的草稿，再切到
   *  该 workspace 的 chat 视图；人按发送才真正起会话（pi 到首条消息才建
   *  .jsonl，不再预建）。离线 / 无 kit loop 时退化为不带 /skill: 前缀的裸提示。 */
  const handleRunContract = useCallback(async (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
    mode: "execute" | "adopt",
  ): Promise<void> => {
    let pattern: string | undefined;
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/loops`);
      if (response.ok) {
        const data = (await response.json()) as { loops?: Array<{ name?: string; pattern: string; paused?: boolean }> };
        pattern = resolveContractPattern(item.loop, data.loops ?? []);
      }
    } catch { /* offline — degrade to a bare prompt without the /skill: prefix */ }
    const verb = mode === "adopt" ? "收养" : "执行";
    const text = pattern
      ? `/skill:${pattern} ${verb} ${item.key}`
      : `${verb} ${item.key}`;
    setConfigView(null);
    setWorkItemDetail(null);
    const tabId = openNewSessionTab(workspace);
    // 草稿键 = 占位 tab id（U1：多 composer 并存互不互踩，修复旧 new:<wsPath> 隐患）；
    // composerEpoch 强制已挂载的 ChatInput 重读草稿。
    setDraft(tabId, { value: text, images: [] });
    setComposerEpoch((epoch) => epoch + 1);
  }, [openNewSessionTab]);

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
    // K1：fork 结果开新会话 tab，原对话 tab 原地不动（fork 的典型意图就是
    // 「另开一条路，原对话留着」）。
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.kind !== "session" || !tab.session) return;
    setRefreshKey((k) => k + 1);
    const forked: SessionInfo = { ...tab.session, id: newSessionId };
    openSessionTab(forked);
    hydrateSelectedSession(newSessionId);
  }, [activeTabId, tabs, openSessionTab, hydrateSelectedSession]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    // 首页（无活动 tab）：文件 tab 落在首页自己的右栏并展开面板。
    if (!activeTabId) {
      const fileTabId = `file:${filePath}`;
      setHomeFileTabs((prev) => {
        const existing = prev.find((t) => t.id === fileTabId);
        if (!existing) {
          return [...prev, {
            id: fileTabId,
            kind: "file",
            label: fileName,
            filePath,
            sourceSessionId,
            initialDisplayMode: modeHint,
          }];
        }
        if (existing.kind !== "file") return prev;
        const sourceUnchanged = !sourceSessionId || existing.sourceSessionId === sourceSessionId;
        const modeUnchanged = !modeHint || existing.initialDisplayMode === modeHint;
        if (sourceUnchanged && modeUnchanged) return prev;
        return prev.map((t) => {
          if (t.id !== fileTabId || t.kind !== "file") return t;
          return {
            ...t,
            sourceSessionId: sourceSessionId ?? t.sourceSessionId,
            initialDisplayMode: modeHint ?? t.initialDisplayMode,
          };
        });
      });
      setHomeActiveFileTabId(fileTabId);
      setHomeRightPanelOpen(true);
      return;
    }
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
  // Resolves the id via the locate endpoint (daemon probe first, then a
  // FORCED disk scan) — NOT the cached /api/sessions list: a freshly spawned
  // running subagent isn't in the 30s list cache yet, and the old list lookup
  // made the click silently do nothing until the cache caught up (felt like
  // "you must wait for the subagent to finish before opening it").
  const handleOpenSessionViewer = useCallback(async (sessionId: string) => {
    // 会话 tab 模型：subagent 子会话等作为顶层会话 tab 打开（保留父会话视图；
    // U1 去重聚焦）。仍走 locate 端点（daemon probe + 强制磁盘扫描），不依赖
    // 30s 列表缓存——新建的子会话能立刻打开。
    let info: SessionInfo | undefined;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`);
      if (res.ok) {
        const data = await res.json() as { session?: SessionInfo };
        info = data.session;
      }
    } catch { /* ignore — cannot resolve */ }
    if (!info) return;
    openSessionTab(info);
  }, [openSessionTab]);

  // 首页右栏文件 tab 关闭：关掉活动的则回落到「文件」树 tab（无邻居逻辑，
  // 首页面板是临时性）。与 handleCloseFileTab 对偶。
  const handleCloseHomeFileTab = useCallback((tabId: string) => {
    setHomeFileTabs((prev) => prev.filter((t) => t.id !== tabId));
    setHomeActiveFileTabId((cur) => (cur === tabId ? null : cur));
  }, []);

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (!activeTabId) return;
    updateTab(activeTabId, (tab) => {
      const next = tab.fileTabs.filter((t) => t.id !== tabId);
      const activeFileTabId = tab.activeFileTabId !== tabId
        ? tab.activeFileTabId
        : (next.length > 0 ? next[next.length - 1].id : FILES_TAB_ID);
      // 关掉最后一个文件 tab 时回落到固定的「文件」tab（右栏保持常开，
      // 桌面展示文件树；移动端 overlay 靠 activeFileTab 判空自动隐藏），
      // 不再自动收起右栏。
      return { fileTabs: next, activeFileTabId, rightPanelOpen: tab.rightPanelOpen };
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
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
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
    hubView,
    setHubView,
    configPortalNode,
    setConfigPortalNode,
    workItemDetail,
    setWorkItemDetail,
    loopFilesReveal,
    setLoopFilesReveal,
    handleCloseWorkItemDetail,
    closeWorkItemDetailTick,
    refreshKey,
    setRefreshKey,
    sessionKey,
    setSessionKey,
    composerEpoch,
    explorerRefreshKey,
    setExplorerRefreshKey,
    modelsRefreshKey,
    setModelsRefreshKey,
    settingsPage,
    setSettingsPage,
    workspaceSettingsName,
    setWorkspaceSettingsName,
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
    rightPanelWidth,
    rightPanelResizing,
    rightPanelContainerRef,
    startRightPanelResize,
    resetRightPanelWidth,
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
    ensureHomeTab,
    openSessionTab,
    openNewSessionTab,
    closeTab,
    handleSelectTab,
    handleSessionRemoved,
    activateTab,
    navigateUrl,

    loadWorkspaces,
    applyUrlToTabs,
    initialNavDoneRef,
    handleSelectSession,
    handleOpenConversation,
    handleOpenWorkspace,

    handleShowOverview,
    handleWorkspaceNewSession,
    handleReturnHome,

    handleCreateWorkspace,
    handleImportDirectory,
    handleWorkspaceDeleted,
    handleOpenSessionFromHome,
    homeNewSession,
    homeSession,
    homeFileTabs,
    homeActiveFileTabId,
    homeRightPanelOpen,
    setHomeRightPanelOpen,
    setHomeActiveFileTabId,
    handleCloseHomeFileTab,
    handleHomeNewSession,
    handleHomeNewSessionSelect,
    handleExitHomeNewSession,
    handleHomeSessionCreated,
    handleCreateWorkItem,
    hydrateSelectedSession,
    handleSessionCreated,
    handleOpenWorkItemConversation,
    handleRunLoopRound,
    handleRunLoopDirect,
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
