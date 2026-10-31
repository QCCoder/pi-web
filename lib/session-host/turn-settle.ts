/** 被动等一个已在飞的 turn 收尾：prompt_done / prompt_error / destroy 任一先到
 *  即返回，timeoutMs 是硬天花板（到点 reject）。不发 prompt、无停滞检测——
 *  手动轮人在场，stall 阈值不适用（host 规则：手动轮两者都不管）。与
 *  loop-spawner.waitForRoundSettle（主动发 prompt + stall 轮询）相对。
 *  独立小模块：facade 不能 import loop-spawner（session-archive→facade 成环）。 */
import type { AgentSessionWrapper } from "./registry.ts";

export function waitForTurnSettle(session: AgentSessionWrapper, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`turn settle timed out after ${Math.round(timeoutMs / 60_000)}min`)),
      timeoutMs,
    );
    timer.unref?.();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offDestroy?.();
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    // destroy 先于任何 prompt_done/error 事件触发 — 立即返回而非干等超时。
    const offDestroy = session.onDestroy(() => finish(new Error("session destroyed")));
    const unsubscribe = session.onEvent((event: { type: string; errorMessage?: string }) => {
      if (event.type === "prompt_error") finish(new Error(event.errorMessage ?? "turn prompt failed"));
      if (event.type === "prompt_done") finish();
    });
  });
}
