"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar } from "../TabBar";
import { FilesExplorerPanel } from "../FilesExplorerPanel";
import { TerminalPanel } from "../TerminalPanel";
import { ArchiveModal } from "../ArchiveModal";
import { WorkspaceManager } from "../WorkspaceManager";
import { WorkspaceOverview } from "../WorkspaceOverview";
import { ProjectSidebar } from "../ProjectSidebar";
import { WorkspaceSwitcherPanel } from "../WorkspaceSwitcherPanel";
import { PanelHeader } from "../PanelHeader";
import { ConfigCenterPage } from "../ConfigCenterPage";
import { LoopsDockPanel } from "../LoopsDockPanel";
import { WorkItemsPage } from "../work-items/WorkItemsPage";
import { HomeLanding } from "../HomeLanding";
import { HomeNewSession } from "../HomeNewSession";
import { WorkspaceSelector } from "../WorkspaceSelector";
import { defaultHomeNewSessionWorkspaceId, workspaceForSession } from "@/lib/home-quick-switch";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";
import { LOOPS_TAB_ID, KNOWLEDGE_TAB_ID, WORK_ITEMS_TAB_ID, TERMINALS_TAB_ID, FILES_TAB_ID, isModuleTabId, type ModuleTabId } from "@/lib/tab-types";
import { SessionTabBar } from "../SessionTabBar";
import { KnowledgeBrowser } from "../KnowledgeBrowser";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { SessionInfo } from "@/lib/types";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "@/lib/terminal-tab-state";
import { useShell } from "./context";
import type { SessionTabState } from "@/lib/session-tabs";
import { createNewSessionTab, tabQuery } from "@/lib/session-tabs";
import { ChatToolbar } from "./ChatToolbar";

/** 右坞模块 tab 的标签与图标（工作区工具行 + dock tab 条共用）。 */
const DOCK_MODULE_META: Record<ModuleTabId, { label: string; icon: React.ReactNode }> = {
  [FILES_TAB_ID]: {
    label: "文件",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  [LOOPS_TAB_ID]: {
    label: "Loops",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </svg>
    ),
  },
  [KNOWLEDGE_TAB_ID]: {
    label: "知识库",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
  },
  [WORK_ITEMS_TAB_ID]: {
    label: "工作项",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  [TERMINALS_TAB_ID]: {
    label: "终端",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
};

/**
 * The desktop shell（2026-09 ZCode 风格导航改版）：左侧单一项目树侧栏
 * （ProjectSidebar：顶部 新建任务⌘N/搜索⌘K/插件&技能 导航行 + 项目→会话树 +
 * 组尾归档 + 底部 设置·模型·Agents 三入口）+ 中央区（ChatToolbar +
 * SessionTabBar + 工作区工具行 + 总览|聊天|配置整页）+ 右坞（2026-10 rail
 * 改版：44px 常驻图标列 文件/Loops/工作项/知识库/终端 + 展开面板；点未激活
 * 图标 = 切模块并展开，点已激活图标 = 收起到只剩 rail；激活模块 + 展开态
 * per-workspace 持久化。文件 tab 住「文件」模块面板内横条，终端 tab 住
 * 「终端」模块面板内横条；配置整页/无工作区上下文时整个右坞隐藏。
 * 图标栏与「中栏面板」已退役——原 configView 三列 split（列表中栏
 * + 详情 portal 右栏）由中央区整页（CenterPage）取代。2026-09 配置页拆分：
 * 设置/模型/插件&技能/Agents 是四个独立整页（ConfigCenterPage，各有页头与
 * 页内作用域索引列），不再是同一设置页换预选分区。所有状态来自共享 shell
 * context；本组件只拥有中央区页面的渲染分派。
 */
export function DesktopShell() {
  const s = useShell();
  const { t: translate } = useI18n();

  const {
    tabs,
    setTabs,
    activeTabId,
    activeTab,
    activeWorkspace,
    selectedSession,
    fileTabs,
    activeFileTabId,
    activeCwd,
    centerPage,
    setCenterPage,
    openCenterPage,
    openWorkItemsPage,
    workItemsItemKeyRef,
    navigateUrl,
    loopFilesReveal,
    settingsPage,
    setSettingsPage,
    settingsCwd,
    sidebarOpen,
    sidebarWidth,
    sidebarResizing,
    sidebarContainerRef,
    startSidebarResize,
    resetSidebarWidth,
    rightPanelWidth,
    rightPanelResizing,
    rightPanelContainerRef,
    startRightPanelResize,
    resetRightPanelWidth,
    workspaces,
    setWorkspaces,
    navReady,
    workspaceSettingsName,
    workspaceActivity,
    setModelsRefreshKey,
    setSessionKey,
    homeNewSession,
    homeSession,
    mruIds,
    workspacesLoaded,
    homeFileTabs,
    homeActiveFileTabId,
    setHomeActiveFileTabId,
    handleCloseHomeFileTab,
    handleHomeNewSessionSelect,
    handleHomeSessionCreated,
    handleCreateWorkItem,
    openSessionStatsPanel,
    dockRailFor,
    openDockModule,
    setDockExpanded,
    handleShowOverview,
    handleFileLineMention,
    setOpenRepositoryFormRequest,
    handleReorderWorkspaces,
    explorerRefreshKey,
    createWorkItemRequest,
    openRepositoryFormRequest,
    workspaceSettingsRequest,
    requestWorkspaceSettings,
    clearWorkspaceSettingsRequest,
    sessionActivity,
    modelsRefreshKey,
    sessionKey,
    effectiveNewSessionCwd,
    showChat,
    showPlaceholder,
    activeFileTab,
    handleWorkspaceSettingsSelection,
    handleOpenWorkspace,
    closeTab,
    closeTabs,
    openSessionTab,
    handleSelectTab,
    handleSessionRemoved,
    handleCreateWorkspace,
    handleReturnHome,
    handleOpenConversation,
    handleWorkspaceNewSession,
    handleTabBarNewSession,
    handleSelectSession,
    handleOpenWorkItemConversation,
    handleRunLoopRound,
    handleRunLoopDirect,
    handleRunContract,
    handleWorkspaceDeleted,
    handleOpenFile,
    handleOpenLinkedFile,
    handleOpenSessionViewer,
    handleCloseFileTab,
    handleSessionCreated,
    handleSessionForked,
    handleAgentEnd,
    handleBranchDataChange,
    handleSystemPromptChange,
    handleSessionStatsChange,
    handleContextUsageChange,
    chatInputRef,
    updateActiveTab,
    setRefreshKey,
    refreshKey,
    setImportPickerOpen,
  } = s;

  // Loop 配置变更 → 总览 Loops 区块刷新信号（创建/删除/frontmatter 保存后 bump）。
  const [loopsRefreshKey, setLoopsRefreshKey] = useState(0);

  // 工作区切换面板（32px 工具行「工作区名 ▾」）开合；点选工作区/模块/外部即关。
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // ---- 会话全文搜索深跳转（上游 1cbd96f）------------------------------------
  // searchTarget 归 DesktopShell 自有（不进 useAppShellState）：搜索结果行选择
  // 会话时先记下 entryId/blockIndex，再走常规 handleSelectSession 打开会话；
  // 中央 ChatWindow 定位完成后经 handleSearchTargetHandled 注销（按 target 身份
  // 比较，避免误清后来的新目标）。
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSelectSearchHit = useCallback((session: SessionInfo, entryId?: string, blockIndex?: number) => {
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    handleSelectSession(session);
  }, [handleSelectSession]);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => current === target ? null : current);
  }, []);

  // 首页上下文（无活动工作区 tab）：composer 选区 / 首页会话归属 → 决定
  // 首页主区新建会话页与右栏文件区的上下文工作区。
  const homeAtDesktop = !activeWorkspace;
  const homeComposerWorkspaceId = homeNewSession.workspaceId
    ?? defaultHomeNewSessionWorkspaceId(workspaces, sessionActivity.sessions, mruIds);
  const homeContextWorkspace = homeSession
    ? workspaceForSession(homeSession, workspaces) ?? undefined
    : workspaces.find((w) => w.id === homeComposerWorkspaceId && w.available);
  // 右栏在首页用独立状态（无 tab 可挂）；面板/文件 tab 依上下文取源。
  const panelWorkspace = activeWorkspace ?? homeContextWorkspace ?? null;
  const panelFileTabs = homeAtDesktop ? homeFileTabs : fileTabs;
  const panelActiveFileTabId = homeAtDesktop ? homeActiveFileTabId : activeFileTabId;
  const panelActiveFileTab = homeAtDesktop
    ? (homeActiveFileTabId ? homeFileTabs.find((t) => t.id === homeActiveFileTabId) : undefined)
    : activeFileTab;

  // ---- 首页退役（2026-09 用户反馈，桌面同步移动端）--------------------------
  // 空态（冷启动无恢复 tab / 关光 tab / 旧 tab=home 深链 / 侧栏「新建任务」在
  // 无工作区时回首页）自动落回当前（MRU/最近会话所属）工作区的家 tab——桌面
  // 家 tab = 总览，即事实首页。URL 用 replace 写入，不给历史埋 tab=home 陷阱。
  // 没有任何可用工作区时不动：HomeNewSession 首页页接手（创建/选工作区引导）。
  useEffect(() => {
    if (!navReady || activeTabId !== null) return;
    // 中央区整页（配置/归档/工作项管理）打开时不做空态自动落 home——整页占
    // 着中央区，深链直达（如 ?page=work-items）不应被家 tab 接管清掉。
    if (centerPage) return;
    if (s.homeSession || s.homeNewSession.open) return;
    const targetId = defaultHomeNewSessionWorkspaceId(workspaces, s.sessionActivity.sessions, s.mruIds);
    const target = targetId ? workspaces.find((w) => w.id === targetId) : undefined;
    if (!target || !isWorkspaceSelectable(target)) return;
    handleOpenWorkspace(target, { replace: true });
  }, [navReady, activeTabId, centerPage, s.homeSession, s.homeNewSession.open, workspaces, s.sessionActivity.sessions, s.mruIds, handleOpenWorkspace]);

  /** 关掉最后一个 tab ≠ 落首页空态：先关（草稿确认取消时 closeTab 返回 false，
   *  不动），紧接着开/激活该工作区的家 tab 接住——同一事件内批处理，不闪首页页。
   *  关的就是家 tab 时 = 重新激活（家 tab 即首页，不可关）。 */
  const desktopCloseTab = useCallback((id: string) => {
    const closing = tabs.find((t) => t.id === id) ?? null;
    const closed = closeTab(id);
    if (closed && closing && tabs.length === 1) {
      handleOpenWorkspace(closing.workspace, { replace: true });
    }
  }, [tabs, closeTab, handleOpenWorkspace]);

  // ＋（新占位 tab）默认渲染首页内容（HomeLanding，2026-09 用户反馈「都要变」）；
  // 点大输入卡才在本 tab 内展开真正的 composer。显式「新建会话」（侧栏新建任务/
  // 总览按钮）绕过首页直落 composer：调用前置 explicitComposeRef，activeTab
  // 变成新占位后由 effect 补写 composerTabId。
  const [composerTabId, setComposerTabId] = useState<string | null>(null);
  const explicitComposeRef = useRef(false);
  const newSessionDirect = useCallback(() => {
    if (!activeWorkspace) return;
    explicitComposeRef.current = true;
    handleWorkspaceNewSession();
  }, [activeWorkspace, handleWorkspaceNewSession]);
  useEffect(() => {
    if (!explicitComposeRef.current) return;
    if (activeTab?.kind === "new-session") {
      explicitComposeRef.current = false;
      setComposerTabId(activeTabId);
    }
  }, [activeTab, activeTabId]);
  // Right dock（2026-10 rail 改版，反转 2026-09-27「模块 tab 按需打开」）：
  // 右坞 = 44px 常驻图标列（文件/Loops/工作项/知识库/终端）+ 展开面板。激活
  // 模块 + 展开态在 shell 状态层（dockRailMap，per-workspace 持久化，切工作
  // 区回来恢复原样）；activeFileTabId 回归纯文件语义——FILES_TAB_ID 是「文件
  // 树」伪 tab，只住在「文件」模块面板内的横条（旧会话状态里残留的其它模块
  // id 一律按 null 处理）。模块内容跟工作区（决策 #6 沿用）：模块体常驻挂载
  // （display:none 隐藏），LoopsDockPanel 等以 key=workspace.id 重置——同工作
  // 区切会话 tab 状态存活，换工作区才重建。
  const panelWsId = panelWorkspace?.id ?? null;
  const railState = dockRailFor(panelWsId);
  const railModule = panelWsId ? railState.module : FILES_TAB_ID;
  const panelOpen = Boolean(panelWsId) && railState.expanded && !centerPage;
  const effFileTabId = isModuleTabId(panelActiveFileTabId) && panelActiveFileTabId !== FILES_TAB_ID ? null : panelActiveFileTabId;
  // ---- Workspace terminals（上游 #695 移植）--------------------------------
  // 终端 tab 由 DesktopShell 自有（不进 useAppShellState）：跨会话 tab/工程
  // 切换常驻挂载（上游语义：terminal panels stay mounted behind inactive
  // tabs, hidden panels, and session or project switches），仅 hidden 隐藏。
  // 2026-10 rail 改版：终端是 rail 第五项（独立模块），激活选中
  // （activeTerminalId）不再借道 activeFileTabId（那是「文件」模块内部的通道）。
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === activeTerminalId) ?? terminalTabs[terminalTabs.length - 1] ?? null;
  const showFilesTree = Boolean(panelWorkspace) && railModule === FILES_TAB_ID && !panelActiveFileTab;

  // rail 点击语义（共识 Q2）：点未激活图标 = 切模块并展开；点已激活且展开 =
  // 收起到只剩图标列（rail 永不消失——限有工作区上下文的形态，共识 Q6）。
  const openRailModule = useCallback((id: ModuleTabId) => {
    openDockModule(panelWsId, id);
  }, [openDockModule, panelWsId]);
  const handleRailClick = useCallback((id: ModuleTabId) => {
    if (!panelWsId) return;
    if (railModule === id && panelOpen) setDockExpanded(panelWsId, false);
    else openDockModule(panelWsId, id);
  }, [panelWsId, railModule, panelOpen, setDockExpanded, openDockModule]);

  // rail 条目（共识 Q5 门控：knowledge/work-items capability 没开则图标不
  // 渲染；Loops/终端常驻；文件只需工作区上下文）。
  const railEntries: { id: ModuleTabId; label: string; icon: React.ReactNode }[] = [
    {
      id: FILES_TAB_ID,
      label: "文件",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
    {
      id: LOOPS_TAB_ID,
      label: "Loops",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
          <path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </svg>
      ),
    },
    ...(panelWorkspace?.capabilities.includes("work-items") ? ([{
      id: WORK_ITEMS_TAB_ID,
      label: "工作项",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      ),
    }] as { id: ModuleTabId; label: string; icon: React.ReactNode }[]) : []),
    ...(panelWorkspace?.capabilities.includes("knowledge") ? ([{
      id: KNOWLEDGE_TAB_ID,
      label: "知识库",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      ),
    }] as { id: ModuleTabId; label: string; icon: React.ReactNode }[]) : []),
    {
      id: TERMINALS_TAB_ID,
      label: "终端",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
    },
  ];

  // Loops 面板的 reveal 信号 → 激活「文件」模块（FilesExplorerPanel 消费信号
  // 把分段切回「文件」；模块不可见时 reveal 无处落地）。
  const lastRevealNonceRef = useRef(0);
  useEffect(() => {
    if (!loopFilesReveal || loopFilesReveal.nonce === lastRevealNonceRef.current) return;
    lastRevealNonceRef.current = loopFilesReveal.nonce;
    openRailModule(FILES_TAB_ID);
  }, [loopFilesReveal, openRailModule]);

  // 刷新恢复：sessionStorage 里的终端身份（id+cwd）在挂载时还原；restored tab
  // 的面板会先 GET 校验服务端实例，过期/服务重启后绝不静默起新 shell（上游语义）。
  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.tabs.length > 0 && saved.activeId) setActiveTerminalId(saved.activeId);
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore-once on mount
  }, []);

  // 恢复完成后持续持久化（id+cwd+激活 tab；closing 状态不入档。open 字段仅
  // 保留格式兼容——模块/展开态由 per-workspace 的 dock-rail 持久化负责）。
  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeTerminalTab?.id ?? null,
        open: railModule === TERMINALS_TAB_ID && panelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeTerminalTab, railModule, panelOpen, terminalsRestored]);

  const handleOpenTerminal = (cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveTerminalId(tab.id);
    openRailModule(TERMINALS_TAB_ID);
  };

  // 显式终止/重启：标记 closing → TerminalPanel 等创建与在途输入落地后 DELETE →
  // onClosed 回 here。restart 换新 id 重建（新 shell），close 则移除；关闭激活
  // tab 后回落文件树（本地右栏语义：不自动收起）。
  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    if (activeTerminalId === tab.id) setActiveTerminalId(replacement?.id ?? null);
  };

  const handleTerminalRestart = (id: string) => {
    setTerminalTabs((tabs) => tabs.map((item) => item.id === id ? { ...item, closing: "restart" as const } : item));
  };

  const handleTerminalCloseError = (id: string) => {
    setTerminalTabs((tabs) => tabs.map((item) => item.id === id ? { ...item, closing: undefined } : item));
  };


  // ---- 中央区整页（CenterPage）------------------------------------------------
  // 导航入口（插件&技能 / 设置 / 模型 / Agents）各自打开独立配置整页
  // （ConfigCenterPage，2026-09 拆分——此前四入口共用一个两栏设置页只换预选
  // 分区，用户反馈「跳转的页面都一模一样」），项目树「归档」行打开归档整页。
  // 整页占中央区，tab 条保持可见——点任何会话 tab 即关闭回聊天。
  /** ✕ 关闭中央区整页：清页面 + URL 回写到活动 tab 的投影（无活动 tab →
   * 首页）——work-items 页面深链写过 URL，留着过期的 ?page=work-items 会在
   * 刷新时复活已关闭的页面（fix round 1）。与 closeTab 的 URL 回写同构
   * （push；navigateUrl 对相同 URL 去重，配置/归档页（从不写 URL）关闭时
   * 无副作用）。 */
  const closeCenterPage = useCallback(() => {
    setCenterPage(null);
    navigateUrl(activeTab ? tabQuery(activeTab) : "tab=home");
  }, [setCenterPage, activeTab, navigateUrl]);

  // work-items 深链选中项的一次性消费回调（稳定身份：WorkItemsPage 的消费
  // effect 以它为依赖）。
  const consumeWorkItemsItemKey = useCallback(() => {
    workItemsItemKeyRef.current = null;
  }, [workItemsItemKeyRef]);

  // 当前配置整页的页内分区（settingsPage 派生）：设置页 workspace/preferences、
  // 插件&技能页 plugins/skills；单分区页不消费，给个无害缺省。
  const configSection = centerPage?.kind === "plugins"
    ? (settingsPage === "skills" ? "skills" : "plugins")
    : centerPage?.kind === "settings"
      ? (settingsPage === "preferences" ? "preferences" : "workspace")
      : "workspace";

  // 树底暗淡行（已停用/不可用工作区）的「去设置」：深链预选 + 打开设置整页
  // 的工作区分区。设置页已开时不再走 openCenterPage（它是 toggle 语义，会把
  // 页面关掉），改为强制落回工作区分区接住深链预选；离开设置整页时清掉预选
  // 请求，避免重开时闪回旧选择。
  useEffect(() => {
    if (centerPage?.kind !== "settings") clearWorkspaceSettingsRequest();
  }, [centerPage, clearWorkspaceSettingsRequest]);
  const handleOpenWorkspaceSettings = useCallback((workspace: WorkspaceSummary) => {
    requestWorkspaceSettings(workspace);
    if (centerPage?.kind === "settings") setSettingsPage("workspace");
    else openCenterPage({ kind: "settings" });
  }, [centerPage, openCenterPage, requestWorkspaceSettings, setSettingsPage]);

  const renderCenterPage = () => {
    const page = centerPage;
    if (!page) return null;

    // 工作项管理整页（M2 T8，spec §6.1）：工作区作用域（页面绑定
    // workspaceId，不跟随 activeWorkspace）；聊天 chrome/右坞隐藏由外层
    // `centerPage != null` 条件统一覆盖（本 kind 不例外）。
    if (page.kind === "work-items") {
      return (
        <WorkItemsPage
          key={page.workspaceId}
          workspaceId={page.workspaceId}
          initialItemKey={workItemsItemKeyRef.current}
          onOpenConversation={handleOpenConversation}
          onOpenLoopsRecovery={() => openRailModule(LOOPS_TAB_ID)}
          onConsumedInitialItem={consumeWorkItemsItemKey}
          onClose={closeCenterPage}
          onOpenWorkItemsPage={openWorkItemsPage}
          onReplaceUrl={(query) => navigateUrl(query, true)}
          workspaces={workspaces}
        />
      );
    }

    if (page.kind !== "archive") {
      return (
        <ConfigCenterPage
          page={page}
          section={configSection}
          onSectionChange={setSettingsPage}
          workspace={activeWorkspace}
          settingsCwd={settingsCwd ?? ""}
          workspaceMeta={workspaceSettingsName}
          workspaceSlot={(
            <div style={{ flex: 1, minHeight: 0, padding: "10px 12px", display: "flex", flexDirection: "column" }}>
              {/* 工作区列表 + 单个详情并排（inline split）；「添加仓库」深链走
                  openRepositoryFormRequest → 选中项自动开表单。 */}
              <WorkspaceManager
                open
                embedded
                initialSection="workspaces"
                split={{ inline: true }}
                onSelectedWorkspaceChange={handleWorkspaceSettingsSelection}
                activeWorkspacePath={activeWorkspace?.path ?? null}
                openRepositoryFormRequest={openRepositoryFormRequest}
                selectWorkspaceRequest={workspaceSettingsRequest}
                onClose={() => {}}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenWorkItemConversation={handleOpenWorkItemConversation}
                onRunLoopRound={handleRunLoopRound}
                onRunContract={handleRunContract}
                onOpenConversation={handleOpenConversation}
                onWorkspaceDeleted={handleWorkspaceDeleted}
                onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
              />
            </div>
          )}
          onWorkspaceSkillsChange={(updated) => {
            setWorkspaces((current) =>
              current.map((w) => (w.id === updated.id ? updated : w)),
            );
          }}
          onPluginsReloaded={() => setSessionKey((k) => k + 1)}
          onModelsSaved={() => setModelsRefreshKey((k) => k + 1)}
          sessionId={selectedSession?.id ?? null}
          onClose={closeCenterPage}
        />
      );
    }

    // archive — 工作区作用域（树内组尾入口）。
    const archiveWorkspace = workspaces.find((w) => w.id === page.workspaceId) ?? null;
    if (!archiveWorkspace) {
      return (
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
          工作区不存在或已删除。
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PanelHeader title="归档" meta={archiveWorkspace.name} onClose={closeCenterPage} />
        <ArchiveModal
          embedded
          workspaceId={archiveWorkspace.id}
          workspacePath={archiveWorkspace.path}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
      </div>
    );
  };

  return (
    <>
<div style={{ display: "flex", height: "var(--app-vh)", overflow: "hidden", background: "var(--bg)", boxSizing: "border-box", paddingTop: "env(safe-area-inset-top)", paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)", "--pi-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
    {/* 左侧：项目树侧栏（2026-09 改版：单一侧栏 = 新建任务 + 项目→会话 +
        组尾归档 + 底部设置/模型/插件/Skills）。宽度沿用可拖拽/折叠机制
        （sidebar-container 类 + 拖拽把手）；折叠后左上角固定按钮展开。 */}
    <div
      ref={sidebarContainerRef}
      className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${sidebarResizing ? " sidebar-resizing" : ""}`}
      style={{
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        zIndex: 200,
      } as React.CSSProperties}
    >
        {/* work-items 不是配置导航行（工作区作用域管理页），不参与导航高亮。 */}
        <ProjectSidebar
          workspaces={workspaces}
          allSessions={sessionActivity.sessions}
          runningSessionIds={sessionActivity.runningIds}
          completedSessionIds={sessionActivity.completedIds}
          selectedSessionId={selectedSession?.id ?? homeSession?.id ?? null}
          activeWorkspace={activeWorkspace}
          activeConfigPage={centerPage && (centerPage.kind === "settings" || centerPage.kind === "models" || centerPage.kind === "agents" || centerPage.kind === "plugins") ? centerPage.kind : null}
          workspacesLoaded={workspacesLoaded}
          sessionsLoaded={sessionActivity.loaded}
          onNewSession={() => {
            if (activeWorkspace) newSessionDirect();
            else handleReturnHome();
          }}
          onOpenArchive={(workspace) => openCenterPage({ kind: "archive", workspaceId: workspace.id })}
          onSelectSession={handleSelectSession}
          onSelectSearchHit={handleSelectSearchHit}
          sessionListVersion={sessionActivity.listVersion}
          onOpenSessionInNewTab={openSessionTab}
          onSessionRemoved={handleSessionRemoved}
          onCreateWorkspace={handleCreateWorkspace}
          onImportDirectory={() => setImportPickerOpen(true)}
          onOpenCenterPage={openCenterPage}
        />
    </div>
    {/* Desktop sidebar resize handle (drag to widen/narrow; double-click resets) */}
    {sidebarOpen && (
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        title={translate("sidebar.resize")}
        onMouseDown={startSidebarResize}
        onDoubleClick={resetSidebarWidth}
      />
    )}

    {/* Center: chat */}
    <div className="app-shell-center" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
      <ChatToolbar />

      {/* 会话 tab 条只在聊天/总览视图显示；中央区整页（配置/归档）打开时隐藏
          ——整页占满中央区（ZCode 市场页/设置页同款整页心智，2026-09 用户反馈
          「点击插件和技能的时候为什么还有顶部 tab」）。tab 条隐藏后回聊天 =
          页头 ✕ / 侧栏点会话 / 再点同导航入口（toggle）。 */}
      {!centerPage && (
        <SessionTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          runningIds={sessionActivity.runningIds}
          completedIds={sessionActivity.completedIds}
          workspaceActivity={workspaceActivity}
          onSelectHome={handleReturnHome}
          showHomeTab={false}
          onSelectTab={(id: string) => {
            if (id !== activeTabId) handleSelectTab(id);
          }}
          onCloseTab={desktopCloseTab}
          onCloseTabs={closeTabs}
          onReorder={(ids: string[]) => setTabs((prev) => ids.map((id) => prev.find((t) => t.id === id)).filter((t): t is SessionTabState => Boolean(t)))}
          onNewSession={handleTabBarNewSession}
        />
      )}

      {/* 工作区工具行（2026-10 rail 改版后精简，共识 Q7）：左 = 「工作区名 ▾」
          切换器——点击展开 WorkspaceSwitcherPanel（纯工作区管理：列表[拖拽
          排序/运行徽章/新建/导入/停用行]；模块入口已随右坞 rail 常驻而移除）；
          右 = 🏠总览 高频捷径。无活动工作区（首页）或中央区整页打开时整行隐藏。 */}
      {!centerPage && activeWorkspace && (
        <div
          style={{
            height: 32, flexShrink: 0, position: "relative",
            display: "flex", alignItems: "center", gap: 4,
            paddingLeft: 10, paddingRight: 6,
            background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            onClick={() => setSwitcherOpen((open) => !open)}
            aria-label="切换工作区"
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            title="切换工作区"
            style={{
              display: "flex", alignItems: "center", gap: 5,
              height: 24, padding: "0 8px", maxWidth: 260,
              background: switcherOpen ? "var(--bg-selected)" : "none",
              border: "none", borderRadius: 4,
              color: "var(--text)", cursor: "pointer", flexShrink: 1,
              fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { if (!switcherOpen) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = switcherOpen ? "var(--bg-selected)" : "transparent"; }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeWorkspace.name}</span>
            {(() => {
              const activity = workspaceActivity[activeWorkspace.id];
              if (activity === "running") {
                return (
                  <span title="有会话正在运行" style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
                      <g>
                        <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
                        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                      </g>
                    </svg>
                  </span>
                );
              }
              if (activity === "completed") {
                return <span title="有会话已完成" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: "var(--accent)" }} />;
              }
              return null;
            })()}
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: switcherOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleShowOverview}
            title="总览"
            aria-label="总览"
            style={{
              display: "flex", alignItems: "center", gap: 4,
              height: 24, padding: "0 8px",
              background: activeTab?.kind === "workspace-home" ? "var(--bg-selected)" : "none",
              border: "none", borderRadius: 4,
              color: activeTab?.kind === "workspace-home" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, fontSize: 12, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = activeTab?.kind === "workspace-home" ? "var(--text)" : "var(--text-muted)"; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 9.5 12 3l9 6.5" /><path d="M5 8.5V21h14V8.5" />
            </svg>
            总览
          </button>
          <div style={{ flex: 1 }} />

          {/* 工作区切换面板（WorkspaceSwitcherPanel，两端共用）：行下方弹出，
              点外部关闭；桌面不再传模块入口（rail 常驻后切换器回归纯工作区
              管理，共识 Q7；移动端仍自传目的地页入口）。 */}
          {switcherOpen && (
            <>
              <div aria-hidden="true" onClick={() => setSwitcherOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1200 }} />
              <div
                role="menu"
                aria-label="工作区切换"
                style={{
                  position: "absolute", top: "calc(100% + 4px)", left: 8,
                  width: 300, zIndex: 1201,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)", borderRadius: 10,
                  boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
                  maxHeight: "calc(100dvh - 140px)", overflowY: "auto",
                }}
              >
                <WorkspaceSwitcherPanel
                  workspaces={workspaces}
                  currentWorkspaceId={activeWorkspace.id}
                  workspaceActivity={workspaceActivity}
                  onSelectWorkspace={(workspace) => {
                    setSwitcherOpen(false);
                    handleOpenWorkspace(workspace);
                  }}
                  onCreateWorkspace={handleCreateWorkspace}
                  onImportDirectory={() => setImportPickerOpen(true)}
                  onReorderWorkspaces={handleReorderWorkspaces}
                  onOpenWorkspaceSettings={handleOpenWorkspaceSettings}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Main content: 中央区整页（CenterPage：设置（含全部配置分区）/归档
          ——点任何会话 tab 即关闭）优先于 总览/聊天/首页。 */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {centerPage ? renderCenterPage() : activeTab?.kind === "workspace-home" ? (
          <WorkspaceOverview
            workspace={activeTab.workspace}
            workspaces={workspaces}
            onNewSession={newSessionDirect}
            onOpenSettings={() => {
              setOpenRepositoryFormRequest(undefined);
              // 带工作区上下文（2026-09 反馈）：深链预选 + 详情优先——只看
              // 当前工作区的设置，不再把全部工作区列表摆在面前。
              requestWorkspaceSettings(activeTab.workspace);
              openCenterPage({ kind: "settings" });
            }}
            onOpenWorkItems={() => openRailModule(WORK_ITEMS_TAB_ID)}
            onCreateWorkItem={handleCreateWorkItem}
            onSelectSession={handleSelectSession}
            onSwitchSidebarView={(view) => {
              // 仓库行 → 右坞「文件」模块；知识库行 → 右坞「知识库」模块
              // （S2 收编：hub knowledge 子视图已退役）。
              openRailModule(view === "knowledge" ? KNOWLEDGE_TAB_ID : FILES_TAB_ID);
            }}
            onAddRepository={() => {
              openCenterPage({ kind: "settings" });
              setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
            }}
            onSessionDeleted={handleSessionRemoved}
            onOpenLoopsTab={() => openRailModule(LOOPS_TAB_ID)}
            loopsRefreshKey={loopsRefreshKey}
          />
        ) : showChat ? (
          !selectedSession && activeTab?.kind === "new-session" && composerTabId !== activeTabId ? (
            /* ＋ 新占位 tab：首页内容（2026-09「都要变」，与移动端同款）——
             * 问候语/最近分组/工作区面板；点大输入卡展开 composer。 */
            <HomeLanding
          sessions={sessionActivity.sessions}
              workspaces={workspaces}
              refreshKey={refreshKey}
              onSelectWorkspace={handleOpenWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              onImportDirectory={() => setImportPickerOpen(true)}
              onSelectSession={handleSelectSession}
              onNewSession={() => setComposerTabId(activeTabId)}
              runningSessionIds={sessionActivity.runningIds}
              onOpenSettings={() => openCenterPage({ kind: "settings" })}
              onOpenWorkspaceSettings={handleOpenWorkspaceSettings}
            />
          ) : (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <ChatWindow
                reloadSignal={sessionKey}
                session={selectedSession}
                searchTarget={searchTarget?.sessionId === selectedSession?.id ? searchTarget : null}
                onSearchTargetHandled={handleSearchTargetHandled}
                newSessionCwd={effectiveNewSessionCwd}
                draftKeyOverride={activeTab?.kind === "new-session" ? activeTab.id : undefined}
                inputLeadingControl={
                  // 新会话占位 tab：composer 控制行带工作区选择器（与首页同款）。
                  // 改选 = 原地重定向 tab（同 id 保草稿，F1 文件 tab/右栏状态保留）。
                  activeTab?.kind === "new-session" ? (
                    <WorkspaceSelector
                      workspaces={workspaces.filter(isWorkspaceSelectable)}
                      selected={activeTab.workspace}
                      onSelect={(id) => {
                        const target = workspaces.find((w) => w.id === id);
                        if (!target || target.id === activeTab.workspace.id || !isWorkspaceSelectable(target)) return;
                        updateActiveTab((tab) => ({
                          ...createNewSessionTab(target, tab.id),
                          fileTabs: tab.fileTabs,
                          activeFileTabId: tab.activeFileTabId,
                          rightPanelOpen: tab.rightPanelOpen,
                        }));
                      }}
                    />
                  ) : undefined
                }
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
            </div>
          </div>
          )
        ) : !activeWorkspace ? (
          workspaces.some(isWorkspaceSelectable) ? (
            /* 首页退役：这个空态只可能是「自动落回家 tab 还没轮到」（同一帧内
             * 的 effect 会接住）——渲染极简占位，不闪首页页；真正零可用工作区
             * （全部停用/未建）才落 HomeNewSession 首页页（创建/选工作区引导）。 */
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
              …
            </div>
          ) : homeSession ? (
            <ChatWindow
              session={homeSession}
              newSessionCwd={null}
              reloadSignal={sessionKey}
              onAgentEnd={handleAgentEnd}
              onOpenFile={handleOpenLinkedFile}
              onOpenSession={handleOpenSessionViewer}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
            />
          ) : (
            workspacesLoaded ? (
              <HomeNewSession
                workspaces={workspaces}
                selectedWorkspaceId={
                  homeNewSession.workspaceId
                  ?? defaultHomeNewSessionWorkspaceId(workspaces, sessionActivity.sessions, mruIds)
                }
                onSelectWorkspace={handleHomeNewSessionSelect}
                onSessionCreated={handleHomeSessionCreated}
                onCreateWorkspace={handleCreateWorkspace}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
              />
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
                加载中…
              </div>
            )
          )
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

    {/* Right dock（2026-10 rail 改版，IDEA 形态）：图标列贴窗口最右缘，
        面板从其左侧展开。容器 row-reverse + DOM [rail][panel]——rail 永远
        钉在右缘，收起态（44px）被 overflow 裁掉的是面板左缘而非 rail。
        点未激活图标 = 切模块并展开；点已激活图标 = 收起到只剩 rail。展开态宽度沿用
        拖拽把手 + px 持久化 + 42% 默认；收起态不渲染把手（共识 Q8a）。配置
        整页打开或无工作区上下文时整个右坞隐藏（共识 Q6）。 */}
    {!centerPage && panelWorkspace && (
      <>
        {panelOpen && (
          <div
            className={`right-panel-resize-handle${rightPanelResizing ? " right-panel-resize-active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            title={translate("files.panelResize")}
            onMouseDown={startRightPanelResize}
            onDoubleClick={resetRightPanelWidth}
          />
        )}
        <div
          ref={rightPanelContainerRef}
          className={`right-panel-container${panelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " right-panel-resizing" : ""}`}
          style={{
            display: "flex",
            flexDirection: "row-reverse",
            background: "var(--bg)",
            ...(rightPanelWidth != null ? { "--pi-right-panel-width": `${rightPanelWidth}px` } : {}),
          } as React.CSSProperties}
        >
          <nav className="dock-rail" aria-label="工作台模块">
            {railEntries.map((entry) => {
              const active = railModule === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`dock-rail-icon${active ? " dock-rail-icon-active" : ""}`}
                  onClick={() => handleRailClick(entry.id)}
                  title={entry.label}
                  aria-label={entry.label}
                  aria-pressed={active}
                >
                  {entry.icon}
                  <span className="dock-rail-icon-label">{entry.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="dock-panel">
            {/* 模块内横条（2026-10 rail 改版）：「文件」模块 = [文件(树) |
                打开的文件 tab]（F1 沿用：文件 tab 状态挂在会话 tab 上，关最后
                一个回落文件树）；「终端」模块 = [终端1 | 终端2…] + ＋新建。
                其它三个模块无横条（面板体自带导航）。共识 Q3/Q4。 */}
            {railModule === FILES_TAB_ID && (
              <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <TabBar
                    tabs={panelFileTabs}
                    activeTabId={effFileTabId ?? FILES_TAB_ID}
                    leadingTabs={[{ id: FILES_TAB_ID, label: DOCK_MODULE_META[FILES_TAB_ID].label, icon: DOCK_MODULE_META[FILES_TAB_ID].icon }]}
                    onSelectTab={(id: string) => (homeAtDesktop ? setHomeActiveFileTabId(id) : updateActiveTab({ activeFileTabId: id }))}
                    onCloseTab={(id: string) => (homeAtDesktop ? handleCloseHomeFileTab : handleCloseFileTab)(id)}
                  />
                </div>
              </div>
            )}
            {railModule === TERMINALS_TAB_ID && (
              <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <TabBar
                    tabs={terminalTabs.map((tab) => ({
                      id: tab.id,
                      kind: "terminal" as const,
                      label: getFileName(tab.cwd) || tab.cwd,
                      cwd: tab.cwd,
                      closing: Boolean(tab.closing),
                    }))}
                    activeTabId={activeTerminalTab?.id ?? ""}
                    onSelectTab={(id: string) => setActiveTerminalId(id)}
                    onCloseTab={(id: string) => {
                      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === id && !tab.closing ? { ...tab, closing: "close" as const } : tab));
                    }}
                  />
                </div>
                <button
                  type="button"
                  title="新建终端（工作区根）"
                  aria-label="新建终端"
                  onClick={() => handleOpenTerminal(panelWorkspace!.path)}
                  style={{ width: 28, height: 28, margin: "0 4px", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                </button>
              </div>
            )}

            {/* Dock bodies: rail modules stay MOUNTED (hidden via display:none
                while another module is active) so their state survives module/
                session-tab switches of the SAME workspace (decision #6) —
                LoopsDockPanel etc. reset only when the workspace changes (key).
                File/session tabs render only while active. */}
            <div style={{ flex: 1, overflow: "hidden" }}>
        {panelWorkspace ? (
          <div
            style={{
              display: showFilesTree ? "flex" : "none",
              flexDirection: "column",
              height: "100%",
            }}
          >
            <FilesExplorerPanel
              workspace={panelWorkspace}
              explorerRefreshKey={explorerRefreshKey}
              onOpenFile={handleOpenFile}
              reveal={loopFilesReveal ?? undefined}
              onOpenTerminal={handleOpenTerminal}
            />
          </div>
        ) : null}
        {panelWorkspace ? (
          <div
            style={{
              display: railModule === LOOPS_TAB_ID ? "flex" : "none",
              flexDirection: "column",
              height: "100%",
            }}
          >
            <LoopsDockPanel
              key={panelWorkspace.id}
              workspace={panelWorkspace}
              refreshKey={loopsRefreshKey}
              onChanged={() => setLoopsRefreshKey((key) => key + 1)}
              onRunLoop={(name) => handleRunLoopDirect(panelWorkspace, name)}
            />
          </div>
        ) : null}
        {panelWorkspace ? (
          <div
            style={{
              display: railModule === KNOWLEDGE_TAB_ID ? "flex" : "none",
              flexDirection: "column",
              height: "100%",
            }}
          >
            <KnowledgeBrowser
              key={panelWorkspace.id}
              workspace={panelWorkspace}
              onOpenFile={handleOpenFile}
              refreshKey={explorerRefreshKey}
            />
          </div>
        ) : null}
        {panelWorkspace?.capabilities.includes("work-items") ? (
          <div
            style={{
              display: railModule === WORK_ITEMS_TAB_ID ? "flex" : "none",
              flexDirection: "column",
              height: "100%",
            }}
          >
            <WorkspaceManager
              key={panelWorkspace.id}
              open
              embedded
              panel
              initialSection="work-items"
              activeWorkspacePath={panelWorkspace.path}
              createWorkItemRequest={createWorkItemRequest}
              onClose={() => {}}
              onOpenWorkspace={handleOpenWorkspace}
              onOpenWorkItemConversation={handleOpenWorkItemConversation}
              onRunLoopRound={handleRunLoopRound}
              onRunContract={handleRunContract}
              onOpenConversation={handleOpenConversation}
              onWorkspaceDeleted={handleWorkspaceDeleted}
              onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
            />
          </div>
        ) : null}
        {/* Workspace terminals: stay MOUNTED behind inactive tabs / hidden
            panels / session switches — only the SSE client disconnects when
            hidden, the server-side pty lives until explicitly closed, the
            120s lease expires, or the server shuts down（上游 #695 语义）. */}
        {terminalTabs.map((tab) => (
          <div key={tab.id} hidden={!(railModule === TERMINALS_TAB_ID && tab.id === activeTerminalTab?.id)} style={{ width: "100%", height: "100%" }}>
            <TerminalPanel
              tab={tab}
              active={panelOpen && railModule === TERMINALS_TAB_ID && tab.id === activeTerminalTab?.id}
              onRestart={() => handleTerminalRestart(tab.id)}
              onClosed={() => handleTerminalClosed(tab)}
              onCloseError={() => handleTerminalCloseError(tab.id)}
            />
          </div>
        ))}
        {railModule === FILES_TAB_ID && panelActiveFileTab?.kind === "file" ? (
          <FileViewer
            filePath={panelActiveFileTab.filePath}
            cwd={(homeAtDesktop ? panelWorkspace?.path : activeCwd) ?? undefined}
            sourceSessionId={panelActiveFileTab.sourceSessionId}
            gitRefreshKey={explorerRefreshKey}
            initialDisplayMode={panelActiveFileTab.initialDisplayMode}
            onMentionLines={panelOpen ? handleFileLineMention : undefined}
            onOpenFile={(filePath) => handleOpenFile(
              filePath,
              getFileName(filePath),
              { sourceSessionId: panelActiveFileTab.sourceSessionId },
            )}
          />
        ) : railModule === FILES_TAB_ID && panelActiveFileTab?.kind === "session" ? (
          <ChatWindow
            key={panelActiveFileTab.sessionId}
            session={panelActiveFileTab.sessionInfo}
            newSessionCwd={null}
            embedded
            onOpenFile={handleOpenLinkedFile}
            onOpenSession={handleOpenSessionViewer}
          />
        ) : railModule === TERMINALS_TAB_ID && !activeTerminalTab ? (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text-dim)", fontSize: 12 }}>
            <span>暂无终端</span>
            <button
              type="button"
              onClick={() => handleOpenTerminal(panelWorkspace!.path)}
              style={{ height: 28, padding: "0 12px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
            >
              为 {panelWorkspace!.name} 新建终端
            </button>
          </div>
        ) : null}
            </div>
          </div>
        </div>
        </>
      )}
  </div>
    </>
  );
}
