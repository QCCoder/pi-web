"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar } from "../TabBar";
import { ArchiveModal } from "../ArchiveModal";
import { KnowledgeBrowser } from "../KnowledgeBrowser";
import { WorkspaceManager } from "../WorkspaceManager";
import { FilesExplorerPanel } from "../FilesExplorerPanel";
import { WorkspaceHomeMenu } from "../WorkspaceHomeMenu";
import { WorkspaceSessionList } from "../WorkspaceSessionList";
import { LoopsDockPanel } from "../LoopsDockPanel";
import { PanelHeader } from "../PanelHeader";
import { SettingsPanel } from "../SettingsPanel";
import { HomeLanding } from "../HomeLanding";
import { HomeNewSession } from "../HomeNewSession";
import { SessionTabBar } from "../SessionTabBar";
import type { SessionTabState } from "@/lib/session-tabs";
import { useI18n } from "@/hooks/useI18n";
import { useShell } from "./context";
import { ChatToolbar } from "./ChatToolbar";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { getFileName } from "@/lib/file-paths";

/**
 * The mobile tab keys. 2026-09 会话/文件分 tab + 方案 A：底部 tab =
 * 会话/工作区/文件/设置——「工作区」落地即总览（WorkspaceOverview，与桌面
 * 家 tab 同构的心智：活跃工作项/会话/仓库/知识库/Loops 全部 1 跳；loop 配置/
 * 工作项/知识库子页走 overview 栈，‹返回回总览）；「文件」= FilesExplorerPanel
 * （与桌面右栏钉死的「文件」tab 同体，[文件|改动] 分段 + ⟳ 刷新）；全局跨
 * 工作区会话列表只住首页（HomeLanding）。Tapping a tab SWITCHES the main area
 * (no drawer); tapping the active tab is a no-op. Secondary pages (archive) live
 * on a per-tab stack with ‹返回 headers; settings manages its own in-panel
 * subpage navigation.
 */
type MobileTab = "chat" | "workbench" | "files" | "settings";

const TAB_ORDER: MobileTab[] = ["chat", "workbench", "files", "settings"];

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

/** 工作台/设置 tab 定义（原 ActivityBar 常量的本地化——ActivityBar 组件随
 *  桌面图标栏退役，2026-09 树形侧栏改版；移动端不动）。 */
const WORKBENCH_TAB_DEF = {
  label: "工作台",
  icon: (
    <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden={true as const}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
};

const SETTINGS_TAB_DEF = {
  label: "设置",
  icon: (
    <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden={true as const}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

const FILES_TAB_DEF = {
  label: "文件",
  icon: (
    <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden={true as const}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
};

function tabLabel(tab: MobileTab): string {
  if (tab === "workbench") return "工作区";
  if (tab === "files") return FILES_TAB_DEF.label;
  if (tab === "chat") return CHAT_TAB_DEF.label;
  return SETTINGS_TAB_DEF.label;
}

function tabIcon(tab: MobileTab) {
  if (tab === "workbench") return WORKBENCH_TAB_DEF.icon;
  if (tab === "files") return FILES_TAB_DEF.icon;
  if (tab === "chat") return CHAT_TAB_DEF.icon;
  return SETTINGS_TAB_DEF.icon;
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
    closeTab,
    closeTabs,
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
    openSessionStatsPanel,
    handleContextUsageChange,
    chatInputRef,
    loopFilesReveal,
    updateActiveTab,
    setRefreshKey,
    setImportPickerOpen,
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

  // Loops 面板 reveal 信号 → 切到「文件」tab（与桌面激活右栏「文件」tab 同构；
  // FilesExplorerPanel 自己会把分段切回「文件」——用户停在「改动」时树未渲染）。
  const loopFilesRevealNonce = loopFilesReveal?.nonce;
  useEffect(() => {
    if (loopFilesRevealNonce !== undefined) setTab("files");
  }, [loopFilesRevealNonce]);

  // ---- Secondary pages (per-tab stack, Q6) ------------------------------------
  // Archive: secondary page of the 设置 tab. The settings and work-items
  // panels own their internal subpage navigation (their embedded variants
  // already render index → subpage with in-panel back buttons).
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Leaving the settings tab drops transient secondary state.
  useEffect(() => {
    if (tab !== "settings") setArchiveOpen(false);
  }, [tab]);

  // 工作区 tab 的子页栈（2026-09 菜单化：落地 = WorkspaceHomeMenu，栈只存
  // 子页）：会话/工作项/知识库/Loops 管理，‹返回回菜单；离开工作区 tab 或
  // 切换工作区即丢弃。
  type OverviewPage =
    | { page: "sessions" }
    | { page: "work-items" }
    | { page: "knowledge" }
    | { page: "loops" };
  const [overviewStack, setOverviewStack] = useState<OverviewPage | null>(null);
  // Loops 子页（LoopsDockPanel）的变更信号：创建/删除/保存后 bump → 重新拉取
  // （与桌面右坞 Loops tab 的 loopsRefreshKey 同构，本 shell 内自持）。
  const [loopsRefreshKey, setLoopsRefreshKey] = useState(0);
  useEffect(() => {
    if (tab !== "workbench") setOverviewStack(null);
  }, [tab]);

  const overviewWorkspaceId = activeWorkspace?.id;
  useEffect(() => {
    setOverviewStack(null);
  }, [overviewWorkspaceId]);

  const renderTabContent = () => {
    switch (tab) {
      case "chat":
        return null; // rendered separately (persistent mount)
      case "workbench":
        if (!activeWorkspace) return null;
        if (overviewStack?.page === "sessions") {
          // 会话子页：本工作区全部会话（与桌面总览「会话」区块同体）；全局
          // 跨工作区列表住首页。
          return (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title="会话"
                meta={activeWorkspace.name}
                onBack={() => setOverviewStack(null)}
                backLabel="工作区"
              />
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 14px 24px", maxWidth: 640, width: "100%", margin: "0 auto" }}>
                <WorkspaceSessionList
                  key={activeWorkspace.id}
                  workspace={activeWorkspace}
                  showHeader={false}
                  onSelectSession={handleSelectSession}
                  onSessionDeleted={handleSessionRemoved}
                />
              </div>
            </div>
          );
        }
        if (overviewStack?.page === "loops") {
          // Loops 子页：与桌面右坞 Loops tab 同体（LoopsDockPanel：列表+状态/
          // 暂停恢复/停止/运行 + 内联 LoopsConfig 推导航）。
          return (
            <LoopsDockPanel
              key={activeWorkspace.id}
              workspace={activeWorkspace}
              refreshKey={loopsRefreshKey}
              onChanged={() => setLoopsRefreshKey((key) => key + 1)}
              onRunLoop={(name) => handleRunLoopDirect(activeWorkspace, name)}
              listHeader={(
                <PanelHeader
                  title="Loops"
                  meta={activeWorkspace.name}
                  onBack={() => setOverviewStack(null)}
                  backLabel="工作区"
                />
              )}
            />
          );
        }
        if (overviewStack?.page === "work-items") {
          return (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title="工作项"
                meta={activeWorkspace.name}
                onBack={() => setOverviewStack(null)}
                backLabel="工作区"
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
        if (overviewStack?.page === "knowledge") {
          return (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title="知识库"
                meta={activeWorkspace.name}
                onBack={() => setOverviewStack(null)}
                backLabel="工作区"
              />
              <KnowledgeBrowser
                workspace={activeWorkspace}
                onOpenFile={handleOpenFile}
                refreshKey={explorerRefreshKey}
              />
            </div>
          );
        }
        // 菜单化落地（2026-09）：工作区 tab 打开即 WorkspaceHomeMenu——新建会话
        // + 会话（计数）+ 模块组（工作项/知识库按 capability，Loops 带状态）+
        // 工作区设置，每行点进上面的子页。仓库不设行（浏览 = 文件 tab，
        // 管理 = 设置›工作区）。
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <PanelHeader title="工作区" meta={activeWorkspace.name} />
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <WorkspaceHomeMenu
                key={activeWorkspace.id}
                workspace={activeWorkspace}
                loopsRefreshKey={loopsRefreshKey}
                onNewSession={handleWorkspaceNewSession}
                onOpenSessions={() => setOverviewStack({ page: "sessions" })}
                onOpenWorkItems={() => setOverviewStack({ page: "work-items" })}
                onOpenKnowledge={() => setOverviewStack({ page: "knowledge" })}
                onOpenLoops={() => setOverviewStack({ page: "loops" })}
                onOpenSettings={() => {
                  setSettingsPage("workspace");
                  setTab("settings");
                }}
              />
            </div>
          </div>
        );
      case "files":
        // 2026-09 分 tab：文件树/改动从工作台的堆叠段撤出，独立 tab 与桌面右栏
        // 同体（FilesExplorerPanel 自带 [文件|改动] 分段 + ⟳ 刷新，按工作区持久化）。
        if (!activeWorkspace) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <PanelHeader title="文件" meta={activeWorkspace.name} />
            <div style={{ flex: 1, minHeight: 0 }}>
              <FilesExplorerPanel
                workspace={activeWorkspace}
                explorerRefreshKey={explorerRefreshKey}
                onOpenFile={handleOpenFile}
                reveal={loopFilesReveal ?? undefined}
              />
            </div>
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
        onCloseTabs={closeTabs}
        onReorder={(ids: string[]) => setTabs((prev) => ids.map((id) => prev.find((t) => t.id === id)).filter((t): t is SessionTabState => Boolean(t)))}
        onNewSession={handleTabBarNewSession}
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
