"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar } from "../TabBar";
import { ArchiveModal } from "../ArchiveModal";
import { WorkspaceManager } from "../WorkspaceManager";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { PanelHeader } from "../PanelHeader";
import { SettingsPanel } from "../SettingsPanel";
import { HomeLanding } from "../HomeLanding";
import { WorkspaceTabBar } from "../WorkspaceTabBar";
import { ACTIVITY_VIEW_ORDER, SETTINGS_VIEW, type SidebarView } from "../ActivityBar";
import { useI18n } from "@/hooks/useI18n";
import { useShell } from "./context";
import { ChatToolbar } from "./ChatToolbar";
import { getFileName } from "@/lib/file-paths";
import type { WorkspaceCapability } from "@/lib/workspaces/types";

/**
 * The mobile tab keys. 工作台 is first (= the landing tab, Q4), 会话 second;
 * the capability modules (知识库/工作项) follow in ACTIVITY_VIEW_ORDER, then
 * 设置. Tapping a tab SWITCHES the main area (no drawer — Q1/Q3);
 * tapping the active tab is a no-op. Secondary pages (archive) live on a
 * per-tab stack with a ‹返回 header (Q6); the settings and work-items panels
 * manage their own in-panel subpage navigation.
 */
type MobileTab = "chat" | "workbench" | "knowledge" | "work-items" | "settings";

const TAB_ORDER: MobileTab[] = ["chat", "workbench", "knowledge", "work-items", "settings"];

/** Capability gating for the module tabs (workbench/chat/settings are always on). */
const TAB_CAPABILITY: Partial<Record<MobileTab, WorkspaceCapability>> = {
  knowledge: "knowledge",
  "work-items": "work-items",
};

function availableTabs(capabilities: WorkspaceCapability[]): MobileTab[] {
  return TAB_ORDER.filter((tab) => {
    const capability = TAB_CAPABILITY[tab];
    return !capability || capabilities.includes(capability);
  });
}

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
  if (tab === "settings") return SETTINGS_VIEW.label;
  return ACTIVITY_VIEW_ORDER.find((item) => item.view === (tab as SidebarView))?.label ?? tab;
}

function tabIcon(tab: MobileTab) {
  if (tab === "workbench") return ACTIVITY_VIEW_ORDER[0].icon;
  if (tab === "chat") return CHAT_TAB_DEF.icon;
  if (tab === "settings") return SETTINGS_VIEW.icon;
  return ACTIVITY_VIEW_ORDER.find((item) => item.view === (tab as SidebarView))?.icon ?? null;
}

/** Per-workspace tab persistence (falls back to 会话 — the landing tab — on stale values). */
function readStoredTab(workspaceId: string, capabilities: WorkspaceCapability[]): MobileTab {
  try {
    const raw = localStorage.getItem(`pi-mobile-tab:${workspaceId}`) as MobileTab | null;
    if (raw && availableTabs(capabilities).includes(raw)) return raw;
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
    selectedWorkItemKey,
    fileTabs,
    activeFileTabId,
    rightPanelOpen,
    activeCwd,
    workspaces,
    workspaceActivity,
    refreshKey,
    explorerRefreshKey,
    createWorkItemRequest,
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
    handleOpenWorkspaceToChat,
    handleCloseWorkspaceTab,
    handleCreateWorkspace,
    handleReturnHome,
    handleOpenLoopSession,
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
    openSessionStatsPanel,
    handleContextUsageChange,
    chatInputRef,
    updateActiveTab,
    setRefreshKey,
    setImportPickerOpen,
    setOpenRepositoryFormRequest,
  } = s;

  // ---- Active tab -------------------------------------------------------------
  const capabilities = activeWorkspace?.capabilities ?? [];
  const tabsAvailable = availableTabs(capabilities);
  const [tab, setTab] = useState<MobileTab>("chat");
  // Per-workspace restore: on workspace switch, read the stored tab; a
  // deep-linked session (view=chat with a live chat) lands on the 会话 tab.
  useEffect(() => {
    if (!activeWorkspace) return;
    setTab(showChat && activeTab?.view === "chat" ? "chat" : readStoredTab(activeWorkspace.id, activeWorkspace.capabilities));
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
        return (
          <WorkspaceSidebar
            activeWorkspace={activeWorkspace}
            activeView="workbench"
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
            onAddRepository={handleKnowledgeAddRepository}
            onNewSession={handleWorkspaceNewSession}
            onSelectSession={handleSelectSession}
            onOpenFile={handleOpenFile}
            onSessionRemoved={(id) => {
              updateActiveTab((current) => (current.session?.id === id ? { session: null } : {}));
              setRefreshKey((k) => k + 1);
            }}
          />
        );
      case "knowledge":
        return (
          <WorkspaceSidebar
            activeWorkspace={activeWorkspace}
            activeView="knowledge"
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
            onAddRepository={handleKnowledgeAddRepository}
            onNewSession={handleWorkspaceNewSession}
            onSelectSession={handleSelectSession}
            onOpenFile={handleOpenFile}
            onSessionRemoved={(id) => {
              updateActiveTab((current) => (current.session?.id === id ? { session: null } : {}));
              setRefreshKey((k) => k + 1);
            }}
          />
        );
      case "work-items":
        if (!activeWorkspace) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <PanelHeader title="工作项" meta={activeWorkspace.name} />
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
                />
          </div>
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
            workspaceSlot={activeWorkspace ? (
              <WorkspaceManager
                open
                embedded
                panel
                initialSection="workspaces"
                activeWorkspacePath={activeWorkspace.path}
                openRepositoryFormRequest={openRepositoryFormRequest}
                onClose={() => {}}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenWorkItemConversation={handleOpenWorkItemConversation}
                onRunContract={handleRunContract}
                onOpenConversation={handleOpenLoopSession}
                onWorkspaceDeleted={handleWorkspaceDeleted}
                onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
                    />
            ) : null}
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
      <ChatToolbar />
      <WorkspaceTabBar
        workspaces={workspaces}
        tabIds={tabs.map((t) => t.id)}
        activeWorkspaceId={activeWorkspace?.id ?? null}
        activityByWorkspaceId={workspaceActivity}
        onSelectHome={handleReturnHome}
        onSelectWorkspace={handleOpenWorkspace}
        onCloseWorkspace={handleCloseWorkspaceTab}
        onReorder={(ids: string[]) => setTabs((prev) => ids.map((id) => prev.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => Boolean(t)))}
        onPickWorkspace={handleOpenWorkspaceToChat}
      />

      {/* Main area — the active tab's content. The 会话 tab's chat is ALWAYS
          mounted (hidden, not unmounted) so the SSE stream and streaming
          bubbles survive tab switches (Q14). */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        {!activeWorkspace ? (
          <HomeLanding
            workspaces={workspaces}
            refreshKey={refreshKey}
            onSelectWorkspace={handleOpenWorkspace}
            onCreateWorkspace={handleCreateWorkspace}
            onImportDirectory={() => setImportPickerOpen(true)}
            onSelectSession={s.handleOpenSessionFromHome}
          />
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
                content but below the tab bar (files opened from 工作台/知识库). */}
            {rightPanelOpen && (
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

      {/* Bottom tab bar — rendered only inside a workspace (Home is a
          workspace picker, not a tab — Q7). */}
      {activeWorkspace && (
        <nav
          role="tablist"
          aria-label="工作区导航"
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
