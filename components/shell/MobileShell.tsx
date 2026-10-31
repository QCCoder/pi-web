"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { createNewSessionTab, tabQuery } from "@/lib/session-tabs";
import type { CenterPage } from "./useAppShellState";
import { defaultHomeNewSessionWorkspaceId } from "@/lib/home-quick-switch";
import { isWorkspaceSelectable } from "@/lib/workspaces/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useShell } from "./context";
import { ChatToolbar } from "./ChatToolbar";
import { MobileTabShell } from "./MobileTabShell";
import { WorkspaceModuleIcon, workspaceModuleEntries } from "./workspace-modules";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { getFileName } from "@/lib/file-paths";

/**
 * 平板壳（≥768px；2026-10 底部 tab 改版后本组件只负责宽视口形态，窄视口
 * <768px 整体委托给 MobileTabShell——见 knowledge/designs/mobile-drawer-design.md 文末补充
 * 记录）。历史：2026-09 树抽屉重构 + 2026-09-27 侧栏瘦身把它定型为「抽屉 +
 * 目的地页」，抽屉形态只在 <768px 存在，所以此次把窄屏交给 tab 壳后，抽屉
 * JSX / Android 返回陷阱 / 边缘右滑三段随之删除，≥768px 行为零改动。
 *
 *   ≥768px（平板/横屏/折叠展开）：ProjectSidebar 常驻贴左（推挤内容，不覆盖，
 *   头部模块条 总览/文件/工作项/知识库/Loops 作用于当前工作区）+ ChatToolbar
 *   （☰ 隐藏 + 居中标题 + 统计 + ⋯）+ 全屏主区。聊天永远是主区默认态；
 *   总览/文件/工作项/知识库/Loops/设置/归档是带 ‹返回 的全屏目的地页，返回
 *   永远 = 回聊天（扁平导航，深层导航留在各面板内部）。
 *
 *   <768px：`return <MobileTabShell />`（在全部 hooks 之后；本组件 mobilePage
 *   相关 effect 在窄屏下照跑但不渲染，无副作用）。跨 768 断点往返：共享层的
 *   会话/tab/工作区状态与 mobileTab 保留，两壳各自的局部页态（mobilePage /
 *   pushStack）重置。
 *
 * 上下文规则（§4.2「跟着屏幕走」）：面板里以工作区 W 为目标的动作 =
 *   ensureWorkspaceContext(W)（幂等建/激活 W 锚定占位 tab，纯状态）+ 目的地；
 *   会话行点击走 handleSelectSession（自带 focusChat → 关目的地页）。切工作区
 *   与 PC 对齐 = 落该工作区总览（mobilePage:"overview"，2026-09-27）。
 *
 * 聊天持久挂载（目的地页以不透明层覆盖其上，不卸载）保证 SSE 与流式气泡跨
 * 页面切换不断；HomeLanding 只剩一个职责：零可用工作区时的创建/重启用引导。
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
    setCreateWorkItemRequest,
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
    centerPage,
    setCenterPage,
    navigateUrl,
    openWorkItemsPage,
    workItemsItemKeyRef,
  } = s;

  // ---- 目的地页（扁平导航：null = 聊天；‹返回 永远 = 回聊天）--------------
  const [mobilePage, setMobilePage] = useState<MobilePage | null>(null);
  // LoopsDockPanel 的变更信号：创建/删除/保存后 bump → 重新拉取。
  const [loopsRefreshKey, setLoopsRefreshKey] = useState(0);

  // ---- work-items 深链 → 目的地页映射（fix wave）---------------------------
  // applyUrlToTabs 对 ?page=work-items 写 centerPage {kind:"work-items"}（两壳
  // 共用），但移动端没有中央区整页——不映射的话手机深链落在聊天、URL 与界面
  // 不一致，且滞留的 centerPage 压住空态自动落 composer。presence→destination：
  // centerPage 是 work-items ⇒ mobilePage 落 work-items 目的地页并记 deeplink
  // 来源；离开该 kind（activateTab / popstate / 页内 ‹返回）⇒ 只收回**自己设的**
  // 目的地页（用户此后若已导航去别处/自行重进工作项页，则不动）。
  const workItemsDeeplinkActive = centerPage?.kind === "work-items";
  const workItemsDeeplinkAutoRef = useRef(false);
  useEffect(() => {
    if (workItemsDeeplinkActive) {
      workItemsDeeplinkAutoRef.current = true;
      setMobilePage((page) => (page === "work-items" ? page : "work-items"));
      return;
    }
    if (workItemsDeeplinkAutoRef.current) {
      workItemsDeeplinkAutoRef.current = false;
      setMobilePage((page) => (page === "work-items" ? null : page));
    }
  }, [workItemsDeeplinkActive]);
  /** 关深链工作项页：清 centerPage + URL 回写活动 tab 投影（与桌面
   *  closeCenterPage 同构——URL 说 page=work-items，关页必须让 URL 与状态
   *  一致，否则刷新复活已关闭的页面）。mobilePage 的收回由上面的映射 effect
   *  接手（deeplink-auto 标记）。 */
  const closeWorkItemsDeeplink = useCallback(() => {
    setCenterPage(null);
    navigateUrl(activeTab ? tabQuery(activeTab) : "tab=home");
  }, [setCenterPage, navigateUrl, activeTab]);

  // ---- overview 深链 → 目的地页映射（2026-10 总览整页化）---------------------
  // applyUrlToTabs 对 ?workspace=<id>[&view=overview] 写 centerPage
  // {kind:"overview"}（桌面 = 总览整页，knowledge/designs/overview-center-page-design.md
  // D11）；移动端的总览是 mobilePage:"overview" 目的地页。presence→destination：
  // 进入该工作区上下文（ensureWorkspaceContext 幂等建/激活占位 tab）+ 落总览
  // 目的地页 + 清 centerPage（ensureWorkspaceContext 已在上下文时不 activateTab，
  // 需显式清，否则 overview centerPage 滞留压住状态）。工作区不可用 → 只清。
  const overviewDeeplinkWorkspaceId = centerPage?.kind === "overview" ? centerPage.workspaceId : null;
  useEffect(() => {
    if (!overviewDeeplinkWorkspaceId) return;
    const workspace = workspaces.find((w) => w.id === overviewDeeplinkWorkspaceId);
    if (workspace && isWorkspaceSelectable(workspace)) {
      ensureWorkspaceContext(workspace);
      setMobilePage("overview");
    }
    setCenterPage(null);
  }, [overviewDeeplinkWorkspaceId, workspaces, ensureWorkspaceContext, setCenterPage]);

  // ---- 会话全文搜索深跳转（与 DesktopShell 同机制，壳自有）----------------
  // 搜索结果行选择会话时先记下 entryId/blockIndex，再走常规
  // handleSelectSession 打开会话；ChatWindow 定位完成后经
  // handleSearchTargetHandled 注销（按 target 身份比较）。
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => (current === target ? null : current));
  }, []);

  // 宽视口（≥768px）且存在工作区 → 树常驻贴左；<768px 整体委托 MobileTabShell
  // （见组件文档；委托 return 放在全部 hooks 之后）。
  const wide = useMediaQuery("(min-width: 768px)");
  const showPermanentTree = wide && workspaces.length > 0;

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

  // ---- 空态自动落回（首页退役语义）------------------------------------------
  // 没有任何 tab（冷启动 / 会话删除自动关掉最后一个）→ 给默认工作区开一个
  // 占位 composer 作为上下文锚（= 事实首页）。replace 写 URL，不给浏览器
  // 历史埋可 popstate 回跳的陷阱。零可用工作区时不动：HomeLanding 引导接手。
  // 窄屏由 MobileTabShell 自带同义 effect（它用 ensureWorkspaceContext 不落聊天），
  // 本 effect 只在宽视口生效，避免两壳抢着写 URL。
  useEffect(() => {
    if (!wide) return;
    if (!navReady || activeTabId !== null) return;
    // 中央区整页（如 work-items 深链）打开时不做空态自动落 composer——
    // openNewSessionTab 会清 centerPage 并改写 URL，吃掉深链。
    if (s.centerPage) return;
    if (s.homeSession || s.homeNewSession.open) return;
    const targetId = defaultHomeNewSessionWorkspaceId(workspaces, s.sessionActivity.sessions, s.mruIds);
    const target = workspaces.find((w) => w.id === targetId);
    if (!target || !isWorkspaceSelectable(target)) return;
    openNewSessionTab(target, { replace: true });
  }, [wide, navReady, activeTabId, s.centerPage, s.homeSession, s.homeNewSession.open, workspaces, s.sessionActivity.sessions, s.mruIds, openNewSessionTab]);

  // ---- 常驻树头部的模块条（2026-09-27 晚：工作区切换器撤下——分组会话清单
  // 已列全部项目，点会话即切上下文；模块入口保留为紧凑图标条）--------------
  const handleNavNewSession = useCallback(() => {
    setMobilePage(null);
    if (activeWorkspace) handleWorkspaceNewSession();
  }, [activeWorkspace, handleWorkspaceNewSession]);
  const handleNavSelectSession = useCallback((session: SessionInfo) => {
    handleSelectSession(session);
  }, [handleSelectSession]);
  const handleNavSelectSearchHit = useCallback((session: SessionInfo, entryId?: string, blockIndex?: number) => {
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    handleSelectSession(session);
  }, [handleSelectSession]);
  const handleNavModule = useCallback((workspace: WorkspaceSummary, module: "files" | "work-items" | "knowledge" | "loops") => {
    ensureWorkspaceContext(workspace);
    // 用户自驱进入工作项目的地页 = 深链自动态让位：ensureWorkspaceContext 的
    // activateTab 会清 centerPage，若不摘 deeplink-auto 标记，深链映射 effect
    // 的 absence 分支会把用户刚点开的工作项页误收回聊天。
    if (module === "work-items") workItemsDeeplinkAutoRef.current = false;
    setMobilePage(module);
  }, [ensureWorkspaceContext]);
  const handleNavArchive = useCallback((workspace: WorkspaceSummary) => {
    ensureWorkspaceContext(workspace);
    setMobilePage("archive");
  }, [ensureWorkspaceContext]);
  const handleNavCenterPage = useCallback((page: CenterPage) => {
    // 平板没有中央区整页（2026-09 配置页拆分是桌面侧的改版）：四个配置
    // 导航统一落设置目的地页的对应子页——设置=工作区，模型/插件/Agents=同名
    // 子页（插件&技能页的技能分区经设置页索引进入）。
    if (page.kind === "settings" || page.kind === "models" || page.kind === "agents" || page.kind === "plugins") {
      setMobilePage("settings");
      setSettingsPage(page.kind === "settings" ? "workspace" : page.kind);
    }
  }, [setSettingsPage]);

  // ---- 模块条条目（常驻树头部，作用于当前工作区）：目的地页语义，active 高亮
  // 跟 mobilePage。条目出自 workspaceModuleEntries 注册表（图标/门控唯一出处——
  // 与手机壳聊天页/工作区页两处 ⋯ 菜单同一份；overview 仅平板模块条需要）。
  const switcherModuleEntries: SwitcherModuleEntry[] = activeWorkspace
    ? workspaceModuleEntries(activeWorkspace, { overview: true }).map((entry) => ({
        id: entry.id,
        label: entry.label,
        icon: <WorkspaceModuleIcon kind={entry.id} size={14} />,
        active: mobilePage === entry.id,
        onClick: () => {
          if (entry.id === "overview") setMobilePage("overview");
          else handleNavModule(activeWorkspace, entry.id as "files" | "work-items" | "knowledge" | "loops");
        },
      }))
    : [];

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
    // 项目分组行长按拖拽排序（与桌面同处理器：全量 PATCH + 重拉）。
    onReorderWorkspaces: s.handleReorderWorkspaces,
    // 分组头项目头像 → 项目首页：切上下文 + 落总览目的地页（与顶部模块条
    // 「总览」同语义）。
    onOpenWorkspaceHome: (workspace: WorkspaceSummary) => {
      ensureWorkspaceContext(workspace);
      setMobilePage("overview");
    },
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
                sessions={sessionActivity.sessions}
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
        if (centerPage?.kind === "work-items") {
          // 深链/中央页形态（fix wave）：页面身份绑定 centerPage.workspaceId
          // （spec §6.1，深链可指向非当前 tab 的工作区，不用 activeWorkspace 代
          // 替）；item 深链经 initialItemKey 透传（消费后清 ref）。‹返回/✕ =
          // 关深链页（清 centerPage + URL 回写——URL 说 page=work-items，关页
          // 必须让 URL 与状态一致，否则刷新复活）；「查看会话」走既有 locate
          // 管道（openSessionTab 的 activateTab 清 centerPage → 映射 effect 收
          // 回目的地页，失败则页面留在原地，与桌面一致）；页头工作区切换（平板
          // 形态）复用 openWorkItemsPage（replace 写 URL，不埋历史陷阱）。
          return (
            <WorkItemsPage
              key={centerPage.workspaceId}
              workspaceId={centerPage.workspaceId}
              initialItemKey={workItemsItemKeyRef.current}
              onOpenConversation={handleOpenConversation}
              onOpenLoopsRecovery={() => {
                closeWorkItemsDeeplink();
                setMobilePage("loops");
              }}
              onConsumedInitialItem={() => { workItemsItemKeyRef.current = null; }}
              onBack={closeWorkItemsDeeplink}
              onClose={closeWorkItemsDeeplink}
              backLabel="聊天"
              onOpenWorkItemsPage={openWorkItemsPage}
              onReplaceUrl={(query) => navigateUrl(query, true)}
              workspaces={workspaces}
            />
          );
        }
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
            onConsumedCreateRequest={() => setCreateWorkItemRequest(null)}
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
        /* 角色表「编辑剧本」（Task 4）经 onOpenAgentsSettings 落设置目的地页的
           Agents 子页——复用 handleNavCenterPage 的既有映射（关抽屉 +
           setMobilePage("settings") + setSettingsPage("agents")）；剧本预选记录
           由 WorkspaceManager 写 settings-navigation。 */
        <WorkspaceManager
          open
          embedded
          panel
          initialSection="workspaces"
          activeWorkspacePath={activeWorkspace?.path ?? null}
          openRepositoryFormRequest={openRepositoryFormRequest}
          selectWorkspaceRequest={workspaceSettingsRequest}
          onConsumedCreateRequest={() => setCreateWorkItemRequest(null)}
          onClose={() => {}}
          onOpenWorkspace={(workspace) => openNewSessionTab(workspace)}
          onOpenWorkItemConversation={handleOpenWorkItemConversation}
          onRunLoopRound={handleRunLoopRound}
          onRunContract={handleRunContract}
          onOpenAgentsSettings={() => handleNavCenterPage({ kind: "agents" })}
          onOpenConversation={handleOpenConversation}
          onWorkspaceDeleted={handleWorkspaceDeleted}
          onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
        />
      )}
      onOpenArchive={activeWorkspace ? () => setMobilePage("archive") : undefined}
      onModelsSaved={() => s.setModelsRefreshKey((key) => key + 1)}
      onPluginsReloaded={() => s.setSessionKey((key) => key + 1)}
      sessionId={selectedSession?.id ?? null}
      onCloseOverlay={() => setMobilePage(null)}
    />
  );

  // <768px：手机壳（底部 tab / 会话首页 / 工作区页 / 聊天推入），整体委托。
  // 放在全部 hooks 之后（React hooks 顺序对本组件所有渲染分支一致）。
  if (!wide) {
    return <MobileTabShell />;
  }

  return (
    <div
      style={{
        display: "flex", flexDirection: "row",
        height: "var(--app-vh)", overflow: "hidden", background: "var(--bg)",
        // black-translucent 沉浸式状态栏：根容器统一让出安全区（平板壳无底部
        // tab 栏，面板各自的 safe-area 自理；手机壳的 tab 栏见 MobileTabShell）。
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
        <ChatToolbar navToggle="hidden" />

        {/* Main area — 聊天持久挂载（SSE 跨页切换不断），目的地页全屏覆盖其上，
            文件 overlay 再其上（z40，现有机制不变）。 */}
        <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
          {!activeWorkspace ? (
            /* 零可用工作区分支（冷启动 / 全部停用）：设置目的地仍要可达
               （设置›工作区是重启用唯一入口——HomeLanding ⚙ 落这里）；其余
               交给 HomeLanding 引导 / 历史首页会话路径。work-items 深链例外：
               冷启动深链可能没有任何恢复 tab（activeTabId=null，空态自动落
               composer 又被 centerPage 抑制）——目的地页必须照常渲染。 */
            mobilePage === "work-items" && centerPage?.kind === "work-items" ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
                {renderPageContent()}
              </div>
            ) : mobilePage === "settings" ? (
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
    </div>
  );
}
