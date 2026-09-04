/** 「开始对话/收养续跑」预填的 pattern 解析（纯函数）。
 *  绑定存 loop 名（S1）；paused = 不存在（S5）——绑到 paused 的按未命中处理。
 *  未命中/未绑定时只在单-loop workspace 自动路由；≥2 个 active loop 并存时可能
 *  有不消费工作项的 loop（如 dev-loop + 非工作项 loop），盲取首个会误路由 ——
 *  返回 undefined，调用方降级为裸 prompt，精确路由靠工作项的显式绑定。 */
export interface PrefillLoopSummary {
  name?: string;
  pattern: string;
  paused?: boolean;
}

export function resolveContractPattern(
  loop: string | undefined,
  loops: PrefillLoopSummary[],
): string | undefined {
  const active = loops.filter((entry) => !entry.paused);
  if (loop) {
    const hit = active.find((entry) => entry.name === loop);
    if (hit) return hit.pattern;
  }
  return active.length === 1 ? active[0].pattern : undefined;
}
