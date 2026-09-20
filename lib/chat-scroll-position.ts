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
// Per-session position store（模块级：ChatWindow 会话稳定不重挂，切回同一
// 会话（含跨 workspace 面板重开）都能读回上次位置。条目极小，量级=访问过的
// 会话数。）
// ---------------------------------------------------------------------------

const SESSION_SCROLL_POSITIONS = new Map<string, ChatScrollPosition>();

export function readChatScrollPosition(sessionId: string): ChatScrollPosition | null {
  return SESSION_SCROLL_POSITIONS.get(sessionId) ?? null;
}

export function writeChatScrollPosition(sessionId: string, position: ChatScrollPosition): void {
  SESSION_SCROLL_POSITIONS.set(sessionId, position);
}

export function clearChatScrollPositionsForTest(): void {
  SESSION_SCROLL_POSITIONS.clear();
}
