"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatWindow } from "../ChatWindow";
import { FileViewer } from "../FileViewer";
import { TabBar } from "../TabBar";
import { ArchiveModal } from "../ArchiveModal";
import { KnowledgeBrowser } from "../KnowledgeBrowser";
import { FilesExplorerPanel } from "../FilesExplorerPanel";
import { LoopsDockPanel } from "../LoopsDockPanel";
import { SettingsPanel, settingsSubpageHeader, type SettingsSubpage } from "../SettingsPanel";
import { HomeLanding } from "../HomeLanding";
import { HomeNewSession } from "../HomeNewSession";
import { SearchPalette } from "../SearchPalette";
import { ProjectSidebar } from "../ProjectSidebar";
import { WorkspaceSelector } from "../WorkspaceSelector";
import { createNewSessionTab, tabQuery } from "@/lib/session-tabs";
import { buildWorkItemsPageUrl } from "@/lib/work-items-page-url";
import type { WorkItemType } from "@/lib/work-items/types";
import type { CenterPage, MobileTab } from "./useAppShellState";
import { defaultHomeNewSessionWorkspaceId } from "@/lib/home-quick-switch";
import { isWorkspaceSelectable } from "@/lib/workspaces/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useShell } from "./context";
import { ChatToolbar, type ToolbarMenuExtra } from "./ChatToolbar";
import { useMobileSkills } from "./useMobileSkills";
import { MobileSkillDetail, MobileSkillInstall, MobileSkillsList } from "./MobileSkillsPages";
import { MobileAgentDetail, MobileAgentEdit, MobileAgentsList, type MobileAgentEditSeed } from "./MobileAgentsPages";
import { agentProfileKey, duplicateAgentName, editableAgentDraft, emptyAgentDraft, isWritableAgentScope, useMobileAgents } from "./useMobileAgents";
import type { SubagentProfile } from "@/lib/subagents";
import { MobileWorkspacePage } from "./MobileWorkspacePage";
import { MobileWorkspaceSettings } from "./MobileWorkspaceSettings";
import { MobileWorkItemCreatePage, MobileWorkItemDetailPage, MobileWorkItemsPage } from "./MobileWorkItemsPages";
import { MobileIconButton, MobileNavBar, MobilePageTitle } from "./mobile-ui";
import { WorkspaceModuleIcon, workspaceModuleEntries } from "./workspace-modules";
import { getFileName } from "@/lib/file-paths";

/**
 * 手机壳（<768px，2026-10 底部 tab 改版，knowledge/designs/mobile-drawer-design.md 文末
 * 补充记录）。MobileShell（≥768px 树常驻贴左的平板壳）在窄视口把渲染整体
 * 委托给本组件；两壳共用 useAppShellState 的会话/tab/工作区状态。
 *
 *   底部 3 tab = 会话 / Skill / 设置，是**唯一**定期导航——2026-09 的 ☰ 抽屉、
 *   边缘右滑、头部模块条随之退役（当年删 tab 的三个痛点里「导航碎」靠「tab 唯一」
 *   规避，「切工作区太深」靠首页组头一步进工作区页解决）。
 *
 *   会话 tab 首页 = 桌面左栏「项目」同一组件（ProjectSidebar phoneHome：只渲染项目
 *   头 + 分组/平铺会话体——样式、彩色首字头像、折叠〔pi-tree-collapsed〕、每组 5 条
 *   + 显示更多、# 分组开关、长按排序全部继承）。组头整行 = 收起/展开，头像 → 推入
 *   工作区页；会话行 → 推入聊天页。首页顶栏只有「会话」+ 搜索——**没有 ⋯**（模块入口
 *   是「某个工作区的」，在首页没有明确作用对象，用户要求下沉）；右下 FAB 新建会话
 *   （默认最近活跃工作区，composer 内 WorkspaceSelector 可换）；页脚安静入口通往
 *   停用/不可用工作区的设置（重启用路径）。
 *
 *   二级工作区页 = MobileWorkspacePage：顶栏 ‹ + 名 + ⋯（文件 / 工作项 / 知识库 / Loops
 *   〔capability 门控〕/ 工作区设置），正文 hero + 新建会话 + 会话列表 + 已归档会话。
 *   三级聊天页 ChatToolbar ⋯ 多一个「工作区」组（moreMenuExtras），同一组入口——
 *   两处菜单与平板壳模块条全部出自 workspaceModuleEntries 注册表（图标/门控唯一出处）。
 *
 *   Skill tab = 手机原生三页（MobileSkillsPages + useMobileSkills，与桌面
 *   SkillsConfig 同一套后端契约）：根页列表（分组卡片 + 开关）→ 推入详情页 /
 *   推入安装页。设置 tab = SettingsPanel phoneTab（iOS 分组索引）→ 子页**推入栈**
 *   （2026-10-26 导航统一：settings-sub 页由壳提供 MobileNavBar，面板 headerless
 *   只出正文——手机壳不再有「面板自管子页导航」这条旁路）。Agents 子页例外：
 *   settings-sub agents 由手机原生三页宿主（MobileAgentsPages + useMobileAgents，
 *   2026-10——列表（内置总开关 + 按作用域优先级分组）→ 推入详情 → 推入编辑，
 *   保存成功 replaceTop 成详情；不再内嵌桌面 AgentsConfig 分栏）。
 *
 *   页头规格（mobile-ui 原语）：tab 根页 = MobilePageTitle 大标题；推入页 =
 *   MobileNavBar（44px，‹ + 下一层页名 + 标题 + 动作槽）；聊天页 ChatToolbar 是唯一
 *   特例。推入栈（pushStack）是扁平的小栈（最深 home → 工作区页 → 聊天）：‹ 弹一层，
 *   tab 切换清空，Android 返回键经 history 陷阱态弹栈。**tab 栏显隐只有一条规则：
 *   栈非空即隐藏**（含聊天/设置子页在内的全部推入页）；聊天页的 composer 因而独占
 *   底边，不再需要旧「键盘弹出隐藏 tab 栏」那套内核分叉逻辑。
 *
 *   聊天持久挂载在最底层（SSE 与流式气泡跨页不断），首页/推入页以不透明层
 *   覆盖其上，栈顶为聊天时上层全部隐藏——与旧目的地页的分层机制同构。
 *   共享焦点信号 chatFocusKey（打开会话 / 新建会话）= 推入聊天页。
 *
 *   上下文规则「跟着屏幕走」不变：以工作区 W 为目标的推入先
 *   ensureWorkspaceContext(W)（幂等建/激活 W 锚定占位 tab，不 focusChat）。
 *
 *   深链 ?page=work-items：centerPage{kind:"work-items"} ⇒ 推入该工作区的工作项
 *   页并记 deeplink 来源；离开该 kind 只收回自己推的那页；页内 ‹返回 = 清
 *   centerPage + URL 回写活动 tab 投影（URL 与状态一致，刷新不复活）。其余 tab
 *   与推入页不进 URL（与旧 mobilePage 一致）。
 *
 *   工作项页 = 手机原生三页（MobileWorkItemsPages，2026-10，取代桌面 WorkItemsPage
 *   的窄屏自适应）：列表根页之上再推 work-item-detail / work-item-create 两层子页，
 *   ‹ 回列表而不是回工作区页；新建成功 replaceTop 成详情（不退回已提交表单）；
 *   deeplink 形态下推详情 / ‹ / 返回键三条路都同步 URL 的 &item=。
 */

type WorkspacePushKind = "workspace" | "files" | "work-items" | "knowledge" | "loops" | "archive" | "ws-settings";

type PushPage =
  | { kind: "chat" }
  | { kind: WorkspacePushKind; workspaceId: string; deeplink?: boolean }
  /** 工作项详情 / 新建子页（2026-10 手机原生工作项页）：列表页之上再推一层，
   *  ‹ 回列表而不是回工作区页；deeplink 形态下详情页同步 URL 的 &item=。 */
  | { kind: "work-item-detail"; workspaceId: string; itemKey: string; deeplink?: boolean }
  | { kind: "work-item-create"; workspaceId: string; type?: WorkItemType }
  | { kind: "skill-detail"; filePath: string }
  | { kind: "skill-install" }
  /** Agents 子页（2026-10 手机原生三页，取代内嵌桌面 AgentsConfig 分栏）：列表页
   *  宿 settings-sub agents（壳出页头 + ＋ 动作），其上再推 详情 / 编辑 两层；
   *  编辑页保存成功 replaceTop 成详情（‹ 直接回列表，不经表单）。seed 为纯数据
   *  （editing=null = 新建），与 work-item-create 同例不进 URL。 */
  | { kind: "agent-detail"; profileKey: string }
  | { kind: "agent-edit"; seed: MobileAgentEditSeed }
  /** 设置子页（2026-10-26 导航统一）：面板 headerless 只出正文，页头由壳的
   *  MobileNavBar 提供；栈空即回设置索引。 */
  | { kind: "settings-sub"; page: SettingsSubpage };

const TAB_ENTRIES: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  {
    id: "sessions",
    label: "会话",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 3 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 9 8.4z" />
      </svg>
    ),
  },
  {
    id: "skills",
    label: "Skill",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /><path d="M5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "设置",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    ),
  },
];


export function MobileTabShell() {
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
    sessionActivity,
    modelsRefreshKey,
    sessionKey,
    effectiveNewSessionCwd,
    activeFileTab,
    chatFocusKey,
    settingsCwd,
    mobileTab,
    setMobileTab,
    ensureWorkspaceContext,
    openNewSessionTab,
    handleSessionRemoved,
    handleCreateWorkspace,
    handleOpenConversation,
    handleSelectSession,
    handleRunLoopDirect,
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
    centerPage,
    setCenterPage,
    navigateUrl,
    workItemsItemKeyRef,
  } = s;

  // ---- 推入栈 ----------------------------------------------------------------
  const [pushStack, setPushStack] = useState<PushPage[]>([]);
  const top = pushStack.length > 0 ? pushStack[pushStack.length - 1] : null;
  const push = useCallback((page: PushPage) => {
    setPushStack((prev) => [...prev, page]);
  }, []);
  const pop = useCallback(() => {
    setPushStack((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
  }, []);
  const resetStack = useCallback(() => setPushStack([]), []);
  /** 栈顶换页（如 工作项页 → Loops 恢复）：不多占一层返回。 */
  const replaceTop = useCallback((page: PushPage) => {
    setPushStack((prev) => (prev.length > 0 ? [...prev.slice(0, -1), page] : [page]));
  }, []);

  const [loopsRefreshKey, setLoopsRefreshKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  // Skill tab 数据层（列表 / 详情 / 安装三页共享）。
  const skillsState = useMobileSkills({
    cwd: settingsCwd ?? "",
    projectInstallAvailable: Boolean(activeWorkspace),
  });
  // Agents 三页数据层（设置 › Agents：列表 / 详情 / 编辑共享；与桌面 AgentsConfig
  // 同一套 API——profiles + settings + models）。
  const agentsState = useMobileAgents({ cwd: settingsCwd ?? "" });

  // ---- 会话全文搜索深跳转（与 DesktopShell/MobileShell 同机制，壳自有）------
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => (current === target ? null : current));
  }, []);

  // ---- tab 切换 = 清栈 + 收起浮层 -----------------------------------------
  const switchTab = useCallback((tab: MobileTab) => {
    setSearchOpen(false);
    resetStack();
    setMobileTab(tab);
  }, [resetStack, setMobileTab]);

  // ---- 共享焦点信号 → 推入聊天页 ---------------------------------------------
  // 打开会话 / 新建会话（focusChat）= 落聊天：栈顶不是聊天就推一层。会话 tab
  // 以外触发（如 Skill tab 里打开会话）先回会话 tab。
  useEffect(() => {
    if (chatFocusKey === 0) return;
    setMobileTab("sessions");
    setSearchOpen(false);
    setPushStack((prev) => {
      const current = prev.length > 0 ? prev[prev.length - 1] : null;
      return current?.kind === "chat" ? prev : [...prev, { kind: "chat" }];
    });
  }, [chatFocusKey, setMobileTab]);
  // 零工作区路径：首页无主新会话页打开 / 首页会话落地 → 同样落聊天层。
  useEffect(() => {
    if (!s.homeNewSession.open && !s.homeSession) return;
    setPushStack((prev) => {
      const current = prev.length > 0 ? prev[prev.length - 1] : null;
      return current?.kind === "chat" ? prev : [...prev, { kind: "chat" }];
    });
  }, [s.homeNewSession.open, s.homeSession]);

  // ---- work-items 深链 → 推入映射（与 MobileShell 同语义）--------------------
  const workItemsDeeplinkActive = centerPage?.kind === "work-items";
  const deeplinkWorkspaceId = centerPage?.kind === "work-items" ? centerPage.workspaceId : null;
  const workItemsDeeplinkAutoRef = useRef(false);
  useEffect(() => {
    if (workItemsDeeplinkActive && deeplinkWorkspaceId) {
      workItemsDeeplinkAutoRef.current = true;
      setMobileTab("sessions");
      setPushStack((prev) => {
        const current = prev.length > 0 ? prev[prev.length - 1] : null;
        if (current?.kind === "work-items" && current.deeplink && current.workspaceId === deeplinkWorkspaceId) return prev;
        return [...prev, { kind: "work-items", workspaceId: deeplinkWorkspaceId, deeplink: true }];
      });
      return;
    }
    if (workItemsDeeplinkAutoRef.current) {
      workItemsDeeplinkAutoRef.current = false;
      setPushStack((prev) => prev.filter((page) => !(page.kind === "work-items" && page.deeplink)));
    }
  }, [workItemsDeeplinkActive, deeplinkWorkspaceId, setMobileTab]);
  const closeWorkItemsDeeplink = useCallback(() => {
    setCenterPage(null);
    navigateUrl(activeTab ? tabQuery(activeTab) : "tab=home");
  }, [setCenterPage, navigateUrl, activeTab]);

  // Loops 面板 reveal 信号 → 推入「文件」页（FilesExplorerPanel 自己切回分段）。
  const loopFilesRevealNonce = loopFilesReveal?.nonce;
  useEffect(() => {
    if (loopFilesRevealNonce === undefined || !activeWorkspace) return;
    push({ kind: "files", workspaceId: activeWorkspace.id });
  }, [loopFilesRevealNonce, activeWorkspace, push]);

  // ---- 空态自动落回（与 MobileShell 同）--------------------------------------
  // 没有任何 tab（冷启动 / 会话删除自动关掉最后一个）→ 给默认工作区开占位
  // composer 作上下文锚（纯状态；手机壳首页仍是会话列表，不会因此跳聊天——
  // openNewSessionTab 的 focusChat 会推聊天，所以这里用 ensureWorkspaceContext）。
  useEffect(() => {
    if (!navReady || activeTabId !== null) return;
    if (s.centerPage) return;
    if (s.homeSession || s.homeNewSession.open) return;
    const targetId = defaultHomeNewSessionWorkspaceId(workspaces, s.sessionActivity.sessions, s.mruIds);
    const target = workspaces.find((w) => w.id === targetId);
    if (!target || !isWorkspaceSelectable(target)) return;
    ensureWorkspaceContext(target);
  }, [navReady, activeTabId, s.centerPage, s.homeSession, s.homeNewSession.open, workspaces, s.sessionActivity.sessions, s.mruIds, ensureWorkspaceContext]);

  // ---- Android 返回键弹栈（移植自 2026-09 抽屉陷阱态，knowledge/designs/mobile-drawer-design.md §6）
  // 每推一层压一个陷阱 history 态；popstate（返回键/返回手势）弹一层不退页；
  // UI 自行弹栈（‹ / tab 切换）时消费掉对应数量的陷阱态——先立 ignore 标记再
  // history.go(-n)，避免我们自己触发的 popstate 再弹一次。
  const trapDepthRef = useRef(0);
  const ignorePopRef = useRef(0);
  useEffect(() => {
    const depth = pushStack.length;
    const trapped = trapDepthRef.current;
    if (depth > trapped) {
      for (let i = trapped; i < depth; i += 1) {
        try { history.pushState({ piMobilePushPage: true }, ""); } catch { /* ignore */ }
      }
      trapDepthRef.current = depth;
    } else if (depth < trapped) {
      const delta = trapped - depth;
      trapDepthRef.current = depth;
      if (history.state && (history.state as { piMobilePushPage?: boolean }).piMobilePushPage) {
        ignorePopRef.current += 1;
        try { history.go(-delta); } catch { ignorePopRef.current -= 1; }
      }
    }
  }, [pushStack.length]);
  useEffect(() => {
    const onPopState = () => {
      if (ignorePopRef.current > 0) {
        ignorePopRef.current -= 1;
        return;
      }
      if (trapDepthRef.current > 0) {
        trapDepthRef.current -= 1;
        setPushStack((prev) => {
          const popped = prev.length > 0 ? prev[prev.length - 1] : null;
          // 深链工作项页被返回键关掉 = 同 ‹返回：URL 必须跟着收口。
          if (popped?.kind === "work-items" && popped.deeplink) {
            setCenterPage(null);
          }
          // 深链形态的详情页被返回键关掉 = 同 ‹：URL 去掉 &item=（刷新不复活详情）。
          if (popped?.kind === "work-item-detail" && popped.deeplink) {
            navigateUrl(buildWorkItemsPageUrl(popped.workspaceId), true);
          }
          return prev.slice(0, -1);
        });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [setCenterPage, navigateUrl]);

  // ---- 派生数据 -------------------------------------------------------------
  const sessions = sessionActivity.sessions;
  const unselectableWorkspaces = useMemo(
    () => workspaces.filter((w) => !isWorkspaceSelectable(w)).sort((a, b) => a.name.localeCompare(b.name)),
    [workspaces],
  );
  const hasSelectableWorkspace = workspaces.some(isWorkspaceSelectable);
  /** ⋯ 菜单与 FAB 的作用对象：最近活跃会话所属工作区（→ MRU → 首组）。 */
  const scopeWorkspace = useMemo(() => {
    const id = defaultHomeNewSessionWorkspaceId(workspaces, sessions, s.mruIds);
    const found = workspaces.find((w) => w.id === id);
    return found && isWorkspaceSelectable(found) ? found : null;
  }, [workspaces, sessions, s.mruIds]);

  const resolveWorkspace = useCallback(
    (id: string) => workspaces.find((w) => w.id === id) ?? null,
    [workspaces],
  );

  // ---- 推入动作 -------------------------------------------------------------
  const openWorkspacePage = useCallback((workspace: WorkspaceSummary) => {
    ensureWorkspaceContext(workspace);
    push({ kind: "workspace", workspaceId: workspace.id });
  }, [ensureWorkspaceContext, push]);
  const openModule = useCallback((workspace: WorkspaceSummary, kind: "files" | "work-items" | "knowledge" | "loops" | "archive") => {
    ensureWorkspaceContext(workspace);
    // 用户自驱进入工作项页 = 深链自动态让位（ensureWorkspaceContext 的
    // activateTab 会清 centerPage；不摘标记的话映射 effect 会把刚推的页收回）。
    if (kind === "work-items") workItemsDeeplinkAutoRef.current = false;
    push({ kind, workspaceId: workspace.id });
  }, [ensureWorkspaceContext, push]);
  const openWorkspaceSettings = useCallback((workspace: WorkspaceSummary) => {
    push({ kind: "ws-settings", workspaceId: workspace.id });
  }, [push]);
  // 新建子代理（列表页 ＋ / 空态按钮）：预排重名的 custom-agent 占位名。
  const pushAgentCreate = useCallback(() => {
    let name = "custom-agent";
    let suffix = 2;
    while (agentsState.profiles.some((profile) => profile.name === name)) name = `custom-agent-${suffix++}`;
    push({ kind: "agent-edit", seed: { editing: null, scope: "global", draft: emptyAgentDraft(name) } });
  }, [agentsState.profiles, push]);
  const pushAgentEdit = useCallback((profile: SubagentProfile) => {
    if (!isWritableAgentScope(profile.scope)) return;
    push({ kind: "agent-edit", seed: { editing: profile, scope: profile.scope, draft: editableAgentDraft(profile) } });
  }, [push]);
  const pushAgentDuplicate = useCallback((profile: SubagentProfile) => {
    push({
      kind: "agent-edit",
      seed: {
        editing: null,
        scope: isWritableAgentScope(profile.scope) ? profile.scope : "global",
        draft: {
          ...editableAgentDraft(profile),
          name: duplicateAgentName(profile.name, agentsState.profiles),
          displayName: `${profile.displayName} 副本`,
        },
      },
    });
  }, [agentsState.profiles, push]);
  const handleNewSession = useCallback(() => {
    setSearchOpen(false);
    if (scopeWorkspace) {
      openNewSessionTab(scopeWorkspace);
      return;
    }
    s.handleHomeNewSession();
  }, [scopeWorkspace, openNewSessionTab, s]);
  const handleSelectSearchHit = useCallback((session: SessionInfo, entryId?: string, blockIndex?: number) => {
    setSearchOpen(false);
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    handleSelectSession(session);
  }, [handleSelectSession]);
  // 搜索面板里的配置入口 → 设置 tab（设置 = 索引根页；模型/插件/Agents = 推入
  // settings-sub 子页——导航统一后设置子页都在栈里，面板 headerless 只出正文）。
  const handleOpenCenterPage = useCallback((page: CenterPage) => {
    setSearchOpen(false);
    if (page.kind === "settings" || page.kind === "models" || page.kind === "agents" || page.kind === "plugins") {
      resetStack();
      setMobileTab("settings");
      if (page.kind !== "settings") push({ kind: "settings-sub", page: page.kind });
    }
  }, [resetStack, setMobileTab, push]);
  const handleBackFromChat = useCallback(() => {
    if (s.homeNewSession.open) s.handleExitHomeNewSession();
    pop();
  }, [s, pop]);

  // 推入页的 ‹ 文案 = 栈里下一层页的标题（iOS 语义）：栈底（tab 根）= tab 名，
  // 聊天层 = 「聊天」，工作区页 = 该工作区名，Skill 页 = 「Skill」，设置子页 =
  // 「设置」。旧实现从聊天页 ⋯ 推入模块页时下一层是 chat 却落默认分支误标「会话」。
  const backLabelFor = (index: number): string => {
    const below = index > 0 ? pushStack[index - 1] : null;
    if (!below) {
      return mobileTab === "skills" ? "Skill" : mobileTab === "settings" ? "设置" : "会话";
    }
    if (below.kind === "chat") return "聊天";
    if (below.kind === "skill-detail" || below.kind === "skill-install") return "Skill";
    // Agents 编辑页的下一层可能是详情页（编辑已有）——‹ 文案 = 该配置显示名。
    if (below.kind === "agent-detail") {
      const profile = agentsState.profiles.find((item) => agentProfileKey(item) === below.profileKey);
      return profile?.displayName ?? "Agents";
    }
    if (below.kind === "agent-edit") return "Agents";
    // 设置子页之上只有 Agents 会再推一层（详情 / 编辑）——‹ 文案取该子页标题。
    if (below.kind === "settings-sub") return settingsSubpageHeader(below.page, settingsCwd ?? "").title;
    // 工作项详情 / 新建的下一层是工作项列表页。
    if (below.kind === "work-items") return "工作项";
    const workspace = resolveWorkspace(below.workspaceId);
    if (below.kind === "workspace" && workspace) return workspace.name;
    return "返回";
  };

  // 聊天页 ChatToolbar 的返回目标（aria-label/title；按钮本体是裸 ‹）：取栈里
  // 聊天层的下一层——工作区页推入的聊天 ‹ 回工作区页（文案 = 工作区名），
  // 栈底聊天 = 当前 tab 根名。旧实现写死「返回会话列表」。
  const chatBackLabel = useMemo(() => {
    let chatIndex = -1;
    for (let i = pushStack.length - 1; i >= 0; i -= 1) {
      if (pushStack[i].kind === "chat") { chatIndex = i; break; }
    }
    if (chatIndex <= 0) {
      return mobileTab === "skills" ? "返回 Skill" : mobileTab === "settings" ? "返回设置" : "返回会话列表";
    }
    const below = pushStack[chatIndex - 1];
    if (below.kind === "workspace") return resolveWorkspace(below.workspaceId)?.name ?? "返回";
    return "返回";
  }, [pushStack, mobileTab, resolveWorkspace]);

  // 三级（聊天页）⋯ 的「工作区」组：当前会话所属工作区的模块入口 + 工作区设置
  // （与二级工作区页顶栏 ⋯ 同一组内容，出自 workspaceModuleEntries 注册表；
  // 推入页落在聊天之上，‹ 回聊天）。
  const chatMenuExtras = useMemo<ToolbarMenuExtra[]>(() => {
    const workspace = activeWorkspace;
    if (!workspace) return [];
    return workspaceModuleEntries(workspace, { settings: true }).map((entry) => ({
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      onClick: () => {
        if (entry.id === "ws-settings") openWorkspaceSettings(workspace);
        // settings:true 且不含 overview，这里只会剩四个模块 id。
        else openModule(workspace, entry.id as "files" | "work-items" | "knowledge" | "loops");
      },
    }));
  }, [activeWorkspace, openModule, openWorkspaceSettings]);

  // tab 栏显隐唯一规则：栈非空即隐藏（聊天/工作区页/模块页/设置子页一视同仁，
  // 2026-10-26 导航统一——设置子页也进了栈，删除旧的 settingsPage 特判）。
  const tabBarVisible = top === null;

  // ---- 聊天层（持久挂载）----------------------------------------------------
  const chatMounted = Boolean(activeWorkspace) || Boolean(s.homeSession) || s.homeNewSession.open;
  const renderChatBody = () => {
    if (activeWorkspace) {
      return (
        <ChatWindow
          reloadSignal={sessionKey}
          session={selectedSession}
          newSessionCwd={effectiveNewSessionCwd ?? activeWorkspace.path ?? null}
          draftKeyOverride={activeTab?.kind === "new-session" ? activeTab.id : undefined}
          inputLeadingControl={
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
    }
    if (s.homeSession) {
      return (
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
      );
    }
    if (s.homeNewSession.open) {
      return (
        <HomeNewSession
          workspaces={workspaces}
          selectedWorkspaceId={s.homeNewSession.workspaceId}
          onSelectWorkspace={s.handleHomeNewSessionSelect}
          onSessionCreated={s.handleHomeSessionCreated}
          onCreateWorkspace={handleCreateWorkspace}
          modelsRefreshKey={s.modelsRefreshKey}
          chatInputRef={s.chatInputRef}
        />
      );
    }
    return null;
  };

  // ---- 会话首页 -------------------------------------------------------------
  const renderSessionsHome = () => {
    if (!hasSelectableWorkspace && !s.homeSession && !s.homeNewSession.open) {
      // 零可用工作区：创建/导入/重启用引导。⚙ = 设置 tab；已停用工作区行 →
      // 推入该工作区的设置页（重启用路径）。
      return (
        <HomeLanding
          sessions={sessions}
          workspaces={workspaces}
          refreshKey={refreshKey}
          onSelectWorkspace={(workspace) => { openNewSessionTab(workspace); }}
          onCreateWorkspace={handleCreateWorkspace}
          onImportDirectory={() => setImportPickerOpen(true)}
          onSelectSession={s.handleOpenSessionFromHome}
          onNewSession={s.handleHomeNewSession}
          runningSessionIds={sessionActivity.runningIds}
          onOpenSettings={() => switchTab("settings")}
          onOpenWorkspaceSettings={openWorkspaceSettings}
        />
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }}>
        <MobilePageTitle
          title="会话"
          actions={(
            <MobileIconButton label="搜索会话" onClick={() => setSearchOpen(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </MobileIconButton>
          )}
        />

        {/* 分组会话体 = 桌面左栏「项目」同一组件（phoneHome：只渲染项目头 + 分组/平铺体，
            导航三行/内置搜索/归档行/底条不渲染）。样式、折叠（pi-tree-collapsed）、
            彩色首字头像、每组 5 条 + 显示更多、# 分组开关、长按拖拽排序全部继承；
            头像点击 → 工作区页，组头整行 → 收起/展开。 */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ProjectSidebar
            phoneHome
            workspaces={workspaces}
            allSessions={sessions}
            runningSessionIds={sessionActivity.runningIds}
            completedSessionIds={sessionActivity.completedIds}
            selectedSessionId={selectedSession?.id ?? s.homeSession?.id ?? null}
            activeWorkspace={activeWorkspace}
            activeConfigPage={null}
            workspacesLoaded={s.workspacesLoaded}
            sessionsLoaded={sessionActivity.loaded}
            onNewSession={handleNewSession}
            onOpenArchive={(workspace) => openModule(workspace, "archive")}
            onReorderWorkspaces={s.handleReorderWorkspaces}
            onOpenWorkspaceHome={openWorkspacePage}
            onSelectSession={handleSelectSession}
            onSelectSearchHit={handleSelectSearchHit}
            sessionListVersion={sessionActivity.listVersion}
            onOpenSessionInNewTab={s.openSessionTab}
            onSessionRemoved={handleSessionRemoved}
            onCreateWorkspace={handleCreateWorkspace}
            onImportDirectory={() => setImportPickerOpen(true)}
            onOpenCenterPage={handleOpenCenterPage}
          />
        </div>
        {/* 停用/不可用工作区不在分组体里（瘦身后侧栏不渲染暗淡行）：页脚一条安静入口
            保住重启用路径（工作区设置里能看到全部工作区）。 */}
        {unselectableWorkspaces.length > 0 && (
          <button
            type="button"
            onClick={() => openWorkspaceSettings(unselectableWorkspaces[0])}
            style={{
              position: "absolute", left: 16, bottom: 22, maxWidth: "calc(100% - 96px)",
              display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
              border: "1px solid var(--border)", borderRadius: 999, background: "var(--bg-panel)",
              color: "var(--text-dim)", fontSize: 11, cursor: "pointer", zIndex: 2, whiteSpace: "nowrap",
            }}
          >
            <WorkspaceModuleIcon kind="ws-settings" />
            {unselectableWorkspaces.length} 个工作区已停用/不可用 · 管理
          </button>
        )}

        {/* 右下 FAB：新建会话（拇指热区）。 */}
        <button
          type="button"
          onClick={handleNewSession}
          aria-label="新建会话"
          title="新建会话"
          style={{
            position: "absolute", right: 16, bottom: 16, width: 52, height: 52, borderRadius: "50%",
            border: 0, background: "var(--accent)", color: "#fff", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 6px 18px rgba(0,0,0,0.28)", zIndex: 2,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

      </div>
    );
  };

  // ---- Skill tab ------------------------------------------------------------
  // 手机原生三页（MobileSkillsPages），数据层 useMobileSkills 与桌面 SkillsConfig
  // 走同一套 API。启停全局生效（frontmatter 开关）；列表 = 全局 + 当前 cwd 项目层。
  // hook 挂在壳层：推入的详情/安装页与根页列表共享同一份状态。
  const renderSkillsTab = () => (
    <MobileSkillsList
      state={skillsState}
      onOpenDetail={(skill) => push({ kind: "skill-detail", filePath: skill.filePath })}
      onOpenInstall={() => push({ kind: "skill-install" })}
    />
  );

  // ---- 设置 tab -------------------------------------------------------------
  // 根页 = 索引（phoneTab 省略 工作区/Skills/归档 三行；平板壳的设置目的地页仍是
  // 全量索引）。行点击 → 推入 settings-sub 子页（导航统一：设置子页与其他推入页
  // 同一条栈、同一条 tab 栏规则、同一个 MobileNavBar 页头——面板 headerless 只出
  // 正文，不再有「面板自管子页导航」的旁路）。共享 settingsPage 手机端不再消费
  // （它是平板壳设置目的地页的页内分区状态）。
  const renderSettingsTab = () => (
    <SettingsPanel
      phoneTab
      page="index"
      onPageChange={(page) => { if (page !== "index") push({ kind: "settings-sub", page }); }}
      workspace={activeWorkspace}
      settingsCwd={settingsCwd ?? ""}
      workspaceSlot={null}
      onModelsSaved={() => s.setModelsRefreshKey((key) => key + 1)}
      onPluginsReloaded={() => s.setSessionKey((key) => key + 1)}
      sessionId={selectedSession?.id ?? null}
    />
  );

  // ---- 推入页 ---------------------------------------------------------------
  const renderPushedPage = (page: PushPage, index: number) => {
    if (page.kind === "chat") return null;
    const backLabel = backLabelFor(index);
    // 设置子页（导航统一）：壳出 MobileNavBar（‹ 设置 + 子页标题，单标题不放
    // meta），面板 headerless 只出正文；‹ = 弹栈回索引（栈底即设置索引根页）。
    // Agents 例外：settings-sub agents 由手机原生三页宿主（MobileAgentsList），
    // 页头动作槽挂 ＋ 新建——不再内嵌桌面 AgentsConfig 分栏（190px 列表压表单）。
    if (page.kind === "settings-sub" && page.page === "agents") {
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <MobileNavBar
            title="Agents"
            onBack={pop}
            backLabel={backLabel}
            actions={(
              <MobileIconButton label="新建子代理" onClick={pushAgentCreate} disabled={!agentsState.cwd}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </MobileIconButton>
            )}
          />
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <MobileAgentsList
              state={agentsState}
              onOpenDetail={(profile) => push({ kind: "agent-detail", profileKey: agentProfileKey(profile) })}
              onOpenCreate={pushAgentCreate}
            />
          </div>
        </div>
      );
    }
    if (page.kind === "settings-sub") {
      const { title } = settingsSubpageHeader(page.page, settingsCwd ?? "");
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <MobileNavBar title={title} onBack={pop} backLabel={backLabel} />
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <SettingsPanel
              headerless
              page={page.page}
              onPageChange={() => {}}
              workspace={activeWorkspace}
              settingsCwd={settingsCwd ?? ""}
              workspaceSlot={null}
              onModelsSaved={() => s.setModelsRefreshKey((key) => key + 1)}
              onPluginsReloaded={() => s.setSessionKey((key) => key + 1)}
              sessionId={selectedSession?.id ?? null}
            />
          </div>
        </div>
      );
    }
    // Skill 详情 / 安装：不绑定工作区（作用域由 skillsState 自带）。
    if (page.kind === "skill-detail") {
      const skill = skillsState.skills.find((item) => item.filePath === page.filePath);
      if (!skill) {
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <MobileNavBar title="Skill" onBack={pop} backLabel={backLabel} />
            <div style={{ padding: "40px 24px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
              该 Skill 已不在列表中（可能已被移除或切换了作用域）。
            </div>
          </div>
        );
      }
      return (
        <MobileSkillDetail
          state={skillsState}
          skill={skill}
          cwd={settingsCwd ?? ""}
          onBack={pop}
          backLabel={backLabel}
          onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath))}
        />
      );
    }
    if (page.kind === "skill-install") {
      return (
        <MobileSkillInstall
          state={skillsState}
          cwd={settingsCwd ?? ""}
          onBack={pop}
          backLabel={backLabel}
        />
      );
    }
    // Agents 详情 / 编辑（数据层 agentsState；profileKey 失效 = 配置已被删或列表
    // 未加载，出安静的缺失态——与 Skill 详情缺失同构）。
    if (page.kind === "agent-detail") {
      const profile = agentsState.profiles.find((item) => agentProfileKey(item) === page.profileKey);
      if (!profile) {
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <MobileNavBar title="Agents" onBack={pop} backLabel={backLabel} />
            <div style={{ padding: "40px 24px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
              该子代理已不在列表中（可能已被删除或切换了作用域）。
            </div>
          </div>
        );
      }
      return (
        <MobileAgentDetail
          state={agentsState}
          profile={profile}
          onBack={pop}
          backLabel={backLabel}
          onEdit={() => pushAgentEdit(profile)}
          onDuplicate={() => pushAgentDuplicate(profile)}
          onDeleted={pop}
        />
      );
    }
    if (page.kind === "agent-edit") {
      return (
        <MobileAgentEdit
          state={agentsState}
          seed={page.seed}
          onBack={pop}
          backLabel={backLabel}
          onSaved={(saved) => replaceTop({ kind: "agent-detail", profileKey: agentProfileKey(saved) })}
        />
      );
    }
    const workspace = resolveWorkspace(page.workspaceId);
    if (!workspace) return null;
    switch (page.kind) {
      case "workspace":
        // 二级页：顶栏 ⋯ 承载 文件/工作项/知识库/Loops/工作区设置（原一级首页 ⋯ 下沉），
        // 正文 = hero + 新建会话 + 会话列表 + 已归档会话（MobileWorkspacePage）。
        return (
          <MobileWorkspacePage
            workspace={workspace}
            workspaces={workspaces}
            sessions={sessions}
            onBack={pop}
            backLabel={backLabel}
            onNewSession={() => { openNewSessionTab(workspace); }}
            onOpenModule={(kind) => openModule(workspace, kind)}
            onOpenSettings={() => openWorkspaceSettings(workspace)}
            onOpenArchive={() => openModule(workspace, "archive")}
            onSelectSession={handleSelectSession}
            onSessionDeleted={handleSessionRemoved}
          />
        );
      case "files":
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <MobileNavBar title="文件" onBack={pop} backLabel={backLabel} />
            <div style={{ flex: 1, minHeight: 0 }}>
              <FilesExplorerPanel
                key={workspace.id}
                workspace={workspace}
                explorerRefreshKey={explorerRefreshKey}
                onOpenFile={handleOpenFile}
                reveal={loopFilesReveal ?? undefined}
              />
            </div>
          </div>
        );
      case "work-items": {
        // 手机原生工作项列表页（MobileWorkItemsPages，2026-10）：行点击 / ＋ 再推一层
        // 详情 / 新建子页，‹ 回列表。深链形态：页面身份绑定 centerPage.workspaceId，
        // ‹返回 = 清 centerPage + URL 回写（映射 effect 收回本页）；推详情时同步 &item=。
        const deeplink = Boolean(page.deeplink && centerPage?.kind === "work-items");
        const pageWorkspace = deeplink && centerPage?.kind === "work-items"
          ? resolveWorkspace(centerPage.workspaceId) ?? workspace
          : workspace;
        return (
          <MobileWorkItemsPage
            key={pageWorkspace.id}
            workspace={pageWorkspace}
            onBack={deeplink ? closeWorkItemsDeeplink : pop}
            backLabel={backLabel}
            onOpenItem={(itemKey) => {
              if (deeplink) navigateUrl(buildWorkItemsPageUrl(pageWorkspace.id, itemKey), true);
              push({ kind: "work-item-detail", workspaceId: pageWorkspace.id, itemKey, deeplink });
            }}
            onCreate={(type) => push({ kind: "work-item-create", workspaceId: pageWorkspace.id, type })}
            initialItemKey={deeplink ? workItemsItemKeyRef.current : undefined}
            onConsumedInitialItem={() => { workItemsItemKeyRef.current = null; }}
            createRequest={deeplink ? undefined : createWorkItemRequest}
            onConsumedCreateRequest={() => setCreateWorkItemRequest(null)}
          />
        );
      }
      case "work-item-detail":
        return (
          <MobileWorkItemDetailPage
            key={`${workspace.id}:${page.itemKey}`}
            workspace={workspace}
            itemKey={page.itemKey}
            onBack={() => {
              if (page.deeplink) navigateUrl(buildWorkItemsPageUrl(workspace.id), true);
              pop();
            }}
            backLabel={backLabel}
            onOpenConversation={handleOpenConversation}
            onOpenLoopsRecovery={() => {
              if (page.deeplink) closeWorkItemsDeeplink();
              replaceTop({ kind: "loops", workspaceId: workspace.id });
            }}
          />
        );
      case "work-item-create":
        return (
          <MobileWorkItemCreatePage
            key={workspace.id}
            workspace={workspace}
            initialType={page.type}
            onBack={pop}
            backLabel={backLabel}
            // 创建成功 → 本页原地换成详情页：‹ 直接回列表，不会退回已提交的表单。
            onCreated={(itemKey) => replaceTop({ kind: "work-item-detail", workspaceId: workspace.id, itemKey })}
          />
        );
      case "knowledge":
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <MobileNavBar title="知识库" onBack={pop} backLabel={backLabel} />
            <KnowledgeBrowser
              key={workspace.id}
              workspace={workspace}
              onOpenFile={handleOpenFile}
              refreshKey={explorerRefreshKey}
            />
          </div>
        );
      case "loops":
        return (
          <LoopsDockPanel
            key={workspace.id}
            workspace={workspace}
            refreshKey={loopsRefreshKey}
            onChanged={() => setLoopsRefreshKey((key) => key + 1)}
            onRunLoop={(name) => handleRunLoopDirect(workspace, name)}
            listHeader={(
              <MobileNavBar title="Loops" onBack={pop} backLabel={backLabel} />
            )}
          />
        );
      case "archive":
        return (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <MobileNavBar title="归档" onBack={pop} backLabel={backLabel} />
            <ArchiveModal
              embedded
              workspaceId={workspace.id}
              workspacePath={workspace.path}
              onChanged={() => setRefreshKey((key) => key + 1)}
            />
          </div>
        );
      case "ws-settings":
        // 单工作区设置（手机原生分组卡片页；PATCH 响应合并回壳列表，409 整表重拉）。
        return (
          <MobileWorkspaceSettings
            workspace={workspace}
            onBack={pop}
            backLabel={backLabel}
            onWorkspaceUpdated={(updated) => {
              s.setWorkspaces((current: WorkspaceSummary[]) =>
                current.map((w) => (w.id === updated.id ? updated : w)),
              );
            }}
            onReloadWorkspaces={() => { void s.loadWorkspaces(); }}
            onDeleted={(deleted) => {
              handleWorkspaceDeleted(deleted);
              resetStack();
            }}
            onOpenSkills={() => {
              if (isWorkspaceSelectable(workspace)) ensureWorkspaceContext(workspace);
              switchTab("skills");
            }}
          />
        );
      default:
        return null;
    }
  };

  const topIndex = pushStack.length - 1;
  const topPage = top && top.kind !== "chat" ? top : null;

  return (
    <div
      style={{
        display: "flex", flexDirection: "column",
        height: "var(--app-vh)", overflow: "hidden", background: "var(--bg)",
        // black-translucent 沉浸式状态栏：根容器让出顶部/左右安全区；底部由
        // tab 栏自理（推入页/聊天 composer 各自处理底部安全区，与旧目的地页同）。
        paddingTop: "env(safe-area-inset-top)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        boxSizing: "border-box",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        {/* 聊天层：最底、持久挂载（SSE 不断）；栈顶为聊天时上层全隐藏即可见。 */}
        {chatMounted && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", zIndex: 0 }}>
            <ChatToolbar onBack={handleBackFromChat} backLabel={chatBackLabel} moreMenuExtras={chatMenuExtras} />
            <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
              {renderChatBody()}
            </div>
          </div>
        )}

        {/* tab 根面（会话首页 / Skill / 设置）：有推入时隐藏（display:none 保滚动位）。 */}
        <div
          style={{
            position: "absolute", inset: 0, zIndex: 1, background: "var(--bg)",
            display: top === null ? "flex" : "none", flexDirection: "column",
          }}
        >
          {mobileTab === "sessions" && renderSessionsHome()}
          {mobileTab === "skills" && renderSkillsTab()}
          {mobileTab === "settings" && renderSettingsTab()}
        </div>

        {/* 栈顶推入页（非聊天）。 */}
        {topPage && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
            {renderPushedPage(topPage, topIndex)}
          </div>
        )}

        {/* File viewer / session viewer overlay — full-screen（文件打开管线不变）。 */}
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
      </div>

      {/* 底部 tab 栏：唯一定期导航；任何推入页（含设置子页）都隐藏它。 */}
      {tabBarVisible && (
        <nav className="mobile-tabbar" aria-label="主导航">
          {TAB_ENTRIES.map((entry) => {
            const active = mobileTab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={entry.label}
                onClick={() => switchTab(entry.id)}
                className={active ? "mobile-tabbar-item is-active" : "mobile-tabbar-item"}
              >
                {entry.icon}
                <span>{entry.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        allSessions={sessions}
        selectedSessionId={selectedSession?.id ?? s.homeSession?.id ?? null}
        refreshKey={sessionActivity.listVersion}
        onSelectSession={handleSelectSearchHit}
        onNewSession={handleNewSession}
        onCreateWorkspace={handleCreateWorkspace}
        onImportDirectory={() => setImportPickerOpen(true)}
        onOpenCenterPage={handleOpenCenterPage}
      />
    </div>
  );
}
