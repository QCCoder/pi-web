/**
 * 聊天流式自动跟随的滚动决策（纯逻辑）。
 *
 * `useAgentSession` 的滚动监听/跟随 effect 与 `chat-scroll-follow.test.mjs` 共用这一份实现（无双实现）。
 * 状态机回答一个问题：**流式增量到达时，视口要不要贴底（跟随）？**
 *
 * 事件与状态：
 * - `noteUserScrollIntent` —— wheel / touchstart / touchmove / 滚动键 / pointerdown 到达时刷新意图窗口。
 * - `handleScrollEvent`    —— scroll 事件（用户与程序化贴底都会派发）维护 allowed / lastScrollTop。
 * - `shouldFollowStream`   —— 流式增量帧的跟随决策（含竞态护栏）。
 * - `noteProgrammaticScroll` —— scrollToBottom 执行后刷新程序化忽略窗。
 *
 * 关键不变量：**程序化跟随只会向下滚（scrollTop 增大）**。scrollTop 减小且用户意图新鲜，
 * 只可能来自用户上滑 —— 无论离底多近都必须立刻停跟随，否则流式增量会把视口反复拽回底部（抖动拉锯）。
 * 恢复跟随同理需要佐证：输入事件覆盖不到的滚动路径（滚动条/最小地图长拖超过意图窗口、
 * 抬指后的惯性滚动）会持续产生带内 scroll 事件却无意图佐证 —— 近底恢复必须等到
 * scrollTop 实际增大（用户明确向下滚回）或新的输入佐证，否则与未停稳的上滑逐帧拉锯。
 */

/** 程序化贴底（scrollIntoView）后的 scroll 事件忽略窗。 */
export const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
/** 距底不超过此值视为“在最底部”，滚回底部即恢复自动跟随。 */
export const SCROLL_NEAR_BOTTOM_PX = 120;
/** scrollTop 单事件减小超过此值视为“用户上滑”（亚像素/取整噪声不算）。 */
export const SCROLL_USER_UP_JITTER_PX = 0.5;
/** wheel/touch/按键/点按之后的用户滚动意图窗口长度。 */
export const USER_SCROLL_INTENT_MS = 1200;

export interface ScrollFollowState {
  /** false = 用户上滑阅读中，流式增量不再贴底。 */
  allowed: boolean;
  /** 上一个 scroll 事件的 scrollTop（方向判定基准）。 */
  lastScrollTop: number;
  /** 最近一次用户滚动输入的时间戳 + USER_SCROLL_INTENT_MS。 */
  intentUntil: number;
  /** 最近一次程序化贴底的时间戳 + PROGRAMMATIC_SCROLL_IGNORE_MS。 */
  ignoreUntil: number;
}

export function createScrollFollowState(): ScrollFollowState {
  return { allowed: true, lastScrollTop: 0, intentUntil: 0, ignoreUntil: 0 };
}

/** wheel / touchstart / touchmove / 滚动键 / pointerdown → 刷新用户滚动意图窗口。 */
export function noteUserScrollIntent(state: ScrollFollowState, now: number): void {
  state.intentUntil = now + USER_SCROLL_INTENT_MS;
}

/**
 * scroll 事件处理（用户与程序化贴底事件都会进来）。
 *
 * 判定顺序是本模块的核心，调整前先读文件头注释：
 * 1. **用户上滑判定最先**。旧顺序把 120px 近底恢复分支放在前面：流式期间小幅上滑
 *    （<120px，一个滚轮刻度）的事件先撞上“恢复跟随”提前返回，上滑判定执行不到，
 *    下一个流式增量又贴底 —— 表现为“AI 回复时上滑一点就被拽回，来回抖动”。
 *    程序化跟随只会向下滚，scrollTop 减小且意图新鲜只可能是用户在往上滚，
 *    无论离底多近都必须停跟随。
 * 2. 近底恢复：向下滚回底部附近（或程序化贴底自身的事件）恢复跟随 —— 用户停跟随后
 *    想重新跟上只需滚到底；程序化贴底事件在此自愈为 no-op。
 * 3. 其余：程序化忽略窗内丢弃；意图过期后没有用户输入佐证，不能凭 scrollTop 变化停跟随。
 */
export function handleScrollEvent(
  state: ScrollFollowState,
  scrollTop: number,
  distanceFromBottom: number,
  now: number,
): void {
  const lastScrollTop = state.lastScrollTop;
  state.lastScrollTop = scrollTop;
  // 1) 用户上滑判定（先于近底恢复，见函数头注释）。
  if (scrollTop < lastScrollTop - SCROLL_USER_UP_JITTER_PX && now < state.intentUntil) {
    state.allowed = false;
    return;
  }
  // 2) 滚回底部附近 → 恢复自动跟随（配合发送时的重置，双向都可恢复）。
  //    但恢复需要佐证（三选一）：本就在跟随（程序化贴底自愈）/ 输入意图新鲜
  //    （wheel/touch 刚发生）/ scrollTop 在增大（向下滚回底部 —— 向下惯性在输入
  //    事件停止后仍会持续派发 scroll 事件）。三者皆无的带内 scroll 事件只可能是
  //    “尚未停稳的上滑”（长拖/抬指后动量，输入监听覆盖不到）——此刻恢复跟随
  //    就会和流式增量逐帧拉锯（“上划被拽回底部”的抖动）。allowed=false 期间程序化
  //    贴底已被 gate 拦住，scrollTop 增大不可能是程序化跟随自己。
  if (distanceFromBottom <= SCROLL_NEAR_BOTTOM_PX) {
    if (state.allowed || now < state.intentUntil || scrollTop > lastScrollTop + SCROLL_USER_UP_JITTER_PX) {
      state.allowed = true;
    }
    return;
  }
  // 3) 忽略窗内视为程序化滚动；意图已过期则无用户输入佐证，都不动 allowed。
  if (now < state.ignoreUntil) return;
  if (now > state.intentUntil) return;
  // 兜底：意图新鲜、不在忽略窗、又远离底部 —— 视为用户主动离开底部。
  state.allowed = false;
}

/**
 * 流式增量帧的跟随决策。true = 调用方执行贴底（scrollIntoView + noteProgrammaticScroll）。
 *
 * 竞态护栏：用户输入刚发生（wheel/touch 已收到、对应 scroll 事件还没派发完成停跟随）
 * 且当前已远离底部时，跳过本帧跟随 —— 此刻贴底会落在底部触发 near-bottom 分支把跟随
 * 重新打开，用户被永远拽在底部。
 */
export function shouldFollowStream(state: ScrollFollowState, distanceFromBottom: number, now: number): boolean {
  if (!state.allowed) return false;
  const farFromBottom = distanceFromBottom > SCROLL_NEAR_BOTTOM_PX;
  if (farFromBottom && now < state.intentUntil) return false;
  return true;
}

/** scrollToBottom 执行后调用：刷新程序化滚动忽略窗。 */
export function noteProgrammaticScroll(state: ScrollFollowState, now: number): void {
  state.ignoreUntil = now + PROGRAMMATIC_SCROLL_IGNORE_MS;
}
