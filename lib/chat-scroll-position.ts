/**
 * Per-session chat reading positions (upstream 430fe4d, #723).
 *
 * 纯逻辑：锚点挑选与位置的存取都无 DOM —— ChatWindow 负责测量（capture）与
 * 恢复（apply），本模块只回答「视口顶部此刻锚在哪个 entry 上」以及「把某会话
 * 上次的阅读位置记下来 / 取出来」。
 *
 * 与本地滚动状态机（lib/chat-scroll-follow）的关系：恢复动作由 ChatWindow 走
 * useAgentSession 的 scrollToMessage 执行——它自带 noteUserScrollIntent，恢复到
 * 历史中间后 follow gate 自然保持关闭（新消息不把用户拽走）；只有在底部时才
 * 存 { atBottom: true }，切回后照旧贴底跟随。
 */

export type ChatScrollPosition =
  | { atBottom: true }
  | {
      atBottom: false;
      anchorEntryId: string;
      anchorOffset: number;
    };

export interface ChatScrollAnchorCandidate {
  entryId: string;
  top: number;
  bottom: number;
}

/** 挑出视口顶部（viewportTop）所落在的最后一个 entry 作为锚点；
 *  viewportTop 在所有候选之上时返回第一个，之下时返回最后一个。 */
export function findChatScrollAnchor(
  candidates: ChatScrollAnchorCandidate[],
  viewportTop: number,
): Pick<Extract<ChatScrollPosition, { atBottom: false }>, "anchorEntryId" | "anchorOffset"> | null {
  let candidate = candidates[0];
  for (const item of candidates) {
    if (item.top > viewportTop) break;
    candidate = item;
  }
  if (!candidate) return null;
  return {
    anchorEntryId: candidate.entryId,
    anchorOffset: candidate.top - viewportTop,
  };
}

// ---------------------------------------------------------------------------
// Per-session position store。内存 Map 仍是读路径的权威缓存（rAF 捕捉高频写，
// 不能每帧 JSON.parse）；每次写穿到 localStorage 单条 blob，LRU 只保留最近
// 30 个会话——刷新 / 手机 PWA 后台回收（iOS 杀进程连 sessionStorage 一起清）
// 后按 sessionId 水合回内存（本批 #8 本地改进，共识：key 按 session id）。
// localStorage 不可用 / 写失败（隐私模式、配额、损坏 blob）→ 退化为纯内存，
// 行为与旧版完全一致。
// ---------------------------------------------------------------------------

const STORAGE_KEY = "chat-scroll-positions";
const MAX_PERSISTED_SESSIONS = 30;

const SESSION_SCROLL_POSITIONS = new Map<string, ChatScrollPosition>();

function loadPersistedPositions(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, ChatScrollPosition>;
    for (const [sessionId, position] of Object.entries(parsed)) {
      if (!SESSION_SCROLL_POSITIONS.has(sessionId)) {
        SESSION_SCROLL_POSITIONS.set(sessionId, position);
      }
    }
  } catch {
    // 损坏的 blob 或无 localStorage：保持空缓存，下次写穿会重建。
  }
}

function persistPositions(): void {
  try {
    // Map 迭代序 = 插入序，writeChatScrollPosition 重插到尾 = 最近使用；
    // 超量从头部淘汰最旧会话（淘汰同时作用于内存，两级保持一致）。
    while (SESSION_SCROLL_POSITIONS.size > MAX_PERSISTED_SESSIONS) {
      const oldest = SESSION_SCROLL_POSITIONS.keys().next().value;
      if (oldest === undefined) break;
      SESSION_SCROLL_POSITIONS.delete(oldest);
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(SESSION_SCROLL_POSITIONS)));
  } catch {
    // 写失败（隐私模式/配额）：内存语义不受影响。
  }
}

if (typeof window !== "undefined") loadPersistedPositions();

export function readChatScrollPosition(sessionId: string): ChatScrollPosition | null {
  return SESSION_SCROLL_POSITIONS.get(sessionId) ?? null;
}

export function writeChatScrollPosition(sessionId: string, position: ChatScrollPosition): void {
  SESSION_SCROLL_POSITIONS.delete(sessionId);
  SESSION_SCROLL_POSITIONS.set(sessionId, position);
  persistPositions();
}

export function clearChatScrollPositionsForTest(): void {
  SESSION_SCROLL_POSITIONS.clear();
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
