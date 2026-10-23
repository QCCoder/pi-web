"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar } from "../TabBar";
import { ArchiveModal } from "../ArchiveModal";
import { KnowledgeBrowser } from "../KnowledgeBrowser";
import { WorkspaceManager } from "../WorkspaceManager";
import { FilesExplorerPanel } from "../FilesExplorerPanel";
import { LoopsDockPanel } from "../LoopsDockPanel";
import { PanelHeader } from "../PanelHeader";
import { SettingsPanel } from "../SettingsPanel";
import { HomeLanding } from "../HomeLanding";
import { HomeNewSession } from "../HomeNewSession";
import { ProjectSidebar } from "../ProjectSidebar";
import { WorkItemsPage } from "../work-items/WorkItemsPage";
import { WorkspaceOverview } from "../WorkspaceOverview";
import { type SwitcherModuleEntry } from "../WorkspaceSwitcherPanel";
import { WorkspaceSelector } from "../WorkspaceSelector";
import { createNewSessionTab } from "@/lib/session-tabs";
import type { CenterPage } from "./useAppShellState";
import { defaultHomeNewSessionWorkspaceId } from "@/lib/home-quick-switch";
import { isWorkspaceSelectable } from "@/lib/workspaces/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useShell } from "./context";
import { ChatToolbar } from "./ChatToolbar";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { getFileName } from "@/lib/file-paths";

/**
 * 移动端壳（2026-09 树抽屉重构，docs/mobile-drawer-design.md；2026-09-27
 * 侧栏瘦身：抽屉树 + 模块行退役，抽屉头「工作区名 ▾」面板（工作区切换 +
 * 模块入口）+ 当前工作区会话清单，切工作区两端统一「落总览」）：
 *
 *   手机（<768px）：ChatToolbar（☰ 开抽屉 + 居中标题 + 统计 + ⋯）+ 全屏主区 +
 *   抽屉（ProjectSidebar：头部工作区切换块 + 当前工作区会话 + 搜索 + 设置条）。
 *   聊天永远是主区默认态；总览/文件/工作项/知识库/Loops/设置/归档是带 ‹返回 的
 *   全屏目的地页，返回永远 = 回聊天（扁平导航，深层导航留在各面板内部）。
 *   底部 tab 栏与头部会话 chips 行均已删除——抽屉是唯一定期导航。
 *
 *   ≥768px（平板/横屏/折叠展开）：同一侧栏常驻贴左（推挤内容，不覆盖），
 *   抽屉形态关闭、☰ 隐藏。跨断点切换不丢 mobilePage 与会话状态。
 *
 * 上下文规则（§4.2「跟着屏幕走」）：面板里以工作区 W 为目标的动作 =
 *   ensureWorkspaceContext(W)（幂等建/激活 W 锚定占位 tab，纯状态）+ 目的地；
 *   会话行点击走 handleSelectSession（自带 focusChat → 关目的地页）。切工作区
 *   与 PC 对齐 = 落该工作区总览（mobilePage:"overview"，2026-09-27）。
 *
 * 聊天持久挂载（display:none 不卸载）保证 SSE 与流式气泡跨页面切换不断；
 * HomeLanding 只剩一个职责：零可用工作区时的创建/重启用引导。
 */

type MobilePage = "overview" | "files" | "work-items" | "knowledge" | "loops" | "settings" | "archive";

const MOBILE_TREE_WIDTH = 280;

export function MobileShell() {
  const s = useShell();
  const { t: translate } = useI18n();

  const {
    navReady,
    activeTab,
    activeTabId,
    activeWorkspace,
    selectedSession,
    fileTabs,
    activeFileTabId,
    rightPanelOpen,
    activeCwd,
    workspaces,
    refreshKey,
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
    activeFileTab,
    chatFocusKey,
    settingsPage,
    setSettingsPage,
    settingsCwd,
    mobileNavOpen,
    setMobileNavOpen,
    ensureWorkspaceContext,
    openNewSessionTab,
    handleSessionRemoved,
    handleCreateWorkspace,
    handleCreateWorkItem,
    handleOpenConversation,
    handleWorkspaceNewSession,
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
    openSessionStatsPanel,
    handleContextUsageChange,
    chatInputRef,
    loopFilesReveal,
    updateActiveTab,
    setRefreshKey,
    setImportPickerOpen,
    setOpenRepositoryFormRequest,
  } = s;

  // ---- 目的地页（扁平导航：null = 聊天；‹返回 永远 = 回聊天）--------------
  const [mobilePage, setMobilePage] = useState<MobilePage | null>(null);
  // LoopsDockPanel 的变更信号：创建/删除/保存后 bump → 重新拉取。
  const [loopsRefreshKey, setLoopsRefreshKey] = useState(0);

  // ---- 会话全文搜索深跳转（与 DesktopShell 同机制，壳自有）----------------
  // 搜索结果行选择会话时先记下 entryId/blockIndex，再走常规
  // handleSelectSession 打开会话；ChatWindow 定位完成后经
  // handleSearchTargetHandled 注销（按 target 身份比较）。
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => (current === target ? null : current));
  }, []);

  // 宽视口（≥768px）且存在工作区 → 树常驻贴左；窄屏 → 抽屉形态。
  const wide = useMediaQuery("(min-width: 768px)");
  const showPermanentTree = wide && workspaces.length > 0;
  const drawerOpen = mobileNavOpen && !showPermanentTree;

  // 共享焦点信号 → 导航反应：打开会话/新建会话（focusChat）= 离开目的地页。
  useEffect(() => {
    if (chatFocusKey > 0) setMobilePage(null);
  }, [chatFocusKey]);
  // Loops 面板 reveal 信号 → 打开「文件」目的地页（FilesExplorerPanel 自己
  // 会把分段切回「文件」）。
  const loopFilesRevealNonce = loopFilesReveal?.nonce;
  useEffect(() => {
    if (loopFilesRevealNonce !== undefined) setMobilePage("files");
  }, [loopFilesRevealNonce]);
  // 离开设置目的地页时丢弃瞬态深链请求（避免下次打开闪回旧选择）。
  useEffect(() => {
    if (mobilePage !== "settings") clearWorkspaceSettingsRequest();
  }, [mobilePage, clearWorkspaceSettingsRequest]);

  // ---- Android 返回键关抽屉（docs/mobile-drawer-design.md §6 / M2）--------
  // 抽屉打开时压入一个陷阱 history 态；popstate（Android 返回键/返回手势）
  // 只关抽屉不退页；抽屉经遮罩/目标关闭时在 cleanup 里消费掉陷阱态（栈顶
  // 仍是陷阱才 history.back()——返回键路径已由系统消费过，不会二次退）。
  useEffect(() => {
    if (!drawerOpen) return;
    try { history.pushState({ piMobileNavDrawer: true }, ""); } catch { /* ignore */ }
    const onPopState = () => setMobileNavOpen(false);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (history.state && (history.state as { piMobileNavDrawer?: boolean }).piMobileNavDrawer) {
        history.back();
      }
    };
  }, [drawerOpen, setMobileNavOpen]);

  // ---- 边缘右滑开抽屉（M2 增强，窄屏 only）--------------------------------
  // document 级 passive touch 跟踪：起点距左缘 <28px、横向位移 >56px 且明显
  // 横向（|dx| > 1.5|dy|）→ 开抽屉。不 preventDefault、不劫内容滚动；iOS
  // Safari 的系统边缘返回手势通常在 web 触摸之前就被系统消费，Android
  // Chrome/PWA 无冲突。关抽屉仍走遮罩/目标点击（Q8）。
  useEffect(() => {
    if (showPermanentTree || mobileNavOpen) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = startX < 28;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (dx > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        tracking = false;
        setMobileNavOpen(true);
      }
    };
    const onTouchEnd = () => { tracking = false; };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [showPermanentTree, mobileNavOpen, setMobileNavOpen]);

  // ---- 空态自动落回（首页退役语义的抽屉版）--------------------------------
  // 没有任何 tab（冷启动 / 会话删除自动关掉最后一个）→ 给默认工作区开一个
  // 占位 composer 作为上下文锚（= 事实首页）。replace 写 URL，不给浏览器
  // 历史埋可 popstate 回跳的陷阱。零可用工作区时不动：HomeLanding 引导接手。
  useEffect(() => {
    if (!navReady || activeTabId !== null) return;
    // 中央区整页（如 work-items 深链）打开时不做空态自动落 composer——
    // openNewSessionTab 会清 centerPage 并改写 URL，吃掉深链。
    if (s.centerPage) return;
    if (s.homeSession || s.homeNewSession.open) return;
    const targetId = defaultHomeNewSessionWorkspaceId(workspaces, s.sessionActivity.sessions, s.mruIds);
    const target = workspaces.find((w) => w.id === targetId);
    if (!target || !isWorkspaceSelectable(target)) return;
    openNewSessionTab(target, { replace: true });
  }, [navReady, activeTabId, s.centerPage, s.homeSession, s.homeNewSession.open, workspaces, s.sessionActivity.sessions, s.mruIds, openNewSessionTab]);

  // ---- 抽屉 / 常驻树头部的模块条（2026-09-27 晚：工作区切换器撤下——分组
  // 会话清单已列全部项目，点会话即切上下文；模块入口保留为紧凑图标条）------
  const closeDrawer = useCallback(() => setMobileNavOpen(false), [setMobileNavOpen]);
  const handleNavNewSession = useCallback(() => {
    closeDrawer();
    setMobilePage(null);
    if (activeWorkspace) handleWorkspaceNewSession();
  }, [closeDrawer, activeWorkspace, handleWorkspaceNewSession]);
  const handleNavSelectSession = useCallback((session: SessionInfo) => {
    closeDrawer();
    handleSelectSession(session);
  }, [closeDrawer, handleSelectSession]);
  const handleNavSelectSearchHit = useCallback((session: SessionInfo, entryId?: string, blockIndex?: number) => {
    closeDrawer();
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    handleSelectSession(session);
  }, [closeDrawer, handleSelectSession]);
  const handleNavModule = useCallback((workspace: WorkspaceSummary, module: "files" | "work-items" | "knowledge" | "loops") => {
    closeDrawer();
    ensureWorkspaceContext(workspace);
    setMobilePage(module);
  }, [closeDrawer, ensureWorkspaceContext]);
  const handleNavArchive = useCallback((workspace: WorkspaceSummary) => {
    closeDrawer();
    ensureWorkspaceContext(workspace);
    setMobilePage("archive");
  }, [closeDrawer, ensureWorkspaceContext]);
  const handleNavCenterPage = useCallback((page: CenterPage) => {
    closeDrawer();
    // 移动端没有中央区整页（2026-09 配置页拆分是桌面侧的改版）：四个配置
    // 导航统一落设置目的地页的对应子页——设置=工作区，模型/插件/Agents=同名
    // 子页（插件&技能页的技能分区经设置页索引进入）。
    if (page.kind === "settings" || page.kind === "models" || page.kind === "agents" || page.kind === "plugins") {
      setMobilePage("settings");
      setSettingsPage(page.kind === "settings" ? "workspace" : page.kind);
    }
  }, [closeDrawer, setSettingsPage]);

  // ---- 模块条条目（抽屉/常驻树头部，作用于当前工作区）：目的地页语义，
  // active 高亮跟 mobilePage。工作项/知识库 capability 门控。
  const switcherModuleEntries: SwitcherModuleEntry[] = activeWorkspace ? [
    {
      id: "overview",
      label: "总览",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 9.5 12 3l9 6.5" /><path d="M5 8.5V21h14V8.5" />
        </svg>
      ),
      active: mobilePage === "overview",
      onClick: () => { closeDrawer(); setMobilePage("overview"); },
    },
    {
      id: "files",
      label: "文件",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
      active: mobilePage === "files",
      onClick: () => handleNavModule(activeWorkspace, "files"),
    },
    ...(activeWorkspace.capabilities.includes("work-items") ? [{
      id: "work-items",
      label: "工作项",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      ),
      active: mobilePage === "work-items",
      onClick: () => handleNavModule(activeWorkspace, "work-items"),
    }] : []),
    ...(activeWorkspace.capabilities.includes("knowledge") ? [{
      id: "knowledge",
      label: "知识库",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      ),
      active: mobilePage === "knowledge",
      onClick: () => handleNavModule(activeWorkspace, "knowledge"),
    }] : []),
    {
      id: "loops",
      label: "Loops",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3.8-7.4" /><path d="M21 3v5h-5" />
        </svg>
      ),
      active: mobilePage === "loops",
      onClick: () => handleNavModule(activeWorkspace, "loops"),
    },
  ] : [];

  const mobileSwitcherSlot = activeWorkspace ? (
    <div role="tablist" aria-label="工作区模块" style={{ display: "flex", gap: 2, padding: "8px 8px 2px", flexShrink: 0 }}>
      {switcherModuleEntries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-selected={entry.active}
          onClick={entry.onClick}
          title={entry.label}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
            height: 44,
            padding: 0,
            border: 0,
            borderRadius: 8,
            background: entry.active ? "var(--bg-selected)" : "transparent",
            color: entry.active ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            transition: "background 0.12s",
          }}
          onMouseEnter={(e) => { if (!entry.active) e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = entry.active ? "var(--bg-selected)" : "transparent"; }}
        >
          {entry.icon}
          <span style={{ fontSize: 10, lineHeight: 1 }}>{entry.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  const projectSidebarProps = {
    workspaces,
    allSessions: sessionActivity.sessions,
    runningSessionIds: sessionActivity.runningIds,
    completedSessionIds: sessionActivity.completedIds,
    selectedSessionId: selectedSession?.id ?? s.homeSession?.id ?? null,
    activeWorkspace,
    // 配置页高亮（桌面是 centerPage.kind 直传；移动端从设置子页反推宿主页：
    // 模型/插件/Agents 子页归到同名 kind，其余（工作区/偏好/Skills）归设置）。
    activeConfigPage: (mobilePage === "settings"
      ? (settingsPage === "models" ? "models"
        : settingsPage === "agents" ? "agents"
        : settingsPage === "plugins" || settingsPage === "skills" ? "plugins"
        : "settings")
      : null) as "settings" | "models" | "plugins" | "agents" | null,
    workspacesLoaded: s.workspacesLoaded,
    sessionsLoaded: sessionActivity.loaded,
    headerSlot: mobileSwitcherSlot,
    onNewSession: handleNavNewSession,
    onOpenArchive: handleNavArchive,
    onSelectSession: handleNavSelectSession,
    onSelectSearchHit: handleNavSelectSearchHit,
    sessionListVersion: sessionActivity.listVersion,
    onOpenSessionInNewTab: s.openSessionTab,
    onSessionRemoved: handleSessionRemoved,
    onCreateWorkspace: handleCreateWorkspace,
    onImportDirectory: () => setImportPickerOpen(true),
    onOpenCenterPage: handleNavCenterPage,
  };

  // ---- 聊天（持久挂载）------------------------------------------------------
  const renderChat = () => (
    <ChatWindow
      reloadSignal={sessionKey}
      session={selectedSession}
      newSessionCwd={effectiveNewSessionCwd ?? activeWorkspace?.path ?? null}
      draftKeyOverride={activeTab?.kind === "new-session" ? activeTab.id : undefined}
      inputLeadingControl={
        // 新会话占位 tab：composer 控制行带工作区选择器（改选 = 原地重定向，
        // 同 id 保草稿）。家 tab 不加——工作区是它自身的语义。
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
      searchTarget={searchTarget?.sessionId === selectedSession?.id ? searchTarget : null}
      onSearchTargetHandled={handleSearchTargetHandled}
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
  );

  // ---- 目的地页内容（全部复用现有面板与嵌入模式，深层导航留在面板内部）------
  const renderPageContent = () => {
    switch (mobilePage) {
      case "overview":
        // 切工作区 = 落总览（与桌面家 tab 对齐，2026-09-27）：‹返回 = 回聊天。
        if (!activeWorkspace) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <PanelHeader title="总览" meta={activeWorkspace.name} onBack={() => setMobilePage(null)} backLabel="聊天" />
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <WorkspaceOverview
                workspace={activeWorkspace}
                workspaces={workspaces}
                onNewSession={() => { setMobilePage(null); handleWorkspaceNewSession(); }}
                onOpenSettings={() => {
                  requestWorkspaceSettings(activeWorkspace);
                  setMobilePage("settings");
                }}
                onOpenWorkItems={() => setMobilePage("work-items")}
                onOpenWorkItemsPage={() => setMobilePage("work-items")}
                onCreateWorkItem={(type) => {
                  // 总览「新建工作项」：落工作项目的地页（WorkItemsPage 经
                  // createRequest 直达创建表单；handleCreateWorkItem 只置请求
                  // + 写 dock rail 状态（移动端 inert）——不导航的话按钮没反应。
                  handleCreateWorkItem(type);
                  setMobilePage("work-items");
                }}
                onSelectSession={handleSelectSession}
                onSwitchSidebarView={(view) => setMobilePage(view === "knowledge" ? "knowledge" : "files")}
                onAddRepository={() => {
                  requestWorkspaceSettings(activeWorkspace);
                  setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
                  setMobilePage("settings");
                }}
                onSessionDeleted={handleSessionRemoved}
                onOpenLoopsTab={() => setMobilePage("loops")}
                loopsRefreshKey={loopsRefreshKey}
              />
            </div>
          </div>
        );
      case "files":
        if (!activeWorkspace) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <PanelHeader title="文件" meta={activeWorkspace.name} onBack={() => setMobilePage(null)} backLabel="聊天" />
            <div style={{ flex: 1, minHeight: 0 }}>
              <FilesExplorerPanel
                key={activeWorkspace.id}
                workspace={activeWorkspace}
                explorerRefreshKey={explorerRefreshKey}
                onOpenFile={handleOpenFile}
                reveal={loopFilesReveal ?? undefined}
              />
            </div>
          </div>
        );
      case "work-items":
        // 工作项目的地页宿中央同款 WorkItemsPage（M2 T10，spec §6.1/§6.3）：
        // 同一共享数据缓存与同一套 列表/筛选/详情/创建/回收站；窄屏形态由
        // 页面自适配（看板回落为阶段筛选列表、详情全屏覆盖）。‹返回 = 回聊天
        // （mobilePage 切回，页面内部列表→详情导航自持）；「查看会话」= 关
        // 目的地页 + 既有 locate 打开会话路径（focusChat 也会关目的地页，
        // 双保险）；Loops 恢复 → loops 目的地页。capability 门控沿用模块条
        // （入口不渲染则此页不可达）。
        if (!activeWorkspace) return null;
        return (
          <WorkItemsPage
            key={activeWorkspace.id}
            workspaceId={activeWorkspace.id}
            createRequest={createWorkItemRequest}
            onOpenConversation={(sessionId) => {
              setMobilePage(null);
              handleOpenConversation(sessionId);
            }}
            onOpenLoopsRecovery={() => setMobilePage("loops")}
            onBack={() => setMobilePage(null)}
            backLabel="聊天"
            onOpenWorkItemsPage={(id) => {
              // ≥768px 平板形态：页头工作区选择器可见（narrow=false），切换 =
              // 换上下文锚定（页面 key=activeWorkspace.id 随之重挂载到新工作区；
              // 窄屏选择器隐藏，此回调不可达）。
              const target = workspaces.find((w) => w.id === id);
              if (target && isWorkspaceSelectable(target)) ensureWorkspaceContext(target);
            }}
            workspaces={workspaces}
          />
        );
      case "knowledge":
        if (!activeWorkspace) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <PanelHeader title="知识库" meta={activeWorkspace.name} onBack={() => setMobilePage(null)} backLabel="聊天" />
            <KnowledgeBrowser
              key={activeWorkspace.id}
              workspace={activeWorkspace}
              onOpenFile={handleOpenFile}
              refreshKey={explorerRefreshKey}
            />
          </div>
        );
      case "loops":
        if (!activeWorkspace) return null;
        return (
          <LoopsDockPanel
            key={activeWorkspace.id}
            workspace={activeWorkspace}
            refreshKey={loopsRefreshKey}
            onChanged={() => setLoopsRefreshKey((key) => key + 1)}
            onRunLoop={(name) => handleRunLoopDirect(activeWorkspace, name)}
            listHeader={(
              <PanelHeader title="Loops" meta={activeWorkspace.name} onBack={() => setMobilePage(null)} backLabel="聊天" />
            )}
          />
        );
      case "archive":
        if (!activeWorkspace) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <PanelHeader title="归档" meta={activeWorkspace.name} onBack={() => setMobilePage(null)} backLabel="聊天" />
            <ArchiveModal
              embedded
              workspaceId={activeWorkspace.id}
              workspacePath={activeWorkspace.path}
              onChanged={() => setRefreshKey((key) => key + 1)}
            />
          </div>
        );
      case "settings":
        return renderSettings();
      default:
        return null;
    }
  };

  // 设置面板（有工作区上下文 = 工作区分区 slot；零可用工作区 = 重启用逃生口）。
  const renderSettings = () => (
    <SettingsPanel
      page={settingsPage}
      onPageChange={setSettingsPage}
      workspace={activeWorkspace}
      settingsCwd={settingsCwd ?? ""}
      workspaceSlot={(
        <WorkspaceManager
          open
          embedded
          panel
          initialSection="workspaces"
          activeWorkspacePath={activeWorkspace?.path ?? null}
          openRepositoryFormRequest={openRepositoryFormRequest}
          selectWorkspaceRequest={workspaceSettingsRequest}
          onClose={() => {}}
          onOpenWorkspace={(workspace) => openNewSessionTab(workspace)}
          onOpenWorkItemConversation={handleOpenWorkItemConversation}
          onRunLoopRound={handleRunLoopRound}
          onRunContract={handleRunContract}
          onOpenConversation={handleOpenConversation}
          onWorkspaceDeleted={handleWorkspaceDeleted}
          onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
        />
      )}
      onOpenArchive={activeWorkspace ? () => setMobilePage("archive") : undefined}
      onWorkspaceSkillsChange={(updated) => {
        s.setWorkspaces((current: WorkspaceSummary[]) =>
          current.map((w) => (w.id === updated.id ? updated : w)),
        );
      }}
      onModelsSaved={() => s.setModelsRefreshKey((key) => key + 1)}
      onPluginsReloaded={() => s.setSessionKey((key) => key + 1)}
      sessionId={selectedSession?.id ?? null}
      onCloseOverlay={() => setMobilePage(null)}
    />
  );

  return (
    <div
      style={{
        display: "flex", flexDirection: "row",
        height: "var(--app-vh)", overflow: "hidden", background: "var(--bg)",
        // black-translucent 沉浸式状态栏：根容器统一让出安全区（底部无 tab 栏，
        // 抽屉/面板各自的 safe-area 自理）。
        paddingTop: "env(safe-area-inset-top)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        boxSizing: "border-box",
      }}
    >
      {/* ≥768px：树常驻贴左（推挤内容，不覆盖）；窄屏无此列 */}
      {showPermanentTree && (
        <aside
          style={{
            width: MOBILE_TREE_WIDTH, flexShrink: 0, height: "100%", minHeight: 0,
            borderRight: "1px solid var(--border)", background: "var(--bg-panel)",
          }}
        >
          <ProjectSidebar {...projectSidebarProps} />
        </aside>
      )}

      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, height: "100%" }}>
        <ChatToolbar navToggle={showPermanentTree ? "hidden" : "drawer"} />

        {/* Main area — 聊天持久挂载（SSE 跨页切换不断），目的地页全屏覆盖其上，
            文件 overlay 再其上（z40，现有机制不变）。 */}
        <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
          {!activeWorkspace ? (
            /* 零可用工作区分支（冷启动 / 全部停用）：设置目的地仍要可达
               （设置›工作区是重启用唯一入口——HomeLanding ⚙ 落这里）；其余
               交给 HomeLanding 引导 / 历史首页会话路径。 */
            mobilePage === "settings" ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
                {renderSettings()}
              </div>
            ) : s.homeSession ? (
              <ChatWindow
                reloadSignal={s.sessionKey}
                session={s.homeSession}
                newSessionCwd={null}
                onAgentEnd={s.handleAgentEnd}
                onOpenFile={s.handleOpenLinkedFile}
                onOpenSession={s.handleOpenSessionViewer}
                modelsRefreshKey={s.modelsRefreshKey}
                chatInputRef={s.chatInputRef}
              />
            ) : s.homeNewSession.open ? (
              <HomeNewSession
                workspaces={workspaces}
                selectedWorkspaceId={s.homeNewSession.workspaceId}
                onSelectWorkspace={s.handleHomeNewSessionSelect}
                onSessionCreated={s.handleHomeSessionCreated}
                onCreateWorkspace={handleCreateWorkspace}
                modelsRefreshKey={s.modelsRefreshKey}
                chatInputRef={s.chatInputRef}
              />
            ) : workspaces.some(isWorkspaceSelectable) ? (
              /* 空态只可能是「自动落 composer 还没轮到」（同帧 effect 接住）——
                 渲染极简占位，不闪落地页。 */
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
                …
              </div>
            ) : (
              <HomeLanding
                sessions={s.sessionActivity.sessions}
                workspaces={workspaces}
                refreshKey={refreshKey}
                onSelectWorkspace={(workspace) => { openNewSessionTab(workspace); }}
                onCreateWorkspace={handleCreateWorkspace}
                onImportDirectory={() => setImportPickerOpen(true)}
                onSelectSession={s.handleOpenSessionFromHome}
                onNewSession={s.handleHomeNewSession}
                runningSessionIds={s.sessionActivity.runningIds}
                onOpenSettings={() => setMobilePage("settings")}
                onOpenWorkspaceSettings={(workspace) => {
                  requestWorkspaceSettings(workspace);
                  setMobilePage("settings");
                }}
              />
            )
          ) : (
            <>
              <div
                style={{
                  position: "absolute", inset: 0,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {renderChat()}
              </div>
              {mobilePage !== null && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
                  {renderPageContent()}
                </div>
              )}

              {/* File viewer / session viewer overlay — full-screen（文件打开
                  管线不变；closing the last file tab dismisses the overlay
                  without flipping rightPanelOpen）。 */}
              {rightPanelOpen && activeFileTab && (
                <div style={{
                  position: "absolute", inset: 0, zIndex: 40,
                  display: "flex", flexDirection: "column",
                  background: "var(--bg)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <TabBar
                        tabs={fileTabs}
                        activeTabId={activeFileTabId ?? ""}
                        onSelectTab={(id: string) => updateActiveTab({ activeFileTabId: id })}
                        onCloseTab={handleCloseFileTab}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => updateActiveTab({ rightPanelOpen: false })}
                      title="关闭"
                      aria-label="关闭文件面板"
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 36, height: 36, padding: 0, flexShrink: 0,
                        background: "none", border: "none", borderLeft: "1px solid var(--border)",
                        color: "var(--text-muted)", cursor: "pointer",
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    {activeFileTab?.kind === "file" ? (
                      <FileViewer
                        filePath={activeFileTab.filePath}
                        cwd={activeCwd ?? undefined}
                        sourceSessionId={activeFileTab.sourceSessionId}
                        gitRefreshKey={explorerRefreshKey}
                        initialDisplayMode={activeFileTab.initialDisplayMode}
                        onOpenFile={(filePath: string) => handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: activeFileTab.sourceSessionId })}
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
              )}
            </>
          )}
        </div>
      </div>

      {/* 抽屉（窄屏 only；宽屏树常驻、无抽屉）：scrim + 滑入面板。点目标即关
          （各 handler 内 closeDrawer）/ 点遮罩即关。 */}
      {drawerOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000 }}>
          <div
            aria-hidden="true"
            onClick={closeDrawer}
            className="mobile-nav-scrim"
            style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }}
          />
          <aside
            role="dialog"
            aria-label="导航"
            className="mobile-nav-drawer"
            style={{
              position: "absolute", top: 0, bottom: 0, left: 0,
              width: "min(300px, 85vw)",
              background: "var(--bg)", borderRight: "1px solid var(--border)",
              boxShadow: "0 0 30px rgba(0,0,0,0.3)",
              paddingTop: "env(safe-area-inset-top, 0px)",
            }}
          >
            <ProjectSidebar {...projectSidebarProps} />
          </aside>
        </div>
      )}
    </div>
  );
}
