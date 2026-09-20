/**
 * 作曲器草稿键的唯一解析入口（upstream 6ac87ec 的「真实 composer 键穿进 hook」语义）。
 *
 * 优先级与 ChatWindow 传给 ChatInput 的 draftKey 完全一致：override（桌面/移动端
 * 新会话 tab 的 activeTab.id、home 的 new:__home__）> 已有会话 id > 新会话临时键。
 * useAgentSession 的恢复/换key/废弃清理必须用这同一个键，否则恢复会写进
 * 永不挂载的幽灵键，并随后被废弃清理误删。
 */
export function resolveComposerDraftKey(parts: {
  draftKeyOverride?: string | null;
  sessionId?: string | null;
  newSessionCwd?: string | null;
}): string | undefined {
  if (parts.draftKeyOverride) return parts.draftKeyOverride;
  if (parts.sessionId) return parts.sessionId;
  if (parts.newSessionCwd) return `new:${parts.newSessionCwd}`;
  return undefined;
}

export interface RestoreDropDecision {
  /** 活跃 hook 是否仍挂载（卸载后为 false）。 */
  hookMounted: boolean;
  /** 临时会话是否已 promote 成真实 session。 */
  newSessionPromoted: boolean;
  /** 临时新会话键——仅新会话（isNew）时非空；现有会话为 null（upstream 6ac87ec：
   *  AppShell 在会话存在时传 newSessionDraftKey = null）。 */
  transientNewSessionDraftKey: string | null;
  targetDraftKey: string | undefined;
}

/** 卸载后是否丢弃挂起的恢复。
 *
 *  只针对临时新会话键：废弃一个从未 promote 的新会话时，迟到恢复写进去的草稿
 *  会被废弃清理删掉，提前 return 避免这种自相交互。现有会话（session-id 键）
 *  不在此列——草稿持久化到 session 键上，重挂时照常水合。 */
export function shouldDropRestoreAfterUnmount(o: RestoreDropDecision): boolean {
  return !o.hookMounted && !o.newSessionPromoted && o.targetDraftKey === o.transientNewSessionDraftKey;
}
