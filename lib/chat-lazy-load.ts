export const VISIBLE_PAGE_SIZE = 50;

/** 首渲染分帧（staged first render）：会话首开/切换时初始只挂这么多条，
 *  首屏内容以低成本尽快出现，随后由 ChatWindow 的 rAF 链按
 *  STAGED_VISIBLE_STEP 每帧补齐到稳态窗口 VISIBLE_PAGE_SIZE。
 *  动机：dev 冷 JIT 下首开大会话一次性同步挂载满窗 50 条
 *  （react-markdown 全家桶 + Prism）会把主线程占满，「正在加载会话…」
 *  久挂数秒（消息到达与 loading=false 同 tick 批处理，占位符期间即渲染期）。
 *  分帧只影响首渲染节奏；哨兵 observer 的滚动增长语义不变（短内容时
 *  哨兵可见会直接整页跳满，天然兼容——短内容挂载本来就便宜）。 */
export const INITIAL_VISIBLE_COUNT = 10;

/** 分帧步长：每帧（rAF）补齐的条数。 */
export const STAGED_VISIBLE_STEP = 10;

/** 首渲染分帧的补齐目标：不超过稳态窗口，也不超过实际消息数。 */
export function getStagedTargetCount(totalCount: number, stableWindow = VISIBLE_PAGE_SIZE): number {
  return Math.max(0, Math.min(stableWindow, totalCount));
}

/** 距尾容差（px）：视口底进入该窗口即视为"在尾部"。 */
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

/** scroll-to-latest 按钮可见性（upstream 1eb5e66）：纯谓词，独立于
 *  chat-scroll-follow 的跟随附着启发（后者有自己的重附着语义与 120px 近底窗口）。 */
export function shouldShowScrollToLatest(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  if (scrollHeight <= clientHeight) return false;
  return !isScrollAtTail(scrollTop, clientHeight, scrollHeight, tolerance);
}
