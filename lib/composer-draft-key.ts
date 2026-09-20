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
