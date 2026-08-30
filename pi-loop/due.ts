/** .lastrun — 宿主写的机器真相（host spec §6）；STATE.md 的 Last run 行仍是叙事。 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { nextDue } from "./cron.ts";
import type { LoopDeclaration } from "./protocol.ts";

const LASTRUN_FILE = ".lastrun";

export function readLastrun(dir: string): Date | undefined {
  try {
    const raw = readFileSync(join(dir, LASTRUN_FILE), "utf8").trim();
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

export function writeLastrun(dir: string, at: Date): void {
  const target = join(dir, LASTRUN_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, at.toISOString());
  renameSync(tmp, target); // tmp+rename 原子写（先例：session-index）
}

export function shouldFire(declaration: LoopDeclaration, now: Date): boolean {
  const last = readLastrun(declaration.dir)?.getTime() ?? 0;
  const due = nextDue(declaration.cron, declaration.timezone, new Date(last));
  return due !== undefined && now.getTime() >= due.getTime();
}
