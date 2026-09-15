"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar } from "../TabBar";
import { ArchiveModal } from "../ArchiveModal";
import { LoopsConfig, type LoopConfigTarget } from "../LoopsConfig";
import { KnowledgeBrowser } from "../KnowledgeBrowser";
import { WorkspaceManager } from "../WorkspaceManager";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { WorkspaceOverview } from "../WorkspaceOverview";
import { PanelHeader } from "../PanelHeader";
import { SettingsPanel } from "../SettingsPanel";
import { HomeLanding } from "../HomeLanding";
import { HomeNewSession } from "../HomeNewSession";
import { SessionTabBar } from "../SessionTabBar";
import type { SessionTabState } from "@/lib/session-tabs";
import { ACTIVITY_VIEW_ORDER, SETTINGS_VIEW } from "../ActivityBar";
import { useI18n } from "@/hooks/useI18n";
import { useShell } from "./context";
import { ChatToolbar } from "./ChatToolbar";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { getFileName } from "@/lib/file-paths";

/**
 * The mobile tab keys. W-中收敛（2026-09）：底部 tab 只剩 会话/工作台/设置——
 * 知识库/工作项/Loops 的入口 = 工作台 tab 的 overview 栈页（与桌面家 tab hub
 * 同构）。Tapping a tab SWITCHES the main area (no drawer); tapping the active
 * tab is a no-op. Secondary pages (archive) live on a per-tab stack with ‹返回
 * headers; settings manages its own in-panel subpage navigation.
 */
type MobileTab = "chat" | "workbench" | "settings";

const TAB_ORDER: MobileTab[] = ["chat", "workbench", "settings"];

const CHAT_TAB_DEF = {
  view: "chat" as const,
  label: "会话",
  title: "会话",
  icon: (
    <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden={true as const}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
};

function tabLabel(tab: MobileTab): string {
  if (tab === "workbench") return "工作台";
  if (tab === "chat") return CHAT_TAB_DEF.label;
  return SETTINGS_VIEW.label;
}

function tabIcon(tab: MobileTab) {
  if (tab === "workbench") return ACTIVITY_VIEW_ORDER[0].icon;
  if (tab === "chat") return CHAT_TAB_DEF.icon;
  return SETTINGS_VIEW.icon;
}

/** Per-workspace tab persistence（旧模块 tab 值 knowledge/work-items/loops 归到
 *  工作台——它们的入口现在都在工作台 overview 栈里）。 */
function readStoredTab(workspaceId: string): MobileTab {
  try {
    const raw = localStorage.getItem(`pi-mobile-tab:${workspaceId}`);
    if (raw === "knowledge" || raw === "work-items" || raw === "loops") return "workbench";
    if (raw && (TAB_ORDER as string[]).includes(raw)) return raw as MobileTab;
  } catch { /* ignore */ }
  return "chat";
}

/**
 * The mobile shell: a real tab-bar navigation (bottom tabs switch the main
 * area — Q1..Q5), a per-tab secondary stack with ‹返回 headers (Q6), a
 * persistent chat mount so SSE never breaks on tab switches (Q14), and no
 * drawer at all (Q10 — the drawer CSS/state is gone). Home renders without
 * the tab bar (Q7). The 36px tool strip stays at the top, minus the ☰
 * button (Q15); token usage remains in it.
 *
 * Tab order is 会话 first (the landing tab — user feedback round 1), 工作台
 * second. The 会话 tab always renders the chat itself: an open session, or
 * the fresh-session composer when none is open (never a pre-created
 * session — pi creates the .jsonl only when the first message is sent).
 */
export function MobileShell() {
  const s = useShell();
  const { t: translate } = useI18n();

  const {
    tabs,
    setTabs,
    activeTab,
    activeWorkspace,
    selectedSession,
    fileTabs,
    activeFileTabId,
    rightPanelOpen,
    activeCwd,
    workspaces,
    workspacesLoaded,
    workspaceActivity,
    refreshKey,
    explorerRefreshKey,
    createWorkItemRequest,
    setCreateWorkItemRequest,
    openRepositoryFormRequest,
    sessionActivity,
    modelsRefreshKey,
    sessionKey,
    effectiveNewSessionCwd,
    showChat,
    activeFileTab,
    chatFocusKey,
    panelFocus,
    settingsPage,
    setSettingsPage,
    settingsCwd,
    handleOpenWorkspace,
    closeTab,
    openSessionTab,
    handleSelectTab,
    handleSessionRemoved,
    handleCreateWorkspace,
    handleReturnHome,
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

  // ---- Active tab -------------------------------------------------------------
  const tabsAvailable = TAB_ORDER;
  const [tab, setTab] = useState<MobileTab>("chat");
  // Per-workspace restore: on workspace switch, read the stored tab; a
  // deep-linked session (view=chat with a live chat) lands on the 会话 tab.
  useEffect(() => {
    if (!activeWorkspace) return;
    setTab(showChat ? "chat" : readStoredTab(activeWorkspace.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspace?.id]);

  const switchTab = useCallback((next: MobileTab) => {
    setTab((current) => {
      if (current === next) return current; // tapping the active tab: no-op
      return next;
    });
  }, []);

  // Persist the tab per workspace.
  useEffect(() => {
    if (!activeWorkspace) return;
    try { localStorage.setItem(`pi-mobile-tab:${activeWorkspace.id}`, tab); } catch { /* ignore */ }
  }, [tab, activeWorkspace]);

  // Shared-state focus signals → tab switches (see useAppShellState).
  useEffect(() => {
    if (chatFocusKey > 0) setTab("chat");
  }, [chatFocusKey]);
  useEffect(() => {
    if (!panelFocus) return;
    if (TAB_ORDER.includes(panelFocus.view as MobileTab)) setTab(panelFocus.view as MobileTab);
  }, [panelFocus]);

  // ---- Secondary pages (per-tab stack, Q6) ------------------------------------
  // Archive: secondary page of the 设置 tab. The settings and work-items
  // panels own their internal subpage navigation (their embedded variants
  // already render index → subpage with in-panel back buttons).
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Leaving the settings tab drops transient secondary state.
  useEffect(() => {
    if (tab !== "settings") setArchiveOpen(false);
  }, [tab]);

  // 工作台 tab 的总览栈（D2 + W-中）：「总览」推入 WorkspaceOverview；Loops
  // 「配置/新建」再推 loop 配置栈页；「工作项管理/知识库浏览」是家 tab hub 的
  // 移动镜像。离开工作台 tab 或切换工作区即丢弃。
  type OverviewPage =
    | { page: "overview" }
    | { page: "loop-config"; target: LoopConfigTarget }
    | { page: "work-items" }
    | { page: "knowledge" };
  const [overviewStack, setOverviewStack] = useState<OverviewPage | null>(null);
  useEffect(() => {
    if (tab !== "workbench") setOverviewStack(null);
  }, [tab]);

  const overviewWorkspaceId = activeWorkspace?.id;
  useEffect(() => {
    setOverviewStack(null);
  }, [overviewWorkspaceId]);

  // The knowledge panel's ＋ (add knowledge repo) routes to the settings tab's
  // 工作区 subpage with the repository form open — the mobile equivalent of the
  // desktop middle-column switch.
  const handleKnowledgeAddRepository = useCallback(() => {
    setSettingsPage("workspace");
    setOpenRepositoryFormRequest((request) => (request ?? 0) + 1);
    setTab("settings");
  }, [setSettingsPage, setOpenRepositoryFormRequest]);

  const renderTabContent = () => {
    switch (tab) {
      case "chat":
        return null; // rendered separately (persistent mount)
      case "workbench":
        if (overviewStack && activeWorkspace) {
          if (overviewStack.page === "loop-config") {
            return (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
                <PanelHeader
                  title={overviewStack.target.kind === "new" ? "新建 Loop" : overviewStack.target.name}
                  meta="Loop 配置"
                  onBack={() => setOverviewStack({ page: "overview" })}
                  backLabel="总览"
                />
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  <LoopsConfig
                    workspace={activeWorkspace}
                    target={overviewStack.target}
                    onClose={() => setOverviewStack({ page: "overview" })}
                    onOpenLoop={(name) => setOverviewStack({ page: "loop-config", target: { kind: "loop", name } })}
                  />
                </div>
              </div>
            );
          }
          if (overviewStack.page === "work-items") {
            return (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
                <PanelHeader
                  title="工作项"
                  meta={activeWorkspace.name}
                  onBack={() => setOverviewStack({ page: "overview" })}
                  backLabel="总览"
                />
                <WorkspaceManager
                  open
                  embedded
                  panel
                  initialSection="work-items"
                  activeWorkspacePath={activeWorkspace.path}
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
            );
          }
          if (overviewStack.page === "knowledge") {
            return (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
                <PanelHeader
                  title="知识库"
                  meta={activeWorkspace.name}
                  onBack={() => setOverviewStack({ page: "overview" })}
                  backLabel="总览"
                />
                <KnowledgeBrowser
                  workspace={activeWorkspace}
                  onOpenFile={handleOpenFile}
                  refreshKey={explorerRefreshKey}
                />
              </div>
            );
          }
          return (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title="总览"
                meta={activeWorkspace.name}
                onBack={() => setOverviewStack(null)}
                backLabel="工作台"
              />
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                <WorkspaceOverview
                  workspace={activeWorkspace}
                  onNewSession={handleWorkspaceNewSession}
                  onOpenSettings={() => {
                    setSettingsPage("workspace");
                    setTab("settings");
                  }}
                  onOpenWorkItems={() => setOverviewStack({ page: "work-items" })}
                  onCreateWorkItem={(type) => {
                    setOverviewStack({ page: "work-items" });
                    setCreateWorkItemRequest({ type, id: Date.now() });
                  }}
                  onSelectSession={handleSelectSession}
                  onSwitchSidebarView={(view) => {
                    if (view === "knowledge") setOverviewStack({ page: "knowledge" });
                    else { setOverviewStack(null); setTab("workbench"); }
                  }}
                  onAddRepository={handleKnowledgeAddRepository}
                  onSessionDeleted={handleSessionRemoved}
                  onOpenLoopConfig={(target) => setOverviewStack({ page: "loop-config", target })}
                  onRunLoop={(name) => handleRunLoopDirect(activeWorkspace, name)}
                />
              </div>
            </div>
          );
        }
        return (
          <WorkspaceSidebar
            activeWorkspace={activeWorkspace}
            activeView="workbench"
            onShowOverview={() => setOverviewStack({ page: "overview" })}
            workspaces={workspaces}
            selectedSessionId={selectedSession?.id ?? null}
            runningSessionIds={sessionActivity.runningIds}
            completedSessionIds={sessionActivity.completedIds}
            allSessions={sessionActivity.sessions}
            workspacesLoaded={workspacesLoaded}
            sessionsLoaded={sessionActivity.loaded}
            refreshKey={refreshKey}
            explorerRefreshKey={explorerRefreshKey}
            filesReveal={loopFilesReveal}
            openFilesRequest={loopFilesReveal?.nonce}
            onSelectWorkspace={handleOpenWorkspace}
            onCreateWorkspace={handleCreateWorkspace}
            onImportDirectory={() => setImportPickerOpen(true)}
            onAddRepository={handleKnowledgeAddRepository}
            onNewSession={handleWorkspaceNewSession}
            onSelectSession={handleSelectSession}
            onOpenSessionInNewTab={openSessionTab}
            onOpenFile={handleOpenFile}
            onSessionRemoved={handleSessionRemoved}
          />
        );
      case "settings":
        if (archiveOpen && activeWorkspace) {
          return (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader title="归档" meta={activeWorkspace.name} onBack={() => setArchiveOpen(false)} backLabel="设置" />
              <ArchiveModal
                embedded
                workspaceId={activeWorkspace.id}
                workspacePath={activeWorkspace.path}
                onChanged={() => setRefreshKey((key) => key + 1)}
              />
            </div>
          );
        }
        return (
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
                onClose={() => {}}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenWorkItemConversation={handleOpenWorkItemConversation}
                onRunLoopRound={handleRunLoopRound}
                onRunContract={handleRunContract}
                onOpenConversation={handleOpenConversation}
                onWorkspaceDeleted={handleWorkspaceDeleted}
                onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
                    />
            )}
            onOpenArchive={activeWorkspace ? () => setArchiveOpen(true) : undefined}
            onWorkspaceSkillsChange={(updated) => {
              s.setWorkspaces((current: import("@/lib/workspaces/types").WorkspaceSummary[]) =>
                current.map((w) => (w.id === updated.id ? updated : w)),
              );
            }}
            onModelsSaved={() => s.setModelsRefreshKey((key) => key + 1)}
            onPluginsReloaded={() => s.setSessionKey((key) => key + 1)}
            sessionId={selectedSession?.id ?? null}
          />
        );
      default:
        return null;
    }
  };

  const renderChatTab = () => {
    // No open session → render the fresh-session composer directly (user
    // feedback round 1: no placeholder page). ChatWindow only creates the
    // .jsonl when the first message is sent, so this never litters sessions.
    return (
      <ChatWindow
        reloadSignal={sessionKey}
        session={selectedSession}
        newSessionCwd={effectiveNewSessionCwd ?? activeWorkspace?.path ?? null}
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
    );
  };

  // 宽视口（≥768px：平板竖屏/手机横屏/折叠屏展开）且在工作区内 → 左侧竖向
  // rail 取代底部 tab 栏；同一个 `tab` 状态，跨越断点不丢视图。首页落地页
  // （无 activeWorkspace）不显示导航（与底部栏语义一致），HomeLanding 自带
  // 工作区 chip 入口。
  const wide = useMediaQuery("(min-width: 768px)");
  const showRail = wide && Boolean(activeWorkspace);
  // 首页落地页隐藏 SessionTabBar 行（工作区入口在 HomeLanding 的 chip 下拉；
  // homeSession / HomeNewSession 视图保留 tab 行以便跳回已打开的会话）。
  const showTabBarRow = Boolean(s.activeTabId) || Boolean(s.homeSession) || s.homeNewSession.open;

  return (
    <div style={{ display: "flex", flexDirection: showRail ? "row" : "column", height: "var(--app-vh)", overflow: "hidden", background: "var(--bg)" }}>
      {showRail && <MobileSideRail tabs={tabsAvailable} active={tab} onSelect={switchTab} />}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, height: "100%" }}>
      <ChatToolbar />
      {showTabBarRow && (
      <SessionTabBar
        tabs={tabs}
        activeTabId={s.activeTabId}
        workspaces={workspaces}
        runningIds={sessionActivity.runningIds}
        completedIds={sessionActivity.completedIds}
        workspaceActivity={workspaceActivity}
        onSelectHome={handleReturnHome}
        onSelectTab={(id: string) => {
          if (id !== s.activeTabId) handleSelectTab(id);
        }}
        onCloseTab={closeTab}
        onReorder={(ids: string[]) => setTabs((prev) => ids.map((id) => prev.find((t) => t.id === id)).filter((t): t is SessionTabState => Boolean(t)))}
        onNewSession={handleWorkspaceNewSession}
        onPickWorkspace={handleOpenWorkspace}
      />
      )}

      {/* Main area — the active tab's content. The 会话 tab's chat is ALWAYS
          mounted (hidden, not unmounted) so the SSE stream and streaming
          bubbles survive tab switches (Q14). */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        {!activeWorkspace ? (
          s.homeSession ? (
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
          ) : (
            <HomeLanding
              workspaces={workspaces}
              refreshKey={refreshKey}
              onSelectWorkspace={handleOpenWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              onImportDirectory={() => setImportPickerOpen(true)}
              onSelectSession={s.handleOpenSessionFromHome}
              onNewSession={s.handleHomeNewSession}
              runningSessionIds={s.sessionActivity.runningIds}
            />
          )
        ) : (
          <>
            <div
              style={{
                position: "absolute", inset: 0,
                display: tab === "chat" ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              {renderChatTab()}
            </div>
            {tab !== "chat" ? <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>{renderTabContent()}</div> : null}

            {/* File viewer / session viewer overlay — full-screen above the tab
                content but below the tab bar (files opened from 工作台/知识库)。
                rightPanelOpen now defaults true (desktop's always-open tree
                panel); the overlay itself only shows with an ACTIVE file/session
                tab — the reserved FILES_TAB_ID resolves to activeFileTab null
                (it's not in fileTabs), so closing the last file tab dismisses
                the overlay without flipping rightPanelOpen. */}
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

      {/* Bottom tab bar — rendered only inside a workspace (Home is a
          workspace picker, not a tab — Q7) and only on the narrow layout:
          wide viewports (≥768px) get the left MobileSideRail instead. */}
      {activeWorkspace && !wide && (
        <nav
          role="tablist"
          aria-label="工作区导航"
          className="mobile-bottom-tabbar"
          style={{
            display: "flex", flexDirection: "row", flexShrink: 0,
            height: 52, paddingBottom: "env(safe-area-inset-bottom)",
            borderTop: "1px solid var(--border)", background: "var(--bg-panel)",
            overflowX: "auto",
          }}
        >
          {tabsAvailable.map((item) => {
            const isActive = tab === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={tabLabel(item)}
                onClick={() => switchTab(item)}
                style={{
                  flex: "1 0 auto", minWidth: 56, height: 52,
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                  border: 0, padding: 0, position: "relative",
                  background: "transparent",
                  color: isActive ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer", transition: "color 0.12s",
                }}
              >
                {isActive ? (
                  <span aria-hidden="true" style={{ position: "absolute", top: 0, left: 12, right: 12, height: 2, background: "var(--accent)" }} />
                ) : null}
                {tabIcon(item)}
                <span style={{ fontSize: 10, lineHeight: 1 }}>{tabLabel(item)}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

/** Left vertical nav for wide viewports (≥768px): the same MobileTab set as
 *  the bottom tab bar, stacked as icon-over-label buttons. Phone portrait
 *  keeps the bottom bar; crossing 768px (rotation/fold/tablet) swaps the
 *  chrome without losing `tab` state. Deliberately NOT classed
 *  `mobile-bottom-tabbar` — the keyboard layer hides that bar while the
 *  virtual keyboard is open, and the rail (never covered by a keyboard)
 *  stays reachable. */
function MobileSideRail({
  tabs,
  active,
  onSelect,
}: {
  tabs: MobileTab[];
  active: MobileTab;
  onSelect: (tab: MobileTab) => void;
}) {
  return (
    <nav
      role="tablist"
      aria-label="工作区导航"
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        width: 68,
        borderRight: "1px solid var(--border)",
        background: "var(--bg-panel)",
        paddingTop: 6,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {tabs.map((item) => {
        const isActive = item === active;
        return (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={tabLabel(item)}
            onClick={() => onSelect(item)}
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "9px 2px",
              border: 0,
              background: "transparent",
              color: isActive ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {isActive ? (
              <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 2.5, borderRadius: 2, background: "var(--accent)" }} />
            ) : null}
            {tabIcon(item)}
            <span style={{ fontSize: 10, lineHeight: 1 }}>{tabLabel(item)}</span>
          </button>
        );
      })}
    </nav>
  );
}
