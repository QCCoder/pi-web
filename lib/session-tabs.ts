import type { SessionInfo } from "./types";
import type { WorkspaceSummary } from "./workspaces/types";
import { workspaceForSession } from "./home-quick-switch.ts";
import type { Tab } from "./tab-types";

/**
 * 会话 tab 模型的纯逻辑层（docs/session-tabs-design.md Phase 1）。
 *
 * tab 的粒度是「会话」而非「工作区」：每个 tab 自带工作区上下文（环境解析
 * 链 activeWorkspace = activeTab.workspace 保持不变），三种 kind ——
 *   session        一个真实会话（id = s:<sessionId>，全局唯一 = U1 去重键）
 *   new-session    composer-only 占位（id = new:<uuid>，首条消息后才转正；
 *                  U1 豁免：同工作区可并存多个，草稿键按 tab id 隔离）
 *   workspace-home 工作区「家」tab = 总览 dashboard（id = ws:<workspaceId>，
 *                  每工作区一个 = U1）
 *
 * 本文件只放纯函数 + 类型；React 状态与 handler 在 components/shell/useAppShellState.ts。
 */

export type SessionTabKind = "session" | "new-session" | "workspace-home";

export interface SessionTabState {
  id: string;
  kind: SessionTabKind;
  workspace: WorkspaceSummary;
  /** kind === "session" 时非空（恢复期由会话列表水合）。 */
  session: SessionInfo | null;
  /** F1：右栏文件面板全套状态跟 tab（fileTabs 不持久化——重载后为空，
   *  持久化最小集只有 tab 身份 + 顺序 + active）。 */
  fileTabs: Tab[];
  activeFileTabId: string | null;
  rightPanelOpen: boolean;
}

export function sessionTabId(sessionId: string): string {
  return `s:${sessionId}`;
}

export function homeTabId(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

export function newSessionTabId(seed: string): string {
  return `new:${seed}`;
}

export function createSessionTab(workspace: WorkspaceSummary, session: SessionInfo): SessionTabState {
  return {
    id: sessionTabId(session.id),
    kind: "session",
    workspace,
    session,
    fileTabs: [],
    activeFileTabId: null,
    rightPanelOpen: false,
  };
}

export function createNewSessionTab(workspace: WorkspaceSummary, id: string): SessionTabState {
  return {
    id,
    kind: "new-session",
    workspace,
    session: null,
    fileTabs: [],
    activeFileTabId: null,
    // 右栏默认关闭（沿用原工作区 tab 的默认；右上角按钮或点开文件时展开）。
    rightPanelOpen: false,
  };
}

export function createHomeTab(workspace: WorkspaceSummary): SessionTabState {
  return {
    id: homeTabId(workspace.id),
    kind: "workspace-home",
    workspace,
    session: null,
    fileTabs: [],
    activeFileTabId: null,
    rightPanelOpen: true,
  };
}

/**
 * C1 分派：会话列表普通点击落在哪。活动 tab 是会话/占位 → 原地变身
 * （morph）；活动 tab 是家 tab → 开新会话 tab（家 tab 是枢纽锚点，不被
 * 导航吃掉）；无活动 tab（首页上下文）→ 走首页管道（from-home）。
 */
export type OpenSessionTarget = "morph" | "new-tab" | "from-home";

export function resolveOpenSessionTarget(activeTab: SessionTabState | null): OpenSessionTarget {
  if (!activeTab) return "from-home";
  if (activeTab.kind === "workspace-home") return "new-tab";
  return "morph";
}

/**
 * X1 邻居规则：关闭 closedId 后激活谁。先左邻、再右邻；一个不剩 → null
 * （回到应用首页）。closedId 不在列表里（已被并发移除）→ null。
 */
export function nextActiveTabId(tabs: SessionTabState[], closedId: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === closedId);
  if (index === -1) return null;
  return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null;
}

/**
 * URL 投影（语法与旧工作区 tab 时代完全一致，applyUrlToTabs 只重映射）：
 *   会话 tab → workspace=<id>&view=chat&session=<sid>
 *   占位 tab → workspace=<id>&view=chat
 *   家 tab   → workspace=<id>&view=overview
 */
export function tabQuery(tab: SessionTabState): string {
  const workspacePart = `workspace=${encodeURIComponent(tab.workspace.id)}`;
  if (tab.kind === "workspace-home") return `${workspacePart}&view=overview`;
  if (tab.kind === "session" && tab.session) {
    return `${workspacePart}&view=chat&session=${encodeURIComponent(tab.session.id)}`;
  }
  return `${workspacePart}&view=chat`;
}

// ---- R2 持久化（localStorage: pi-session-tabs）-------------------------------
// tab 条全量恢复：只有 tab 身份 + 顺序 + active 进存储；fileTabs 与右栏开合
// 不持久化（重载后为默认态）。会话 tab 只存 sessionId（工作区由 cwd 派生，
// 自愈）；占位 tab 必须保留原 id（草稿键 new:<tabId> 跨重载续命）。

export interface StoredSessionTab {
  kind: SessionTabKind;
  sessionId?: string;
  workspaceId?: string;
  /** 仅 new-session：原 tab id（new:<uuid>），恢复时原样沿用。 */
  id?: string;
}

export interface StoredSessionTabs {
  v: 1;
  tabs: StoredSessionTab[];
  activeTabId: string | null;
}

export function serializeTabs(tabs: SessionTabState[], activeTabId: string | null): StoredSessionTabs {
  const stored: StoredSessionTab[] = [];
  for (const tab of tabs) {
    if (tab.kind === "session") {
      if (tab.session) stored.push({ kind: "session", sessionId: tab.session.id });
    } else if (tab.kind === "new-session") {
      stored.push({ kind: "new-session", workspaceId: tab.workspace.id, id: tab.id });
    } else {
      stored.push({ kind: "workspace-home", workspaceId: tab.workspace.id });
    }
  }
  return { v: 1, tabs: stored, activeTabId };
}

export function parseStoredTabs(raw: string | null): StoredSessionTabs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSessionTabs>;
    if (parsed?.v !== 1 || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter((entry): entry is StoredSessionTab => {
      if (!entry || typeof entry !== "object") return false;
      if (entry.kind === "session") return typeof entry.sessionId === "string";
      if (entry.kind === "new-session") return typeof entry.workspaceId === "string";
      if (entry.kind === "workspace-home") return typeof entry.workspaceId === "string";
      return false;
    });
    const activeTabId = typeof parsed.activeTabId === "string" ? parsed.activeTabId : null;
    return { v: 1, tabs, activeTabId };
  } catch {
    return null;
  }
}

export interface RestoreTabsResult {
  tabs: SessionTabState[];
  activeTabId: string | null;
  /** 被静默跳过的条数（会话已删/归档、工作区不可用、形态损坏、重复 id）。 */
  skipped: number;
}

export function restoreTabs(
  stored: StoredSessionTabs | null,
  workspaces: WorkspaceSummary[],
  sessions: SessionInfo[],
): RestoreTabsResult {
  if (!stored) return { tabs: [], activeTabId: null, skipped: 0 };
  const tabs: SessionTabState[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let fallbackSeed = 0;
  for (const entry of stored.tabs) {
    let tab: SessionTabState | null = null;
    if (entry.kind === "session") {
      const session = sessions.find((s) => s.id === entry.sessionId) ?? null;
      const workspace = session ? workspaceForSession(session, workspaces) ?? null : null;
      // 会话不在列表（已删/已归档）或归属工作区不可用 → 跳过（失效 id 静默跳过）。
      if (session && workspace) tab = createSessionTab(workspace, session);
    } else if (entry.kind === "new-session") {
      const workspace = workspaces.find((w) => w.id === entry.workspaceId && w.available) ?? null;
      if (workspace) {
        // 保留原 id（草稿键续命）；存储里的 id 不像 new:* 时给确定性兜底。
        const id = typeof entry.id === "string" && entry.id.startsWith("new:")
          ? entry.id
          : newSessionTabId(`restored-${fallbackSeed++}`);
        tab = createNewSessionTab(workspace, id);
      }
    } else {
      const workspace = workspaces.find((w) => w.id === entry.workspaceId && w.available) ?? null;
      if (workspace) tab = createHomeTab(workspace);
    }
    if (!tab || seen.has(tab.id)) {
      skipped += 1;
      continue;
    }
    seen.add(tab.id);
    tabs.push(tab);
  }
  const activeTabId = stored.activeTabId && tabs.some((tab) => tab.id === stored.activeTabId)
    ? stored.activeTabId
    : null;
  return { tabs, activeTabId, skipped };
}
