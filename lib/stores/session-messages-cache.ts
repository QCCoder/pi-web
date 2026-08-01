/**
 * session-messages-cache.ts
 *
 * Session 详情数据的内存 LRU 缓存（REQ-0001 决策 2、3、6）。
 *
 * 目的：消除「切走再切回同一个 session 时先清空 → 等磁盘全量读取」的可见空窗。
 * 切回时若缓存命中，立即用缓存数据填充 UI；同时带上缓存的 revision 作为
 * If-None-Match 发条件请求——文件未变则 304 复用缓存，变化才覆盖为最新。
 *
 * 淘汰策略由 createMapStore 的 LRU 承担（set 时提升到最新 + 超容量淘汰最旧），
 * 因此不需要像 Proma 那样手写 setSessionMessagesCache。
 */

import type { SessionData } from "@/hooks/useAgentSession";
import { createMapStore, type MapStore } from "./create-map-store";

/** 最多缓存的 session 数量（含完整消息，按 LRU 淘汰）。 */
export const SESSION_MESSAGES_CACHE_MAX = 15;

export interface SessionMessagesCacheEntry {
  /** 完整 SessionData（含 context.messages / tree / leafId 等）。 */
  data: SessionData;
  /** 服务端 ETag，下次切回时作为 If-None-Match 发出。 */
  revision: string | undefined;
  /** 写入时间戳，便于调试与将来按 TTL 兜底。 */
  loadedAt: number;
}

export const sessionMessagesCache: MapStore<string, SessionMessagesCacheEntry> =
  createMapStore<string, SessionMessagesCacheEntry>({
    maxSize: SESSION_MESSAGES_CACHE_MAX,
  });

/** 读取缓存的 session 数据（未命中返回 undefined）。 */
export function getCachedSession(
  sessionId: string,
): SessionMessagesCacheEntry | undefined {
  return sessionMessagesCache.get(sessionId);
}

/** 写入或刷新缓存条目（LRU 自动提升为最新并按需淘汰）。 */
export function setCachedSession(
  sessionId: string,
  data: SessionData,
  revision: string | undefined,
): void {
  sessionMessagesCache.set(sessionId, {
    data,
    revision,
    loadedAt: Date.now(),
  });
}

/** 清除单个 session 的缓存（session 被删除时调用）。 */
export function dropCachedSession(sessionId: string): void {
  sessionMessagesCache.delete(sessionId);
}
