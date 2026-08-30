/** web 侧轮控制（spec §4/§5.2，S3/S4）：全部走现有 daemon 会话面 + pi-loop
 *  纯逻辑，无 daemon 新路由。依赖全部可注入（.test.mjs 直 import 测试）。 */
import { hostname } from "node:os";
import type { LoopDeclaration } from "../../pi-loop/protocol.ts";
import { isProcessAlive, readRoundLock, releaseRoundLock } from "../../pi-loop/round-lock.ts";

export interface StopRoundDeps {
  /** daemonProxy().destroySession —— DELETE /v1/sessions/:id（wrapper destroy，
   *  中止在飞 prompt）。 */
  destroySession: (sessionId: string) => Promise<unknown>;
  /** pi-loop/reap.ts 的孤儿收割（cwd 收敛到 workspace）。 */
  reap: (workspacePath: string) => Promise<unknown> | void;
}

export type StopOutcome = "stopped" | "not-running" | "beat-held";

export async function stopRound(
  declaration: LoopDeclaration,
  deps: StopRoundDeps,
): Promise<StopOutcome> {
  const lock = readRoundLock(declaration.dir);
  if (!lock) return "not-running";
  const alive = isProcessAlive(lock.pid)
    && Date.now() - lock.startedAt <= declaration.maxMinutes * 60_000 + 15 * 60_000;
  if (!alive) {
    releaseRoundLock(declaration.dir); // stale 锁顺手清理（与 stale-takeover 同效果）
    return "not-running";
  }
  if (lock.kind === "beat") return "beat-held";
  if (!lock.sessionId) return "not-running"; // 锁先于会话建立的启动窗口——等它 settle
  await deps.destroySession(lock.sessionId);
  try {
    await deps.reap(declaration.workspacePath);
  } catch {
    /* 收割失败不掩盖停止（spawner 既有口径） */
  }
  releaseRoundLock(declaration.dir);
  return "stopped";
}
