/** 「开始对话/收养续跑」预填的 pattern 解析（spec §3.3 三分支，纯函数）。
 *  绑定存 loop 名（S1）；paused = 不存在（S5）——绑到 paused 的按未命中处理。 */
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
  return active[0]?.pattern;
}
