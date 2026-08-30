import { discoverKitLoops } from "./protocol.ts";
import { readLastrun } from "./due.ts";
import { nextDue } from "./cron.ts";
import { readRoundLock, isProcessAlive } from "./round-lock.ts";

export interface LoopStatusEntry {
  name: string; pattern: string; level: string; cron: string; timezone: string; maxMinutes: number;
  paused: boolean; running: boolean; lastRun?: string; nextDue?: string;
}

export function collectStatus(root: string): LoopStatusEntry[] {
  return discoverKitLoops(root, { includePaused: true }).map((declaration) => {
    const lock = readRoundLock(declaration.dir);
    const running = !!lock && isProcessAlive(lock.pid)
      && Date.now() - lock.startedAt <= declaration.maxMinutes * 60_000 + 15 * 60_000;
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
