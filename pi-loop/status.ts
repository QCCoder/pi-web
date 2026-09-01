import { discoverKitLoops } from "./protocol.ts";
import { readLastrun } from "./due.ts";
import { nextDue } from "./cron.ts";
import { readRoundLock, isRoundLockStale } from "./round-lock.ts";

export interface LoopStatusEntry {
  name: string; pattern: string; level: string; cron: string; timezone: string; maxMinutes: number;
  paused: boolean; running: boolean; lastRun?: string; nextDue?: string;
}

export function collectStatus(root: string): LoopStatusEntry[] {
  return discoverKitLoops(root, { includePaused: true }).map((declaration) => {
    const lock = readRoundLock(declaration.dir);
    // running 与抢占（acquireRoundLock）同一 stale 公式（spec §5.1：跨宿主一致）。
    // 带 sessionId 的锁（web 手动轮，锁 pid=web 进程）web 重启后 pid 死仍算 running。
    const running = !!lock && !isRoundLockStale(lock, declaration.maxMinutes * 60_000 + 15 * 60_000);
    const last = readLastrun(declaration.dir);
    const next = nextDue(declaration.cron, declaration.timezone, last ?? new Date(0));
    return {
      name: declaration.loopName, pattern: declaration.pattern, level: declaration.level,
      cron: declaration.cron, timezone: declaration.timezone, maxMinutes: declaration.maxMinutes,
      paused: declaration.paused ?? false, running,
      lastRun: last?.toISOString(), nextDue: next?.toISOString(),
    };
  });
}
