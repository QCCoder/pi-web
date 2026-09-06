/** .round.lock — 跨宿主轮互斥锁（host spec §5）。O_EXCL 原子创建；stale 判定
 *  统一走 isRoundLockStale（sessionId 感知）。 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface RoundLockHolder { pid: number; host: string; kind: "beat" | "daemon"; sessionId?: string }
export interface RoundLockRecord extends RoundLockHolder { startedAt: number }

const LOCK_FILE = ".round.lock";
const DEFAULT_MAX_STALE_MS = 60 * 60_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // EPERM = 活着但无权
  }
}

export function readRoundLock(dir: string): RoundLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as RoundLockRecord;
    return typeof parsed?.pid === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Stale 判定（唯一权威）：无 sessionId 的锁（启动窗口/beat 轮）pid 死即 stale
 *  ——持有进程死=轮死；带 sessionId 的锁（轮会话活在别处，如 web 手动轮锁的
 *  pid=web 进程）一律由时间窗治理，pid 死不判 stale（防 web 重启后心跳双发）。 */
export function isRoundLockStale(
  lock: RoundLockRecord,
  maxStaleMs: number,
): boolean {
  if (lock.sessionId === undefined && !isProcessAlive(lock.pid)) return true;
  return Date.now() - lock.startedAt > maxStaleMs;
}

export function acquireRoundLock(dir: string, holder: RoundLockHolder, opts: { maxStaleMs?: number } = {}): boolean {
  const path = join(dir, LOCK_FILE);
  const existing = readRoundLock(dir);
  if (existing) {
    const stale = isRoundLockStale(existing, opts.maxStaleMs ?? DEFAULT_MAX_STALE_MS);
    if (!stale) return false;
    try { unlinkSync(path); } catch { /* 竞态：别人已抢 */ }
  }
  try {
    writeFileSync(path, JSON.stringify({ ...holder, startedAt: Date.now() }, null, 2), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function releaseRoundLock(dir: string): void {
  try { unlinkSync(join(dir, LOCK_FILE)); } catch { /* ENOENT = 已释放 */ }
}

export function updateRoundLock(dir: string, patch: Partial<RoundLockHolder>): void {
  const current = readRoundLock(dir);
  if (!current) return;
  try { writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ ...current, ...patch }, null, 2)); } catch { /* 尽力 */ }
}

/** 无条件写入（upsert）锁记录 — beat runner 起子进程后把锁指向真实子 pid：
 *  detached 子进程自成进程组，宿主 pid 定位不到组，stopRound 必须按子 pid 组杀。
 *  已有记录（fire.ts 先 acquire 的宿主锁）保留 startedAt。 */
export function writeRoundLock(dir: string, holder: RoundLockHolder): void {
  const current = readRoundLock(dir);
  const record: RoundLockRecord = { ...current, ...holder, startedAt: current?.startedAt ?? Date.now() };
  try {
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify(record, null, 2));
  } catch { /* 尽力 */ }
}
