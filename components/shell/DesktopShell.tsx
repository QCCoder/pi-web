"use client";

import { useCallback } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar } from "../TabBar";
import { ArchiveModal } from "../ArchiveModal";
import { WorkspaceManager } from "../WorkspaceManager";
import { WorkspaceOverview } from "../WorkspaceOverview";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { ActivityBar } from "../ActivityBar";
import { PanelHeader } from "../PanelHeader";
import { SettingsPanel, PreferencesPage } from "../SettingsPanel";
import { ModelsConfig } from "../ModelsConfig";
import { SkillsConfig } from "../SkillsConfig";
import { PluginsConfig } from "../PluginsConfig";
import { LoopConfig } from "../LoopConfig";
import { LoopLaunchingPlaceholder } from "../LoopLaunchOverlay";
import { HomeLanding } from "../HomeLanding";
import { WorkspaceTabBar } from "../WorkspaceTabBar";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import { useShell } from "./context";
import type { WorkspaceTabState } from "./useAppShellState";
import { ChatToolbar } from "./ChatToolbar";

/**
 * The desktop shell — the three-column layout, migrated verbatim from the
 * former single AppShell render: activity rail + resizable middle column +
 * center column (toolbar / workspace tabs / overview|chat) + right file
 * panel. All state comes from the shared shell context; this component owns
 * nothing but the middle-column render helpers.
 */
export function DesktopShell() {
  const s = useShell();
  const { t: translate } = useI18n();

  const {
    tabs,
    setTabs,
    activeTab,
    activeWorkspace,
    selectedSession,
    workspaceView,
    selectedWorkItemKey,
    fileTabs,
    activeFileTabId,
    rightPanelOpen,
    activeCwd,
    sidebarView,
    configView,
    setConfigView,
    configPortalNode,
    setConfigPortalNode,
    settingsPage,
    setSettingsPage,
    settingsCwd,
    loopEditorOpen,
    setLoopEditorOpen,
    sidebarOpen,
    sidebarWidth,
    sidebarResizing,
    sidebarContainerRef,
    startSidebarResize,
    resetSidebarWidth,
    workspaces,
    setWorkspaces,
    workspaceSettingsName,
    workspaceActivity,
    setModelsRefreshKey,
    setSessionKey,
    handleOpenConfig,
    handleOpenSessionFromHome,
    handleCreateWorkItem,
    openSessionStatsPanel,
    handleFileLineMention,
    setOpenRepositoryFormRequest,
    refreshKey,
    explorerRefreshKey,
    createWorkItemRequest,
    openRepositoryFormRequest,
    sessionActivity,
    modelsRefreshKey,
    sessionKey,
    loopRun,
    effectiveNewSessionCwd,
    showChat,
    showPlaceholder,
    activeFileTab,
    handleRailSwitch,
    handleSidebarSwitchView,
    handleWorkspaceSettingsSelection,
    handleOpenWorkspace,
    handleCloseWorkspaceTab,
    handleCreateWorkspace,
    handleReturnHome,
    handleOpenLoopSession,
    handleLoopTriggered,
    handleWorkspaceNewSession,
    handleSelectSession,
    handleOpenWorkItemConversation,
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
    loadWorkspaces,
    setRefreshKey,
    setImportPickerOpen,
  } = s;

  // ---- Middle column content (three-column layout) ----------------------------
// One `sidebarView` drives everything: module views (workbench/knowledge/
// loop/work-items) render WorkspaceSidebar / the work-items manager; global
// panels (archive/settings) render the former modals as embedded panels.
// The loop editor (LoopConfig) replaces the loop list and temporarily widens
// the column — the widened value is derived, never persisted.
const middleColumnWidth = loopEditorOpen && sidebarView === "loop"
  ? Math.max(sidebarWidth, 520)
  : sidebarWidth;
const openLoopsPanel = useCallback(() => {
  setLoopEditorOpen(true);
}, [setLoopEditorOpen]);

const renderMiddleColumn = () => {
  // Desktop config views (模型/Skills/插件): the LIST renders here in the
  // middle column (under a PanelHeader like every other panel); the DETAIL
  // portals into the right column's config area (configPortalNode). Mobile
  // never sets configView — its settings subpages serve the same content
  // via the components' embedded mode.
  if (configView) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PanelHeader
          title={configView === "models" ? "模型" : configView === "skills" ? "Skills" : "插件"}
          meta={configView === "models" ? "~/.pi/agent/models.json" : settingsCwd ?? undefined}
        />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {configView === "models" ? (
            <ModelsConfig split={{ portalTarget: configPortalNode }} onSaved={() => setModelsRefreshKey((key) => key + 1)} />
          ) : configView === "skills" && settingsCwd ? (
            <SkillsConfig
              split={{ portalTarget: configPortalNode }}
              cwd={settingsCwd}
              globalOnly={!activeWorkspace}
              workspace={activeWorkspace}
              onWorkspaceSkillsChange={(updated) => {
                setWorkspaces((current) =>
                  current.map((w) => (w.id === updated.id ? updated : w)),
                );
              }}
            />
          ) : configView === "plugins" && settingsCwd ? (
            <PluginsConfig
              split={{ portalTarget: configPortalNode }}
              cwd={settingsCwd}
              sessionId={selectedSession?.id ?? null}
              onReloaded={() => setSessionKey((key) => key + 1)}
            />
          ) : null}
        </div>
      </div>
    );
  }
  // Global settings panel works at home too (workspace subpage hidden).
  if (sidebarView === "settings") {
    return (
      <SettingsPanel
        page={settingsPage}
        onPageChange={setSettingsPage}
        workspace={activeWorkspace}
        settingsCwd={settingsCwd ?? ""}
        workspaceSlot={activeWorkspace ? (
          // The manager is mounted whenever settings is open — its rail
          // (workspace list) shows BELOW the index rows only while the
          // 工作区 row is active; its detail portals to the right column.
          settingsPage === "workspace" ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", borderTop: "1px solid var(--border)", marginTop: 8 }}>
              <WorkspaceManager
                open
                embedded
                initialSection="workspaces"
                split={{ portalTarget: configPortalNode }}
                onSelectedWorkspaceChange={handleWorkspaceSettingsSelection}
                activeWorkspacePath={activeWorkspace.path}
                openRepositoryFormRequest={openRepositoryFormRequest}
                onClose={() => {}}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenWorkItemConversation={handleOpenWorkItemConversation}
                onRunContract={handleRunContract}
                onOpenConversation={handleOpenLoopSession}
                onWorkspaceDeleted={handleWorkspaceDeleted}
                onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
                onWorkspaceChanged={() => void loadWorkspaces()}
              />
            </div>
          ) : null
        ) : null}
        onOpenArchive={activeWorkspace ? () => handleSidebarSwitchView("archive") : undefined}
        onWorkspaceSkillsChange={(updated) => {
          setWorkspaces((current) =>
            current.map((w) => (w.id === updated.id ? updated : w)),
          );
        }}
        onPluginsReloaded={() => setSessionKey((k) => k + 1)}
        onModelsSaved={() => setModelsRefreshKey((k) => k + 1)}
        sessionId={selectedSession?.id ?? null}
        // The 模型/Skills/插件 index rows open the right-column config views
        // instead of in-panel subpages (desktop three-column split).
        onOpenConfigView={handleOpenConfig}
      />
    );
  }
  if (activeWorkspace && sidebarView === "archive") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PanelHeader
          title="归档"
          meta={activeWorkspace.name}
        />
        <ArchiveModal
          embedded
          workspaceId={activeWorkspace.id}
          workspacePath={activeWorkspace.path}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
      </div>
    );
  }
  if (activeWorkspace && sidebarView === "work-items") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PanelHeader
          title="工作项"
          meta={activeWorkspace.name}
        />
        <WorkspaceManager
          open
          embedded
          panel
          initialSection="work-items"
          activeWorkspacePath={activeWorkspace.path}
          initialWorkItemKey={selectedWorkItemKey}
          createWorkItemRequest={createWorkItemRequest}
          onClose={() => {}}
          onOpenWorkspace={handleOpenWorkspace}
          onOpenWorkItemConversation={handleOpenWorkItemConversation}
          onRunContract={handleRunContract}
          onOpenConversation={handleOpenLoopSession}
          onWorkspaceDeleted={handleWorkspaceDeleted}
          onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
          onWorkspaceChanged={() => void loadWorkspaces()}
        />
      </div>
    );
  }
  if (activeWorkspace && sidebarView === "loop" && loopEditorOpen && activeWorkspace.capabilities.includes("loop")) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PanelHeader
          title="Loop 管理"
          onBack={() => setLoopEditorOpen(false)}
          backLabel="返回"
        />
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <LoopConfig workspace={activeWorkspace} onWorkspaceChanged={() => void loadWorkspaces()} onTriggered={handleLoopTriggered} />
        </div>
      </div>
    );
  }
  // Module views (workbench / knowledge / loop list) + the home panel.
  return (
    <WorkspaceSidebar
      activeWorkspace={activeWorkspace}
      activeView={sidebarView}
      workspaces={workspaces}
      selectedSessionId={selectedSession?.id ?? null}
      runningSessionIds={sessionActivity.runningIds}
      completedSessionIds={sessionActivity.completedIds}
      allSessions={sessionActivity.sessions}
      refreshKey={refreshKey}
      explorerRefreshKey={explorerRefreshKey}
      onSelectWorkspace={handleOpenWorkspace}
      onCreateWorkspace={handleCreateWorkspace}
      onImportDirectory={() => setImportPickerOpen(true)}
      onOpenLoops={openLoopsPanel}
      onOpenLoopSession={handleOpenLoopSession}
      onTriggerLoop={handleLoopTriggered}
      onAddRepository={() => {
        handleSidebarSwitchView("settings");
        setSettingsPage("workspace");
        setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
      }}
      onNewSession={handleWorkspaceNewSession}
      onSelectSession={handleSelectSession}
      onOpenFile={handleOpenFile}
      onSessionRemoved={(id) => {
        updateActiveTab((tab) => (tab.session?.id === id ? { session: null } : {}));
        setRefreshKey((k) => k + 1);
      }}
    />
  );
  };

  return (
    <>
<div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)", boxSizing: "border-box" }}>
    {/* Left icon rail (desktop) — module views + separator + global group
        (模型/Skills/插件 config icons + archive + bottom-pinned settings).
        A config icon highlights while its split view is open (configView
        takes precedence over the middle-column panel). Sits OUTSIDE the
        resizable middle column — always visible when closed. */}
      <ActivityBar
        variant="vertical"
        activeView={configView ?? sidebarView}
        capabilities={activeWorkspace?.capabilities ?? []}
        onSwitch={handleRailSwitch}
        hasWorkspace={Boolean(activeWorkspace)}
        highlightView={loopEditorOpen ? "loop" : null}
      />

    {/* Middle column: the single focused panel (module views, global panels,
        config lists). Width is drag-resizable via the handle below. */}
    <div
      ref={sidebarContainerRef}
      className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${sidebarResizing ? " sidebar-resizing" : ""}`}
      style={{
        background: "var(--bg-panel)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        zIndex: 200,
        "--pi-sidebar-width": `${middleColumnWidth}px`,
      } as React.CSSProperties}
    >
      {renderMiddleColumn()}
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

      <WorkspaceTabBar
        workspaces={workspaces}
        tabIds={tabs.map((t) => t.id)}
        activeWorkspaceId={activeWorkspace?.id ?? null}
        activityByWorkspaceId={workspaceActivity}
        onSelectHome={handleReturnHome}
        onSelectWorkspace={handleOpenWorkspace}
        onCloseWorkspace={handleCloseWorkspaceTab}
        onReorder={(ids: string[]) => setTabs((prev) => ids.map((id) => prev.find((t) => t.id === id)).filter((t): t is WorkspaceTabState => Boolean(t)))}
        onCreateWorkspace={handleCreateWorkspace}
      />

      {/* Main content: a config view (模型/Skills/插件 — desktop rail icons)
          renders its DETAIL here; its LIST lives in the middle column and
          portals the detail into this container via configPortalNode. The
          settings › 工作区 and 偏好 split views reuse the same mechanism:
          the middle column keeps the settings INDEX (plus the workspace
          list rail for 工作区), and the detail portals into this container. */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {(configView || (sidebarView === "settings" && settingsPage !== "index")) ? (
          configView ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title={configView === "models" ? "模型" : configView === "skills" ? "Skills" : "插件"}
                meta="详情"
                onClose={() => setConfigView(null)}
              />
              <div
                ref={setConfigPortalNode}
                style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
              />
            </div>
          ) : sidebarView === "settings" && settingsPage === "workspace" ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title="工作区设置"
                meta={workspaceSettingsName ?? activeWorkspace?.name ?? undefined}
                onClose={() => setSettingsPage("index")}
              />
              <div
                ref={setConfigPortalNode}
                style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
              />
            </div>
          ) : sidebarView === "settings" && settingsPage === "preferences" ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title="偏好"
                meta="主题 / 语言"
                onClose={() => setSettingsPage("index")}
              />
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                <PreferencesPage />
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title="详情"
                onClose={() => setSettingsPage("index")}
              />
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} />
            </div>
          )
        ) : activeWorkspace && workspaceView === "overview" ? (
          <WorkspaceOverview
            workspace={activeWorkspace}
            onNewSession={handleWorkspaceNewSession}
            onOpenSettings={() => {
              setOpenRepositoryFormRequest(undefined);
              handleSidebarSwitchView("settings");
              setSettingsPage("workspace");
            }}
            onOpenWorkItems={() => handleSidebarSwitchView("work-items")}
            onCreateWorkItem={handleCreateWorkItem}
            onSelectSession={handleSelectSession}
            onOpenLoops={() => {
              handleSidebarSwitchView("loop");
              setLoopEditorOpen(true);
            }}
            onTriggerLoop={handleLoopTriggered}
            onOpenLoopSession={handleOpenLoopSession}
            onSwitchSidebarView={(view) => {
              if (view === "knowledge" || view === "workbench") handleSidebarSwitchView(view);
            }}
            onAddRepository={() => {
              handleSidebarSwitchView("settings");
              setSettingsPage("workspace");
              setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
            }}
            onSessionDeleted={(id) => {
              setRefreshKey((key) => key + 1);
              updateActiveTab((tab) => (tab.session?.id === id ? { session: null } : {}));
            }}
          />
        ) : showChat ? (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
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
    </>
  );
}
