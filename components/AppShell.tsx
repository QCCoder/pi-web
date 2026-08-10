"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { ArchiveModal } from "./ArchiveModal";
import { PluginsConfig } from "./PluginsConfig";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { WorkspaceManager } from "./WorkspaceManager";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { LoopConfig } from "./LoopConfig";
import { LoopLaunchingPlaceholder, LoopStatusBar } from "./LoopLaunchOverlay";
import { HomeLanding } from "./HomeLanding";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import { DirectoryPicker } from "./DirectoryPicker";
import { BranchNavigator } from "./BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSessionActivity } from "@/hooks/useSessionActivity";
import { useGlobalAgentEvents } from "@/hooks/useGlobalAgentEvents";
import { copyText } from "@/lib/clipboard";
import { clearDraft, getDraft } from "@/lib/draft-store";
import { getFileName } from "@/lib/file-paths";
import { buildFileLineMentionText } from "@/lib/file-fuzzy";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { WorkItemDetail, WorkItemRecord } from "@/lib/work-items/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { LoopDefinition, LoopRun } from "@/lib/loop/types";

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

type WorkspaceView = "overview" | "settings" | "work-items" | "loops" | "chat";

/**
 * One open workspace tab. All per-tab view state (selected session, file tabs,
 * panel state …) lives here, so switching tabs is just changing `activeTabId` —
 * there is no snapshot capture/restore. The URL is a write-only projection of
 * the active tab; popstate (back/forward) and the initial mount are the only
 * places the URL drives state.
 */
interface WorkspaceTabState {
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
const TOP_BAR_ICON_BUTTON_SIZE = 36;
const LANGUAGE_MENU_WIDTH = 176;

export function AppShell() {
  const { isDark, toggleTheme } = useTheme();
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
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
  const [refreshKey, setRefreshKey] = useState(0);
  const sessionActivity = useSessionActivity(selectedSession?.id ?? null, refreshKey);
  // 全局 SSE：为每个 running session 维护一条事件流，后台 session 事件不丢（决策 8 / B4b）。
  useGlobalAgentEvents(sessionActivity.runningIds);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pluginsConfigOpen, setPluginsConfigOpen] = useState(false);
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
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
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
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "language" && !isMobile && languageBtnRef.current) {
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
  }, [activeTopPanel, isMobile]);

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
      const hasOverview = workspace.capabilities.includes("overview");
      const tab: WorkspaceTabState = {
        id: workspace.id,
        workspace,
        view: hasOverview ? "overview" : "chat",
        session: null,
        newSessionCwd: hasOverview ? null : workspace.path,
        workItemKey: null,
        fileTabs: [],
        activeFileTabId: null,
        rightPanelOpen: false,
      };
      return [...prev, tab];
    });
    return workspace.id;
  }, []);

  // Make a tab active (or go home with null). Closes modals and clears the
  // per-session UI that ChatWindow will re-populate for the new session.
  const activateTab = useCallback((id: string | null) => {
    setWorkspaceManagerOpen(false);
    setModelsConfigOpen(false);
    setSkillsConfigOpen(false);
    setPluginsConfigOpen(false);
    setArchiveOpen(false);
    setProjectTrustDialogOpen(false);
    setActiveTopPanel(null);
    if (id) setMruIds((ids) => [id, ...ids.filter((x) => x !== id)]);
    setActiveTabId(id);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

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
    const parts = [`workspace=${encodeURIComponent(tab.id)}`, `view=${tab.view}`];
    if (tab.view === "chat" && tab.session) parts.push(`session=${encodeURIComponent(tab.session.id)}`);
    if (tab.view === "work-items" && tab.workItemKey) parts.push(`item=${encodeURIComponent(tab.workItemKey)}`);
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

    let view: WorkspaceView = rawView && (["overview", "settings", "work-items", "loops", "chat"] as const).includes(rawView as WorkspaceView)
      ? rawView as WorkspaceView
      : (workspace.capabilities.includes("overview") ? "overview" : "chat");
    if (view === "loops" && !workspace.capabilities.includes("loop")) {
      view = workspace.capabilities.includes("overview") ? "overview" : "chat";
    }
    ensureTab(workspace);
    updateTab(workspaceId, {
      view,
      session,
      newSessionCwd: view === "chat" && !session ? workspace.path : null,
      workItemKey: view === "work-items" ? itemKey : null,
    });
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
          const view = t.view === "loops" && !fresh.capabilities.includes("loop")
            ? (fresh.capabilities.includes("overview") ? "overview" : "chat")
            : t.view;
          return { ...t, workspace: fresh, view };
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
    updateTab(activeTabId, { session, newSessionCwd: null, view: "chat" });
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile) setSidebarOpen(false);
    navigateUrl(`workspace=${encodeURIComponent(activeTabId)}&view=chat&session=${encodeURIComponent(session.id)}`);
  }, [activeTabId, updateTab, navigateUrl, isMobile]);

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

  // ---- Loop 乐观启动 -----------------------------------------------------------
  // 点击“运行一轮”时立即把当前 tab 切到 chat 并显示启动占位，不等 Loop Host 把
  // 编排会话创建好（那要起 AgentSession + 加载 skills，好几秒）。这里轮询 run，
  // sessionId 一出现就接上实时流；run 状态/plan/gate 也由这里维护，状态条挂在
  // chat 顶部，L2 的人工确认不用切回 Loops 视图。
  const [loopRun, setLoopRun] = useState<LoopRun | null>(null);
  const activeLoopPending = activeTab?.loopPending ?? null;

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
    navigateUrl(`workspace=${encodeURIComponent(workspaceId)}&view=chat`);
    // 后台触发；runId 一返回就写进 loopPending，轮询 effect 随即接管。
    void (async () => {
      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/loop/loops/${encodeURIComponent(loop.id)}/trigger`, { method: "POST" });
        if (!res.ok) throw new Error(`触发失败 (HTTP ${res.status})`);
        const receipt = await res.json() as { runId: string };
        updateTab(workspaceId, (tab) => (tab.loopPending ? { loopPending: { ...tab.loopPending, runId: receipt.runId } } : {}));
      } catch (error) {
        setLoopRun((cur) => (cur ? { ...cur, status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() } : cur));
        updateTab(workspaceId, { loopPending: undefined });
      }
    })();
  }, [activeTabId, updateTab, navigateUrl]);

  const handleLoopGate = useCallback(async (decision: "approve" | "reject") => {
    const run = loopRun;
    if (!run) return;
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(run.workspaceId)}/loop/runs/${encodeURIComponent(run.id)}/gate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
      });
      const value = await res.json() as { run: LoopRun };
      setLoopRun(value.run);
    } catch { /* 下一次轮询会修正状态 */ }
  }, [loopRun]);

  useEffect(() => {
    if (!activeLoopPending) { setLoopRun(null); return; }
    const runId = activeLoopPending.runId;
    const workspaceId = activeLoopPending.workspaceId;
    if (!runId) return; // trigger POST 还没返回 runId，暂不轮询；runId 写入后本 effect 重跑
    const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/loop`;
    const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) { if (!stopped) setTimeout(poll, 2000); return; }
        const { run } = await res.json() as { run: LoopRun };
        if (stopped) return;
        setLoopRun(run);
        // 编排会话一存在就接上实时流。
        if (run.sessionId && selectedSession?.id !== run.sessionId) {
          handleOpenLoopSession(run.sessionId);
        }
        if (TERMINAL.has(run.status)) {
          // 保留终态状态供查看；清掉 pending 让轮询停止。
          updateTab(workspaceId, { loopPending: undefined });
        } else {
          setTimeout(poll, 1000);
        }
      } catch {
        if (!stopped) setTimeout(poll, 2000);
      }
    };
    const timer = setTimeout(poll, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeLoopPending, selectedSession, handleOpenLoopSession, updateTab]);

  const handleOpenWorkspace = useCallback((workspace: WorkspaceSummary) => {
    const id = ensureTab(workspace);
    activateTab(id);
    // Project the (possibly already-open) tab to the URL. `tabs` may not yet
    // reflect a brand-new tab, so fall back to the workspace's default view.
    const existing = tabs.find((t) => t.id === id);
    navigateUrl(existing ? buildTabQuery(existing) : `workspace=${encodeURIComponent(id)}&view=${workspace.capabilities.includes("overview") ? "overview" : "chat"}`);
  }, [ensureTab, activateTab, tabs, buildTabQuery, navigateUrl]);

  const handleWorkspaceNewSession = useCallback(() => {
    if (!activeTabId) return;
    updateTab(activeTabId, { view: "chat", session: null, newSessionCwd: activeWorkspace?.path ?? null });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    if (isMobile) setSidebarOpen(false);
    navigateUrl(`workspace=${encodeURIComponent(activeTabId)}&view=chat`);
  }, [activeTabId, activeWorkspace, updateTab, navigateUrl, isMobile]);

  const handleReturnHome = useCallback(() => {
    activateTab(null);
    navigateUrl("tab=home");
  }, [activateTab, navigateUrl]);

  const navigateWorkspaceView = useCallback((view: WorkspaceView, itemKey?: string | null) => {
    if (!activeTabId) return;
    updateTab(activeTabId, {
      view,
      ...(view === "work-items" ? { workItemKey: itemKey ?? null } : {}),
    });
    let query = `workspace=${encodeURIComponent(activeTabId)}&view=${view}`;
    if (view === "work-items" && itemKey) query += `&item=${encodeURIComponent(itemKey)}`;
    navigateUrl(query);
  }, [activeTabId, updateTab, navigateUrl]);

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
    navigateUrl(`workspace=${encodeURIComponent(owner.id)}&view=chat&session=${encodeURIComponent(session.id)}`);
  }, [workspaces, ensureTab, updateTab, activateTab, navigateUrl]);

  const handleCreateWorkItem = useCallback((type: "requirement" | "bug") => {
    navigateWorkspaceView("work-items");
    setCreateWorkItemRequest({ type, id: Date.now() });
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, navigateWorkspaceView]);

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
    const primaryConversationId = item.conversations[0];
    if (primaryConversationId) {
      try {
        const response = await fetch("/api/sessions");
        if (response.ok) {
          const data = await response.json() as { sessions: SessionInfo[] };
          const existing = data.sessions.find((session) => session.id === primaryConversationId);
          if (existing) {
            ensureTab(workspace);
            updateTab(workspace.id, { view: "chat", session: existing, newSessionCwd: null });
            activateTab(workspace.id);
            setSessionKey((k) => k + 1);
            setSystemPrompt(null);
            navigateUrl(`workspace=${encodeURIComponent(workspace.id)}&view=chat&session=${encodeURIComponent(existing.id)}`);
            return;
          }
        }
      } catch {
        // A missing local Conversation falls through to a new Workspace session.
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
  }, [ensureTab, updateTab, activateTab, navigateUrl]);

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
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [activeTabId, updateTab, isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  // Open a (subagent) session in the right split pane as a closable tab, so the
  // main conversation stays put. Mirrors handleOpenFile but for sessions.
  const handleOpenSessionViewer = useCallback(async (sessionId: string) => {
    if (!activeTabId) return;
    let info: SessionInfo | undefined;
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json() as { sessions: SessionInfo[] };
        info = data.sessions.find((s) => s.id === sessionId);
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
    if (isMobile) setSidebarOpen(false);
  }, [activeTabId, updateTab, isMobile]);

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

  const sidebarContent = (
    <WorkspaceSidebar
      activeWorkspace={activeWorkspace}
      workspaces={workspaces}
      selectedSessionId={selectedSession?.id ?? null}
      selectedWorkItemKey={selectedWorkItemKey}
      runningSessionIds={sessionActivity.runningIds}
      completedSessionIds={sessionActivity.completedIds}
      allSessions={sessionActivity.sessions}
      refreshKey={refreshKey}
      explorerRefreshKey={explorerRefreshKey}
      onSelectWorkspace={handleOpenWorkspace}
      onCreateWorkspace={handleCreateWorkspace}
      onImportDirectory={() => setImportPickerOpen(true)}
      onOpenWorkspaceSettings={() => {
        setOpenRepositoryFormRequest(undefined);
        navigateWorkspaceView("settings");
      }}
      onOpenLoops={() => {
        navigateWorkspaceView("loops");
        if (isMobile) setSidebarOpen(false);
      }}
      loopsActive={workspaceView === "loops"}
      onAddRepository={() => {
        navigateWorkspaceView("settings");
        setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
        if (isMobile) setSidebarOpen(false);
      }}
      onNewSession={handleWorkspaceNewSession}
      onSelectSession={handleSelectSession}
      onSelectWorkItem={(item) => {
        navigateWorkspaceView("work-items", item.key);
        if (isMobile) setSidebarOpen(false);
      }}
      onCreateWorkItem={handleCreateWorkItem}
      onOpenFile={handleOpenFile}
      onOpenModels={() => setModelsConfigOpen(true)}
      onOpenSkills={() => setSkillsConfigOpen(true)}
      onOpenPlugins={() => setPluginsConfigOpen(true)}
      onOpenArchive={() => setArchiveOpen(true)}
      onSessionRemoved={(id) => {
        updateActiveTab((tab) => (tab.session?.id === id ? { session: null } : {}));
        setRefreshKey((k) => k + 1);
      }}
    />
  );
  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        }}
      >
        {sidebarContent}
      </div>

      {/* Center: chat */}
      <div className="app-shell-center" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>
          <button
            onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
             title={isDark ? translate("theme.light") : translate("theme.dark")}
             aria-label={isDark ? translate("theme.light") : translate("theme.dark")}
            aria-pressed={isDark}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
           </button>
           <button
             ref={languageBtnRef}
             type="button"
             onClick={() => toggleTopPanel("language")}
             title={translate("common.language")}
             aria-label={translate("common.language")}
             aria-haspopup="menu"
             aria-expanded={activeTopPanel === "language"}
             aria-pressed={activeTopPanel === "language"}
             style={{
               display: "flex", alignItems: "center", justifyContent: "center",
               width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
               background: activeTopPanel === "language" ? "var(--bg-selected)" : "none",
               border: "none", borderRight: "1px solid var(--border)",
               color: activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)",
               cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
             }}
             onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
             onMouseLeave={(e) => {
               e.currentTarget.style.color = activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)";
             }}
           >
             <svg
               width="16"
               height="16"
               viewBox="0 0 24 24"
               fill="none"
               stroke="currentColor"
               strokeWidth="1.8"
               strokeLinecap="round"
               strokeLinejoin="round"
               aria-hidden="true"
             >
               <path d="m5 8 6 6" />
               <path d="m4 14 6-6 2-3" />
               <path d="M2 5h12" />
               <path d="M7 2h1" />
               <path d="m22 22-5-10-5 10" />
               <path d="M14 18h6" />
             </svg>
           </button>
          {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
            <button
              type="button"
              onClick={() => {
                setProjectTrustError(null);
                setProjectTrustDialogOpen(true);
              }}
              title={translate("trust.resourcesNotLoaded")}
              aria-label={translate("trust.resourcesNotLoaded")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: "100%",
                padding: isMobile ? "0 10px" : "0 12px",
                background: "none",
                border: "none",
                borderRight: "1px solid var(--border)",
                color: "#d97706",
                cursor: "pointer",
                flexShrink: 0,
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              {!isMobile && <span>{translate("trust.resourcesNotLoaded")}</span>}
            </button>
          )}
          {showChat && (
            <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              <button
                onClick={handleViewFullHistory}
                disabled={!selectedSession}
                 title={selectedSession ? translate("history.full") : translate("history.unsaved")}
                 aria-label={translate("history.full")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  height: "100%",
                  padding: "0 12px",
                  background: "none",
                  border: "none",
                  borderTop: "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: selectedSession ? "pointer" : "not-allowed",
                  opacity: selectedSession ? 1 : 0.45,
                  flexShrink: 0,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  transition: "color 0.1s, background 0.1s, opacity 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!selectedSession) return;
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
                 {!isMobile && <span>{translate("history.label")}</span>}
              </button>
              {(() => {
                const hasMessages = Boolean(
                  selectedSession
                  && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
                );
                const disabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
                const isSuccess = autoNameStatus.kind === "success";
                const isError = autoNameStatus.kind === "error";
                const label = autoNameStatus.kind === "naming"
                   ? translate("title.generating")
                    : isSuccess
                    ? translate("title.updated")
                    : isError
                      ? translate("title.failed")
                      : translate("title.generate");
                const title = !selectedSession
                   ? translate("title.unsaved")
                   : !hasMessages
                     ? translate("title.noMessages")
                     : isError
                       ? autoNameStatus.message
                       : translate("title.generateSession");

                return (
                  <button
                    type="button"
                    onClick={() => void handleAutoName()}
                    disabled={disabled}
                    title={title}
                    aria-label={label}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      height: "100%", padding: "0 12px",
                      background: "none", border: "none",
                      borderTop: "2px solid transparent",
                      borderRight: "1px solid var(--border)",
                      color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                      flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                      transition: "color 0.1s, background 0.1s, opacity 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (disabled) return;
                      e.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                      e.currentTarget.style.background = "none";
                    }}
                  >
                    {autoNameStatus.kind === "naming" ? (
                      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isSuccess ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m15 4 5 5L7 22l-5-5Z" />
                        <path d="m14 5 5 5" />
                        <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                      </svg>
                    )}
                    {!isMobile && <span>{label}</span>}
                  </button>
                );
              })()}
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                compact={isMobile}
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <button
                ref={systemBtnRef}
                onClick={() => toggleTopPanel("system")}
                 title={translate("system.prompt")}
                 aria-label={translate("system.prompt")}
                aria-pressed={activeTopPanel === "system"}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                 {!isMobile && <span>{translate("system.label")}</span>}
              </button>
            </div>
          )}
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
             const tokens = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
             if (tokens) {
               tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
               tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
               tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
               tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => toggleTopPanel("session")}
               title={tooltip || translate("session.title")}
                 aria-label={translate("session.title")}
                aria-pressed={activeTopPanel === "session"}
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: rightPanelOpen ? 12 : 48,
                  height: "100%",
                  background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
              >
                {isMobile && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                )}
                 {!isMobile && tokens && tokens.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                     {fmt(tokens.input)}
                  </span>
                )}
                 {!isMobile && tokens && tokens.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                     {fmt(tokens.output)}
                  </span>
                )}
                 {!isMobile && tokens && tokens.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                     {fmt(tokens.cacheRead)}
                  </span>
                )}
                {!isMobile && costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "language" && (
                <div
                  role="menu"
                  aria-label={translate("common.language")}
                  style={{
                    background: "var(--bg-panel)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      style={{
                        display: "flex", alignItems: "center",
                        width: "100%", height: 34, padding: "0 10px",
                        border: "none", borderRadius: 4,
                        background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span>{plugin.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.empty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.load")}
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                           title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        <WorkspaceTabBar
          workspaces={workspaces}
          tabIds={tabs.map((t) => t.id)}
          activeWorkspaceId={activeWorkspace?.id ?? null}
          activityByWorkspaceId={workspaceActivity}
          onSelectHome={handleReturnHome}
          onSelectWorkspace={handleOpenWorkspace}
          onCloseWorkspace={handleCloseWorkspaceTab}
          onReorder={(ids: string[]) => setTabs((prev) => ids.map((id) => prev.find((t) => t.id === id)).filter((t): t is WorkspaceTabState => Boolean(t)))}
        />

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {activeWorkspace && workspaceView === "overview" ? (
            <WorkspaceOverview
              workspace={activeWorkspace}
              onNewSession={handleWorkspaceNewSession}
              onOpenSettings={() => {
                setOpenRepositoryFormRequest(undefined);
                navigateWorkspaceView("settings");
              }}
              onOpenWorkItems={() => navigateWorkspaceView("work-items")}
              onCreateWorkItem={handleCreateWorkItem}
              onSelectSession={handleSelectSession}
              onSessionDeleted={(id) => {
                setRefreshKey((key) => key + 1);
                updateActiveTab((tab) => (tab.session?.id === id ? { session: null } : {}));
              }}
            />
          ) : activeWorkspace
            && workspaceView === "loops" ? (
            <div style={{ height: "100%", overflowY: "auto", padding: 20 }}>
              <LoopConfig workspace={activeWorkspace} onWorkspaceChanged={() => void loadWorkspaces()} onTriggered={handleLoopTriggered} onOpenSession={handleOpenLoopSession} />
            </div>
          ) : activeWorkspace
            && (workspaceView === "settings" || workspaceView === "work-items") ? (
            <WorkspaceManager
              open
              embedded
              initialSection={workspaceView === "settings" ? "workspaces" : "work-items"}
              activeWorkspacePath={activeWorkspace.path}
              initialWorkItemKey={selectedWorkItemKey}
              createWorkItemRequest={createWorkItemRequest}
              openRepositoryFormRequest={openRepositoryFormRequest}
              onClose={() => navigateWorkspaceView("overview")}
              onOpenWorkspace={handleOpenWorkspace}
              onOpenWorkItemConversation={handleOpenWorkItemConversation}
              onWorkspaceDeleted={handleWorkspaceDeleted}
              onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
              onWorkspaceChanged={() => void loadWorkspaces()}
              onOpenLoops={() => navigateWorkspaceView("loops")}
            />
          ) : !activeWorkspace && workspaceManagerOpen ? (
            <WorkspaceManager
              open
              embedded
              initialSection="workspaces"
              activeWorkspacePath={null}
              createWorkspaceOnOpen
              onClose={() => setWorkspaceManagerOpen(false)}
              onOpenWorkspace={handleOpenWorkspace}
              onOpenWorkItemConversation={handleOpenWorkItemConversation}
              onWorkspaceDeleted={handleWorkspaceDeleted}
              onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
            />
          ) : showChat ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              {loopRun && <LoopStatusBar run={loopRun} onDecide={handleLoopGate} onClose={() => setLoopRun(null)} />}
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {activeTab?.loopPending && !selectedSession ? (
                  <LoopLaunchingPlaceholder name={activeTab.loopPending.loopName} status={loopRun?.status} error={loopRun?.error} />
                ) : (
                  <ChatWindow
                    reloadSignal={sessionKey}
                    session={selectedSession}
                    newSessionCwd={effectiveNewSessionCwd}
                    onAgentEnd={handleAgentEnd}
                    onSessionCreated={handleSessionCreated}
                    onSessionForked={handleSessionForked}
                    modelsRefreshKey={modelsRefreshKey}
                    chatInputRef={chatInputRef}
                    onBranchDataChange={handleBranchDataChange}
                    onSystemPromptChange={handleSystemPromptChange}
                    onSessionStatsChange={handleSessionStatsChange}
                    onSessionStatsPanelOpen={openSessionStatsPanel}
                    onContextUsageChange={handleContextUsageChange}
                    onOpenFile={handleOpenLinkedFile}
                    onOpenSession={handleOpenSessionViewer}
                  />
                )}
              </div>
            </div>
          ) : !activeWorkspace ? (
            <HomeLanding
              workspaces={workspaces}
              refreshKey={refreshKey}
              onSelectWorkspace={handleOpenWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              onImportDirectory={() => setImportPickerOpen(true)}
              onSelectSession={handleOpenSessionFromHome}
            />
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        {/* Right panel tab bar */}
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={(id: string) => updateActiveTab({ activeFileTabId: id })}
              onCloseTab={handleCloseFileTab}
            />
          </div>

        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {activeFileTab?.kind === "file" ? (
            <FileViewer
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId },
              )}
            />
          ) : activeFileTab?.kind === "session" ? (
            <ChatWindow
              key={activeFileTab.sessionId}
              session={activeFileTab.sessionInfo}
              newSessionCwd={null}
              embedded
              onOpenFile={handleOpenLinkedFile}
              onOpenSession={handleOpenSessionViewer}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          )}
        </div>
      </div>
    </div>
    {/* File panel toggle — workspace-scoped; the home tab has no file context. */}
    {activeWorkspace && <button
      onClick={() => updateActiveTab((tab) => ({ rightPanelOpen: !tab.rightPanelOpen }))}
       title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
       aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
      style={{
        position: "fixed", top: 0, right: 0, zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>}
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {importPickerOpen && (
      <DirectoryPicker
        onCancel={() => setImportPickerOpen(false)}
        onSelect={(path) => void handleImportDirectory(path)}
        busy={importBusy}
        error={importError}
      />
    )}
    {archiveOpen && activeWorkspace && (
      <ArchiveModal
        workspaceId={activeWorkspace.id}
        workspacePath={activeWorkspace.path}
        onClose={() => setArchiveOpen(false)}
        onChanged={() => setRefreshKey((k) => k + 1)}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    {skillsConfigOpen && settingsCwd && (
      <SkillsConfig
        cwd={settingsCwd}
        globalOnly={!activeWorkspace}
        workspace={activeWorkspace}
        onWorkspaceSkillsChange={(updated) => {
          setWorkspaces((current) =>
            current.map((w) => (w.id === updated.id ? updated : w)),
          );
        }}
        onClose={() => setSkillsConfigOpen(false)}
      />
    )}
    {pluginsConfigOpen && settingsCwd && (
      <PluginsConfig
        cwd={settingsCwd}
        sessionId={selectedSession?.id ?? null}
        onClose={() => setPluginsConfigOpen(false)}
        onReloaded={() => setSessionKey((k) => k + 1)}
      />
    )}
    </>
  );
}
