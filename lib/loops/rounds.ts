/** web 侧轮控制（spec §4/§5.2，S3/S4）：全部走现有 daemon 会话面 + pi-loop
 *  纯逻辑，无 daemon 新路由。依赖全部可注入（.test.mjs 直 import 测试）。 */
import { hostname } from "node:os";
import type { LoopDeclaration } from "../../pi-loop/protocol.ts";
import {
  acquireRoundLock,
  isRoundLockStale,
  readRoundLock,
  releaseRoundLock,
  updateRoundLock,
  type RoundLockHolder,
} from "../../pi-loop/round-lock.ts";
import { writeLastrun } from "../../pi-loop/due.ts";
import { buildRoundPrompt } from "../../pi-loop/contract.ts";

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
  // stale 判定与抢占/状态同公式（sessionId 感知）：带 sessionId 的手动轮锁
  // （pid=web 进程）在 web 重启后仍可被正确停止——destroy 其 daemon 会话。
  if (isRoundLockStale(lock, declaration.maxMinutes * 60_000 + 15 * 60_000)) {
    releaseRoundLock(declaration.dir); // stale 锁顺手清理（与 stale-takeover 同效果）
    return "not-running";
  }
  if (lock.kind === "beat") return "beat-held";
  if (!lock.sessionId) return "not-running"; // 锁先于会话建立——轮可能仍在启动，不释放
  await deps.destroySession(lock.sessionId);
  try {
    await deps.reap(declaration.workspacePath);
  } catch {
    /* 收割失败不掩盖停止（spawner 既有口径） */
  }
  releaseRoundLock(declaration.dir);
  return "stopped";
}

export class RoundBusyError extends Error {
  constructor(loopName: string) {
    super(`loop ${loopName} 的本轮已在运行`);
    this.name = "RoundBusyError";
  }
}

export interface LaunchRoundDeps {
  /** daemonProxy().createSession —— POST /v1/sessions（不带 command：sessionId
   *  要进开场合同第 3 条，而它建完会话才知道 → 两步走）。 */
  createSession: (input: { cwd: string }) => Promise<{ sessionId: string; cwd?: string; sessionFile?: string }>;
  /** daemonProxy().sendSessionCommand —— POST /v1/sessions/:id/commands。 */
  sendCommand: (sessionId: string, command: { type: string; [key: string]: unknown }) => Promise<unknown>;
  destroySession: (sessionId: string) => Promise<unknown>;
}

/** 手动起一轮（spec §4，S3）：acquire 锁（kind daemon，pid=web 进程）→ 写
 *  .lastrun（避免下一心跳立即重跑，host §4）→ 建会话 → 回填锁内 sessionId →
 *  命名 → 发合同（daemon 形态，含 sessionId 行）。成功后锁**保持持有**——无人
 *  await 轮结束，靠 stale 窗口（maxMinutes+15min）兜底回收，至多丢一个后续
 *  心跳槽（anacron-lite 不放大）；stop 路由会主动释放。失败路径释放锁 +
 *  best-effort destroy 半建会话。无 D9 钩子（人在场，不自动归档）。 */
export async function launchManualRound(
  declaration: LoopDeclaration,
  opts: { itemKey?: string } = {},
  deps: LaunchRoundDeps,
): Promise<{ sessionId: string; cwd?: string; sessionFile?: string }> {
  const holder: RoundLockHolder = { pid: process.pid, host: hostname(), kind: "daemon" };
  if (!acquireRoundLock(declaration.dir, holder, { maxStaleMs: declaration.maxMinutes * 60_000 + 15 * 60_000 })) {
    throw new RoundBusyError(declaration.loopName);
  }
  let sessionId: string | undefined;
  try {
    writeLastrun(declaration.dir, new Date());
    const created = await deps.createSession({ cwd: declaration.workspacePath });
    sessionId = created.sessionId;
    updateRoundLock(declaration.dir, { sessionId });
    const slot = new Date().toISOString().slice(0, 16).replace("T", " ");
    try {
      await deps.sendCommand(sessionId, { type: "set_session_name", name: `${declaration.loopName} · 手动 ${slot}` });
    } catch {
      /* 命名是装饰性的——会话照常跑（spawner 既有口径） */
    }
    await deps.sendCommand(sessionId, {
      type: "prompt",
      message: buildRoundPrompt(declaration, {
        sessionId,
        ...(opts.itemKey ? { extraInstructions: `本轮优先处理工作项 ${opts.itemKey}（人手动指定）。` } : {}),
      }),
    });
    return { sessionId, cwd: created.cwd, sessionFile: created.sessionFile };
  } catch (error) {
    if (sessionId) {
      try { await deps.destroySession(sessionId); } catch { /* 尽力 */ }
    }
    releaseRoundLock(declaration.dir);
    throw error;
  }
}
