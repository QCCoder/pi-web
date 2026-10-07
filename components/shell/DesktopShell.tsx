"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar, FILES_TAB_ID } from "../TabBar";
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
import { HomeLanding } from "../HomeLanding";
import { HomeNewSession } from "../HomeNewSession";
import { WorkspaceSelector } from "../WorkspaceSelector";
import { defaultHomeNewSessionWorkspaceId, workspaceForSession } from "@/lib/home-quick-switch";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";
import { LOOPS_TAB_ID, KNOWLEDGE_TAB_ID, WORK_ITEMS_TAB_ID, isModuleTabId, type ModuleTabId } from "@/lib/tab-types";
import { SessionTabBar } from "../SessionTabBar";
import { KnowledgeBrowser } from "../KnowledgeBrowser";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { SessionInfo } from "@/lib/types";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "@/lib/terminal-tab-state";
import { useShell } from "./context";
import type { SessionTabState } from "@/lib/session-tabs";
import { createNewSessionTab } from "@/lib/session-tabs";
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
};

/**
 * The desktop shell（2026-09 ZCode 风格导航改版）：左侧单一项目树侧栏
 * （ProjectSidebar：顶部 新建任务⌘N/搜索⌘K/插件&技能 导航行 + 项目→会话树 +
 * 组尾归档 + 底部 设置·模型·Agents 三入口）+ 中央区（ChatToolbar +
 * SessionTabBar + 工作区工具行 + 总览|聊天|配置整页）+ 右坞（按需打开的
 * 模块 tab：文件/Loops/知识库/工作项 + 文件/终端 tab）。2026-09 二次改版：
 * 右坞四个模块 tab 不再常驻固定——工作区工具行（工作区名 + 🏠总览 + 模块
 * toggle）成为模块常驻入口，坞内只留已打开的可关闭 tab，坞排空自动收起。
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
    rightPanelOpen,
    activeCwd,
    centerPage,
    setCenterPage,
    openCenterPage,
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
    homeRightPanelOpen,
    setHomeRightPanelOpen,
    setHomeActiveFileTabId,
    handleCloseHomeFileTab,
    handleHomeNewSessionSelect,
    handleHomeSessionCreated,
    handleCreateWorkItem,
    openSessionStatsPanel,
    dockModuleTabs,
    ensureDockModule,
    removeDockModule,
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
  const panelOpen = homeAtDesktop ? homeRightPanelOpen : rightPanelOpen;
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
    if (s.homeSession || s.homeNewSession.open) return;
    const targetId = defaultHomeNewSessionWorkspaceId(workspaces, s.sessionActivity.sessions, s.mruIds);
    const target = targetId ? workspaces.find((w) => w.id === targetId) : undefined;
    if (!target || !isWorkspaceSelectable(target)) return;
    handleOpenWorkspace(target, { replace: true });
  }, [navReady, activeTabId, s.homeSession, s.homeNewSession.open, workspaces, s.sessionActivity.sessions, s.mruIds, handleOpenWorkspace]);

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
  // Right dock（2026-09 改版）：activeFileTabId 的值域 = 文件/会话 tab id +
  // 模块 tab id。模块 tab 不再常驻（leadingTabs 固定四个 → 已废弃），改为
  // 「按需打开的可关闭 tab」：集合在 shell 状态层（dockModuleTabs，默认含
  // 「文件」），入口 = 工作区工具行 + 总览 hub；激活项仍在各会话 tab 自己的
  // activeFileTabId 里。模块内容跟工作区（决策 #6）：模块体常驻挂载
  // （display:none 隐藏），LoopsDockPanel 以 key=workspace.id 重置——同工作区
  // 切会话 tab 状态存活，换工作区才重建。
  const panelEffTabId = panelActiveFileTabId ?? (dockModuleTabs.includes(FILES_TAB_ID) ? FILES_TAB_ID : null);
  // ---- Workspace terminals（上游 #695 移植）--------------------------------
  // 终端 tab 由 DesktopShell 自有（不进 useAppShellState）：跨会话 tab/工程
  // 切换常驻挂载（上游语义：terminal panels stay mounted behind inactive
  // tabs, hidden panels, and session or project switches），仅 hidden 隐藏。
  // tab 条挂在工作坞 TabBar 尾部；激活复用 activeFileTabId 通道（终端 id 不
  // 在 fileTabs/moduleTabs 里 → 文件树/查看器分支自动让位，见 activeTerminalTab）。
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === panelActiveFileTabId) ?? null;
  const dockActiveModule = !panelActiveFileTab && isModuleTabId(panelEffTabId) ? panelEffTabId : null;
  const showFilesTree = Boolean(panelWorkspace) && panelEffTabId !== null && !panelActiveFileTab && !activeTerminalTab
    && (panelEffTabId === FILES_TAB_ID || !isModuleTabId(panelEffTabId));

  // ---- 右坞模块 tab 的开合（2026-09 改版，docs/right-dock-design.md §2）------
  // toggle 语义（工作区工具行入口）：未开 → 打开并激活 + dock 自动打开；已开
  // 未激活 → 仅激活；已开且激活（且 dock 开着）→ 关闭。关闭激活模块时激活项
  // 回落：剩余模块 → 最后一个文件 tab → 空。dock 内 tab（模块/文件/终端）
  // 全部排空 → dock 整体收起。
  const setDockActiveId = (id: string | null, open?: boolean) => {
    if (homeAtDesktop) {
      setHomeActiveFileTabId(id);
      if (open !== undefined) setHomeRightPanelOpen(open);
    } else if (open !== undefined) {
      updateActiveTab({ activeFileTabId: id, rightPanelOpen: open });
    } else {
      updateActiveTab({ activeFileTabId: id });
    }
  };
  const collapseDockIfEmpty = (modulesLeft: number, fileTabsLeft: number, termsLeft: number) => {
    if (modulesLeft > 0 || fileTabsLeft > 0 || termsLeft > 0) return;
    if (homeAtDesktop) setHomeRightPanelOpen(false);
    else updateActiveTab({ rightPanelOpen: false });
  };
  const closeDockModule = (id: ModuleTabId) => {
    const next = dockModuleTabs.filter((m) => m !== id);
    removeDockModule(id);
    if (panelActiveFileTabId === id) {
      const fallback = next[next.length - 1] ?? panelFileTabs[panelFileTabs.length - 1]?.id ?? null;
      setDockActiveId(fallback);
    }
    collapseDockIfEmpty(next.length, panelFileTabs.length, terminalTabs.length);
  };
  const openDockModuleTab = (id: ModuleTabId) => {
    ensureDockModule(id);
    setDockActiveId(id, true);
  };
  const toggleDockModule = (id: ModuleTabId) => {
    if (dockModuleTabs.includes(id) && panelEffTabId === id && panelOpen) closeDockModule(id);
    else openDockModuleTab(id);
  };

  // 刷新恢复：sessionStorage 里的终端身份（id+cwd）在挂载时还原；restored tab
  // 的面板会先 GET 校验服务端实例，过期/服务重启后绝不静默起新 shell（上游语义）。
  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.tabs.length > 0 && saved.activeId) {
        const { activeId, open } = saved;
        if (homeAtDesktop) {
          setHomeActiveFileTabId(activeId);
          setHomeRightPanelOpen(open);
        } else {
          updateActiveTab({ activeFileTabId: activeId, rightPanelOpen: open });
        }
      }
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore-once on mount
  }, []);

  // 恢复完成后持续持久化（id+cwd+激活 tab+面板开合；closing 状态不入档）。
  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeTerminalTab?.id ?? null,
        open: panelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeTerminalTab, panelOpen, terminalsRestored]);

  const handleOpenTerminal = (cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    if (homeAtDesktop) {
      setHomeActiveFileTabId(tab.id);
      setHomeRightPanelOpen(true);
    } else {
      updateActiveTab({ activeFileTabId: tab.id, rightPanelOpen: true });
    }
  };

  // 显式终止/重启：标记 closing → TerminalPanel 等创建与在途输入落地后 DELETE →
  // onClosed 回 here。restart 换新 id 重建（新 shell），close 则移除；关闭激活
  // tab 后回落文件树（本地右栏语义：不自动收起）。
  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    if (panelActiveFileTabId !== tab.id) return;
    const nextActiveId = replacement?.id ?? null;
    if (homeAtDesktop) setHomeActiveFileTabId(nextActiveId);
    else updateActiveTab({ activeFileTabId: nextActiveId });
  };

  const handleTerminalRestart = (id: string) => {
    setTerminalTabs((tabs) => tabs.map((item) => item.id === id ? { ...item, closing: "restart" as const } : item));
  };

  const handleTerminalCloseError = (id: string) => {
    setTerminalTabs((tabs) => tabs.map((item) => item.id === id ? { ...item, closing: undefined } : item));
  };

  // tab 的关闭先于文件 tab 拦截：模块 tab（可关闭化后带 ✕）→ 终端 → 文件。
  const handleDockTabClose = (id: string) => {
    if (isModuleTabId(id)) {
      closeDockModule(id);
      return;
    }
    if (terminalTabs.some((tab) => tab.id === id)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === id && !tab.closing ? { ...tab, closing: "close" as const } : tab));
      return;
    }
    const fileTabsLeft = panelFileTabs.length - 1;
    (homeAtDesktop ? handleCloseHomeFileTab : handleCloseFileTab)(id);
    if (homeAtDesktop) {
      collapseDockIfEmpty(dockModuleTabs.length, fileTabsLeft, terminalTabs.length);
      return;
    }
    // 桌面：handleCloseFileTab 关掉最后一个文件 tab 时会把激活项钉回 FILES
    // 常量；若「文件」模块 tab 已被用户关闭，这里覆盖为按剩余模块回落
    // （无剩余 → 排空收坞），避免出现「没有 tab 条却亮着文件树」。
    if (fileTabsLeft === 0 && !dockModuleTabs.includes(FILES_TAB_ID)) {
      const fallback = dockModuleTabs[dockModuleTabs.length - 1] ?? null;
      updateActiveTab({ activeFileTabId: fallback, ...(fallback === null && terminalTabs.length === 0 ? { rightPanelOpen: false } : {}) });
      return;
    }
    collapseDockIfEmpty(dockModuleTabs.length, fileTabsLeft, terminalTabs.length);
  };

  // ---- 中央区整页（CenterPage）------------------------------------------------
  // 导航入口（插件&技能 / 设置 / 模型 / Agents）各自打开独立配置整页
  // （ConfigCenterPage，2026-09 拆分——此前四入口共用一个两栏设置页只换预选
  // 分区，用户反馈「跳转的页面都一模一样」），项目树「归档」行打开归档整页。
  // 整页占中央区，tab 条保持可见——点任何会话 tab 即关闭回聊天。
  const closeCenterPage = () => setCenterPage(null);

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
      <ProjectSidebar
        workspaces={workspaces}
        allSessions={sessionActivity.sessions}
        runningSessionIds={sessionActivity.runningIds}
        completedSessionIds={sessionActivity.completedIds}
        selectedSessionId={selectedSession?.id ?? homeSession?.id ?? null}
        activeWorkspace={activeWorkspace}
        activeConfigPage={centerPage && centerPage.kind !== "archive" ? centerPage.kind : null}
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

      {/* 工作区工具行（2026-09-27 二次改版）：左 = 「工作区名 ▾」切换器——
          点击展开 WorkspaceSwitcherPanel（工作区列表[拖拽排序/运行徽章/新建/
          导入] + 当前工作区模块入口 总览/文件/工作项/知识库/Loops）；右 =
          🏠总览 + 文件 两个高频捷径（平铺），工作项/知识库/Loops 收进面板。
          无活动工作区（首页）或中央区整页打开时整行隐藏。 */}
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
          {(() => {
            const active = panelOpen && panelEffTabId === FILES_TAB_ID;
            const { label, icon } = DOCK_MODULE_META[FILES_TAB_ID];
            return (
              <button
                type="button"
                onClick={() => toggleDockModule(FILES_TAB_ID)}
                aria-pressed={active}
                title={label}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  height: 24, padding: "0 8px",
                  background: active ? "var(--bg-selected)" : "none",
                  border: "none", borderRadius: 4,
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0, fontSize: 12, whiteSpace: "nowrap",
                  userSelect: "none",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = active ? "var(--text)" : "var(--text-muted)"; }}
              >
                <span style={{ display: "flex", alignItems: "center", opacity: active ? 1 : 0.7 }}>{icon}</span>
                {label}
              </button>
            );
          })()}
          <div style={{ flex: 1 }} />

          {/* 工作区切换面板（WorkspaceSwitcherPanel，两端共用）：行下方弹出，
              点外部关闭；模块入口 = dock 开合语义（总览/文件 与行上捷径一致）。 */}
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
                  moduleEntries={[
                    {
                      id: "overview",
                      label: "总览",
                      icon: (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 9.5 12 3l9 6.5" /><path d="M5 8.5V21h14V8.5" />
                        </svg>
                      ),
                      active: activeTab?.kind === "workspace-home",
                      onClick: () => { setSwitcherOpen(false); handleShowOverview(); },
                    },
                    ...([
                      FILES_TAB_ID,
                      ...(activeWorkspace.capabilities.includes("work-items") ? [WORK_ITEMS_TAB_ID] : []),
                      ...(activeWorkspace.capabilities.includes("knowledge") ? [KNOWLEDGE_TAB_ID] : []),
                      LOOPS_TAB_ID,
                    ] as ModuleTabId[]).map((id) => ({
                      id,
                      label: DOCK_MODULE_META[id].label,
                      icon: DOCK_MODULE_META[id].icon,
                      active: panelOpen && panelEffTabId === id,
                      onClick: () => { setSwitcherOpen(false); openDockModuleTab(id); },
                    })),
                  ]}
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
            onOpenWorkItems={() => openDockModuleTab(WORK_ITEMS_TAB_ID)}
            onCreateWorkItem={handleCreateWorkItem}
            onSelectSession={handleSelectSession}
            onSwitchSidebarView={(view) => {
              // 仓库行 → 右坞「文件」tab；知识库行 → 右坞「知识库」tab
              // （S2 收编：hub knowledge 子视图已退役）。改版后先确保模块
              // tab 在坞里已打开。
              openDockModuleTab(view === "knowledge" ? KNOWLEDGE_TAB_ID : FILES_TAB_ID);
            }}
            onAddRepository={() => {
              openCenterPage({ kind: "settings" });
              setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
            }}
            onSessionDeleted={handleSessionRemoved}
            onOpenLoopsTab={() => openDockModuleTab(LOOPS_TAB_ID)}
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

    {/* Right panel resize handle (drag to widen/narrow; double-click resets
        to the 42% default) — same pattern as the sidebar handle, placed
        between the center column and the right file panel. Rendered only
        while the panel is open (at home the panel is closed). */}
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

    {/* Right panel: file viewer — always mounted, width animated via CSS,
        drag-resizable via the handle above (px width persisted in
        localStorage; null → CSS 42% default) */}
    <div
      ref={rightPanelContainerRef}
      className={`right-panel-container${panelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " right-panel-resizing" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        ...(rightPanelWidth != null ? { "--pi-right-panel-width": `${rightPanelWidth}px` } : {}),
      } as React.CSSProperties}
    >
      {/* Right dock tab bar（2026-09 改版）——模块 tab 不再常驻固定，改为
          「已打开的模块集合」（dockModuleTabs，入口在工作区工具行/总览 hub）
          渲染成带 ✕ 的可关闭 tab（窄面板时仍按 .dock-module-tab 的
          @container 规则图标化）+ 文件/终端 tab。激活模块关闭后的回落与
          坞排空收起见 handleDockTabClose/closeDockModule。 */}
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}
      >
        <div style={{ flex: 1, overflow: "hidden" }}>
          <TabBar
            tabs={[
              ...panelFileTabs,
              ...terminalTabs.map((tab) => ({
                id: tab.id,
                kind: "terminal" as const,
                label: getFileName(tab.cwd) || tab.cwd,
                cwd: tab.cwd,
                closing: Boolean(tab.closing),
              })),
            ]}
            activeTabId={panelActiveFileTabId ?? (dockModuleTabs.includes(FILES_TAB_ID) ? FILES_TAB_ID : "")}
            leadingTabs={panelWorkspace ? dockModuleTabs
              .filter((id) => (id !== KNOWLEDGE_TAB_ID || panelWorkspace.capabilities.includes("knowledge"))
                && (id !== WORK_ITEMS_TAB_ID || panelWorkspace.capabilities.includes("work-items")))
              .map((id) => ({ id, label: DOCK_MODULE_META[id].label, icon: DOCK_MODULE_META[id].icon, closable: true }))
            : undefined}
            onSelectTab={(id: string) => (homeAtDesktop ? setHomeActiveFileTabId(id) : updateActiveTab({ activeFileTabId: id }))}
            onCloseTab={handleDockTabClose}
          />
        </div>

      </div>

      {/* Dock bodies: module tabs stay MOUNTED (hidden via display:none while
          another tab is active) so their state survives tab switches of the
          SAME workspace (decision #6) — LoopsDockPanel resets only when the
          workspace changes (key). File/session tabs render only while active;
          the empty hint remains only as the home fallback (no workspace → no
          tree to show). */}
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
              display: dockActiveModule === LOOPS_TAB_ID ? "flex" : "none",
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
              display: dockActiveModule === KNOWLEDGE_TAB_ID ? "flex" : "none",
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
              display: dockActiveModule === WORK_ITEMS_TAB_ID ? "flex" : "none",
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
          <div key={tab.id} hidden={tab.id !== panelActiveFileTabId} style={{ width: "100%", height: "100%" }}>
            <TerminalPanel
              tab={tab}
              active={panelOpen && tab.id === panelActiveFileTabId}
              onRestart={() => handleTerminalRestart(tab.id)}
              onClosed={() => handleTerminalClosed(tab)}
              onCloseError={() => handleTerminalCloseError(tab.id)}
            />
          </div>
        ))}
        {panelActiveFileTab?.kind === "file" ? (
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
        ) : panelActiveFileTab?.kind === "session" ? (
          <ChatWindow
            key={panelActiveFileTab.sessionId}
            session={panelActiveFileTab.sessionInfo}
            newSessionCwd={null}
            embedded
            onOpenFile={handleOpenLinkedFile}
            onOpenSession={handleOpenSessionViewer}
          />
        ) : !panelWorkspace ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
             {translate("files.noneOpen")}
          </div>
        ) : null}
      </div>
    </div>
  </div>
  {/* File panel toggle — workspace tab 或首页（上下文工作区存在即可切）。 */}
  {panelWorkspace && <button
    onClick={() => (homeAtDesktop ? setHomeRightPanelOpen(!homeRightPanelOpen) : updateActiveTab((tab) => ({ rightPanelOpen: !tab.rightPanelOpen })))}
     title={panelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
     aria-label={panelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
    style={{
      position: "fixed", top: 0, right: 0, zIndex: 300,
      display: "flex", alignItems: "center", justifyContent: "center",
      width: 36, height: 36, padding: 0,
      background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
      color: panelOpen ? "var(--text)" : "var(--text-muted)",
      cursor: "pointer", transition: "color 0.12s",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.color = panelOpen ? "var(--text)" : "var(--text-muted)"; }}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  </button>}
    </>
  );
}
