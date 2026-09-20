"use client";

import { useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar, FILES_TAB_ID } from "../TabBar";
import { FilesExplorerPanel } from "../FilesExplorerPanel";
import { ArchiveModal } from "../ArchiveModal";
import { WorkspaceManager } from "../WorkspaceManager";
import { WorkspaceOverview } from "../WorkspaceOverview";
import { ProjectSidebar } from "../ProjectSidebar";
import { PanelHeader } from "../PanelHeader";
import { SettingsPanel } from "../SettingsPanel";
import { ModelsConfig } from "../ModelsConfig";
import { SkillsConfig } from "../SkillsConfig";
import { PluginsConfig } from "../PluginsConfig";
import { LoopsDockPanel } from "../LoopsDockPanel";
import { HomeNewSession } from "../HomeNewSession";
import { defaultHomeNewSessionWorkspaceId, workspaceForSession } from "@/lib/home-quick-switch";
import { LOOPS_TAB_ID, KNOWLEDGE_TAB_ID, WORK_ITEMS_TAB_ID, isModuleTabId } from "@/lib/tab-types";
import { SessionTabBar } from "../SessionTabBar";
import { KnowledgeBrowser } from "../KnowledgeBrowser";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import { useShell } from "./context";
import type { SessionTabState } from "@/lib/session-tabs";
import { ChatToolbar } from "./ChatToolbar";

/**
 * The desktop shell（2026-09 树形侧栏改版，grill 共识）：左侧单一项目树侧栏
 * （ProjectSidebar：新建任务 / 项目→会话 / 组尾归档 / 底部设置·模型·插件·
 * Skills 四入口）+ 中央区（ChatToolbar + SessionTabBar + 总览|聊天|配置整页）
 * + 右坞（文件/Loops/知识库/工作项 + 文件 tab，不变）。图标栏与「中栏面板」
 * 已退役——原 configView 三列 split（列表中栏 + 详情 portal 右栏）由中央区
 * 整页（CenterPage）取代。所有状态来自共享 shell context；本组件只拥有
 * 中央区页面的渲染分派。
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
    handleFileLineMention,
    setOpenRepositoryFormRequest,
    explorerRefreshKey,
    createWorkItemRequest,
    openRepositoryFormRequest,
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
    setImportPickerOpen,
  } = s;

  // Loop 配置变更 → 总览 Loops 区块刷新信号（创建/删除/frontmatter 保存后 bump）。
  const [loopsRefreshKey, setLoopsRefreshKey] = useState(0);

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
  // Right dock（design S1）：activeFileTabId 的值域 = 文件/会话 tab id + 钦死模块
  // tab id（文件/Loops）。模块 id 永不在 fileTabs 里——文件 tab 不活时它指向当前
  // 模块；非模块非文件 id（陈旧值）安全回落到文件树。模块内容跟工作区（决策 #6）：
  // 两个模块体常驻挂载（display:none 隐藏），LoopsDockPanel 以 key=workspace.id
  // 重置——同工作区切会话 tab 状态存活，换工作区才重建。
  const panelEffTabId = panelActiveFileTabId ?? FILES_TAB_ID;
  const dockActiveModule = !panelActiveFileTab && isModuleTabId(panelEffTabId) ? panelEffTabId : null;
  const showFilesTree = Boolean(panelWorkspace) && !panelActiveFileTab
    && (panelEffTabId === FILES_TAB_ID || !isModuleTabId(panelEffTabId));

  // ---- 中央区整页（CenterPage）------------------------------------------------
  // 底部四入口（设置/模型/插件/Skills）与项目树「归档」行的渲染面：整页占中央
  // 区（列表 + 详情并排），tab 条保持可见——点任何会话 tab 即关闭回聊天。
  // 设置整页 = SettingsPanel（desktop 模式：索引 + 子页面板内推进航，工作区
  // 子页的 inline-split WorkspaceManager 经 workspaceSlot 注入）。
  const closeCenterPage = () => setCenterPage(null);

  const renderCenterPage = () => {
    const page = centerPage;
    if (!page) return null;

    if (page.kind === "settings") {
      return (
        <SettingsPanel
          desktop
          page={settingsPage}
          onPageChange={setSettingsPage}
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
          onCloseOverlay={closeCenterPage}
        />
      );
    }

    const titles = { models: "模型", skills: "Skills", plugins: "插件" } as const;
    if (page.kind === "models" || page.kind === "skills" || page.kind === "plugins") {
      const title = titles[page.kind];
      const meta = page.kind === "models"
        ? "~/.pi/agent/models.json"
        : settingsCwd ?? undefined;
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <PanelHeader title={title} meta={meta} onClose={closeCenterPage} />
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {page.kind === "models" ? (
              <ModelsConfig inline onSaved={() => setModelsRefreshKey((key) => key + 1)} onClose={closeCenterPage} />
            ) : page.kind === "skills" ? (
              <SkillsConfig
                inline
                cwd={settingsCwd ?? ""}
                globalOnly={!activeWorkspace}
                workspace={activeWorkspace}
                onWorkspaceSkillsChange={(updated) => {
                  setWorkspaces((current) =>
                    current.map((w) => (w.id === updated.id ? updated : w)),
                  );
                }}
                onClose={closeCenterPage}
              />
            ) : (
              <PluginsConfig
                inline
                cwd={settingsCwd ?? ""}
                sessionId={selectedSession?.id ?? null}
                onReloaded={() => setSessionKey((key) => key + 1)}
                onClose={closeCenterPage}
              />
            )}
          </div>
        </div>
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
<div style={{ display: "flex", height: "var(--app-vh)", overflow: "hidden", background: "var(--bg)", boxSizing: "border-box" }}>
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
        "--pi-sidebar-width": `${sidebarWidth}px`,
      } as React.CSSProperties}
    >
      <ProjectSidebar
        workspaces={workspaces}
        allSessions={sessionActivity.sessions}
        runningSessionIds={sessionActivity.runningIds}
        completedSessionIds={sessionActivity.completedIds}
        selectedSessionId={selectedSession?.id ?? homeSession?.id ?? null}
        centerPage={centerPage}
        workspacesLoaded={workspacesLoaded}
        sessionsLoaded={sessionActivity.loaded}
        onNewSession={() => {
          if (activeWorkspace) handleWorkspaceNewSession();
          else handleReturnHome();
        }}
        onSelectSession={handleSelectSession}
        onOpenSessionInNewTab={openSessionTab}
        onSessionRemoved={handleSessionRemoved}
        onCreateWorkspace={handleCreateWorkspace}
        onImportDirectory={() => setImportPickerOpen(true)}
        onOpenCenterPage={openCenterPage}
        workspaceActivity={workspaceActivity}
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

      <SessionTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        workspaces={workspaces}
        runningIds={sessionActivity.runningIds}
        completedIds={sessionActivity.completedIds}
        workspaceActivity={workspaceActivity}
        onSelectHome={handleReturnHome}
        onSelectTab={(id: string) => {
          if (id !== activeTabId) handleSelectTab(id);
        }}
        onCloseTab={closeTab}
        onCloseTabs={closeTabs}
        onReorder={(ids: string[]) => setTabs((prev) => ids.map((id) => prev.find((t) => t.id === id)).filter((t): t is SessionTabState => Boolean(t)))}
        onNewSession={handleTabBarNewSession}
      />

      {/* Main content: 中央区整页（CenterPage：设置/模型/插件/Skills/归档——
          点任何会话 tab 即关闭）优先于 总览/聊天/首页。 */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {centerPage ? renderCenterPage() : activeTab?.kind === "workspace-home" ? (
          <WorkspaceOverview
            workspace={activeTab.workspace}
            onNewSession={handleWorkspaceNewSession}
            onOpenSettings={() => {
              setOpenRepositoryFormRequest(undefined);
              setCenterPage({ kind: "settings" });
              setSettingsPage("workspace");
            }}
            onOpenWorkItems={() => updateActiveTab({ activeFileTabId: WORK_ITEMS_TAB_ID, rightPanelOpen: true })}
            onCreateWorkItem={handleCreateWorkItem}
            onSelectSession={handleSelectSession}
            onSwitchSidebarView={(view) => {
              // 仓库行 → 激活右坞「文件」tab；知识库行 → 右坞「知识库」tab
              // （S2 收编：hub knowledge 子视图已退役）。
              updateActiveTab({
                activeFileTabId: view === "knowledge" ? KNOWLEDGE_TAB_ID : FILES_TAB_ID,
                rightPanelOpen: true,
              });
            }}
            onAddRepository={() => {
              setCenterPage({ kind: "settings" });
              setSettingsPage("workspace");
              setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
            }}
            onSessionDeleted={handleSessionRemoved}
            onOpenLoopsTab={() => updateActiveTab({ activeFileTabId: LOOPS_TAB_ID, rightPanelOpen: true })}
            loopsRefreshKey={loopsRefreshKey}
          />
        ) : showChat ? (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <ChatWindow
                reloadSignal={sessionKey}
                session={selectedSession}
                newSessionCwd={effectiveNewSessionCwd}
                draftKeyOverride={activeTab?.kind === "new-session" ? activeTab.id : undefined}
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
        ) : !activeWorkspace ? (
          homeSession ? (
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
      {/* Right dock tab bar（design S1）—— 钦死模块 tab（文件/Loops；窄面板时
          图标化，见 globals.css 的 @container 规则）+ 文件/会话 tab。模块 tab
          永不关闭；关到最后一个文件 tab 回落到「文件」树（handleCloseFileTab
          现状语义）。 */}
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}
      >
        <div style={{ flex: 1, overflow: "hidden" }}>
          <TabBar
            tabs={panelFileTabs}
            activeTabId={panelActiveFileTabId ?? FILES_TAB_ID}
            leadingTabs={panelWorkspace ? [
              { id: FILES_TAB_ID, label: "文件" },
              {
                id: LOOPS_TAB_ID,
                label: "Loops",
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                    <path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
                  </svg>
                ),
              },
              ...(panelWorkspace.capabilities.includes("knowledge") ? [{
                id: KNOWLEDGE_TAB_ID,
                label: "知识库",
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                ),
              }] : []),
              ...(panelWorkspace.capabilities.includes("work-items") ? [{
                id: WORK_ITEMS_TAB_ID,
                label: "工作项",
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                ),
              }] : []),
            ] : undefined}
            onSelectTab={(id: string) => (homeAtDesktop ? setHomeActiveFileTabId(id) : updateActiveTab({ activeFileTabId: id }))}
            onCloseTab={homeAtDesktop ? handleCloseHomeFileTab : handleCloseFileTab}
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
