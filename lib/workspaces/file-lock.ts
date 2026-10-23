import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { WorkItemConflictError } from "../work-items/errors.ts";

// Re-exported so tests (and callers) can instanceof-check the busy error from
// the same module evaluation — service.ts does the same for work-item errors.
export { WorkItemConflictError };

/** 跨进程工作区短写锁（spec §8.2）：Web 宿主与 pi-loop CLI / 外部加载共用同一套锁。
 *  O_EXCL 创建 `<ws>/.pi/.write-lock`，内容 = owner token
 *  （`${pid}@${hostname}:${uuid}:${createdAtMs}`）。获取失败 → 读持有者：
 *  持有者 pid 死亡或超过 stale 窗（默认 30s，短事务）→ 删锁重试一次；仍失败
 *  → 抛 WorkItemConflictError("workspace write lock is busy")。释放时核对
 *  owner token 再删（不误删他人锁）。删除自身目录内文件不受信任边界影响
 *  （.pi/ 本就是宿主文件区）。 */

export const DEFAULT_LOCK_STALE_MS = 30_000;

export interface LockOwner {
  pid: number;
  hostname: string;
  /** The full owner string written in the lock file — release compares this
   *  verbatim before deleting so a stolen/replaced lock is never removed. */
  token: string;
  createdAt: number;
}

export interface WorkspaceFileLockOptions {
  /** How long a held lock may outlive its creation before it is stealable. */
  staleMs?: number;
  /** Override the lock-file location. `null` disables the file layer entirely
   *  (used when the keyed path does not exist yet — nothing to contend over).
   *  Default: `<workspacePath>/.pi/.write-lock`. */
  lockPath?: string | null;
}

/** Lock file placement: workspace directories get the canonical
 *  `<ws>/.pi/.write-lock`; a plain FILE path (the workspace/session index
 *  callers key the lock by the index file itself) gets a sibling
 *  `<file>.write-lock` — nesting `.pi/` under a file path would collide with
 *  the file itself. Absent path → null (skip the file layer). */
export async function resolveLockPath(keyPath: string): Promise<string | null> {
  try {
    const stats = await stat(keyPath);
    return stats.isDirectory() ? join(keyPath, ".pi", ".write-lock") : `${keyPath}.write-lock`;
  } catch {
    return null;
  }
}

export function formatLockOwner(pid: number, host: string, uuid: string, createdAt: number): string {
  return `${pid}@${host}:${uuid}:${createdAt}`;
}

/** Parse an owner string; null when absent or malformed. */
export function parseLockOwner(content: string): LockOwner | null {
  const trimmed = content.trim();
  // hostname may not contain ':' (same guarantee process.hostname gives), so
  // anchor on the trailing `${uuid}:${createdAt}` tail. Numbered groups —
  // tsconfig targets ES2017 (named groups need ES2018).
  const match = trimmed.match(/^(\d+)@([^:]+):([0-9a-fA-F-]{36}):(\d+)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  const createdAt = Number(match[4]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(createdAt)) return null;
  return { pid, hostname: match[2], token: trimmed, createdAt };
}

/** Read + parse the lock file (sync — lock acquisition is a tiny hot path).
 *  null when the file is absent or unreadable. */
export function readLockOwner(lockPath: string): LockOwner | null {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  return parseLockOwner(content);
}

/** 纯判定：holder pid 不可 kill(0)（已死）或已超 stale 窗 → 可抢占。
 *  null owner 也返回 true（纯函数语义：无从判定）；但获取路径不走这条
 *  快路——未解析的锁经 holderIsStealable 以文件 mtime 兜底，防止抢占
 *  「已创建、owner 串尚未刷入」创建窗内的锁。 */
export function isLockStale(
  owner: LockOwner | null,
  now: number,
  staleMs: number,
): boolean {
  if (!owner) return true;
  if (now - owner.createdAt > staleMs) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM = the process exists but belongs to another user → alive.
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/** Holder is stealable when its lock is provably abandoned: a parseable owner
 *  with a dead pid or an over-window creation time, or an UNPARSEABLE lock
 *  (garbage content — or the open/write creation window where the file exists
 *  but the owner string is not flushed yet). The unparseable case falls back
 *  to the file's mtime: a fresh empty lock is someone mid-acquire and must
 *  not be stolen; only an over-window garbage lock is recoverable. */
export async function holderIsStealable(lockPath: string, staleMs: number): Promise<boolean> {
  const holder = readLockOwner(lockPath);
  if (holder) return isLockStale(holder, Date.now(), staleMs);
  try {
    const stats = await stat(lockPath);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch {
    // Vanished between EEXIST and here — the retry create decides.
    return true;
  }
}

async function tryCreateLock(lockPath: string, owner: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(owner, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Release: only delete the lock when its content still matches OUR owner
 *  token (a stolen/replaced lock belongs to whoever holds it now). */
async function releaseLock(lockPath: string, owner: string): Promise<void> {
  try {
    const content = await readFile(lockPath, "utf8");
    if (content.trim() === owner) await unlink(lockPath);
  } catch {
    // Already gone (stale-steal by a peer) — nothing of ours to clean.
  }
}

/** Run `operation` while holding the workspace file lock. Busy → 409-shaped
 *  WorkItemConflictError, fail-fast (short transactions; callers surface it). */
export async function withWorkspaceFileLock<T>(
  workspacePath: string,
  operation: () => Promise<T>,
  options?: WorkspaceFileLockOptions,
): Promise<T> {
  const lockPath = options?.lockPath !== undefined
    ? options.lockPath
    : await resolveLockPath(workspacePath);
  if (lockPath === null) return operation();
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const owner = formatLockOwner(process.pid, hostname(), randomUUID(), Date.now());
  await mkdir(dirname(lockPath), { recursive: true });
  let acquired = await tryCreateLock(lockPath, owner);
  if (!acquired) {
    // Held: steal once when the holder is provably gone (dead pid) or the
    // lock outlived the stale window, then retry exactly once.
    if (await holderIsStealable(lockPath, staleMs)) {
      await rm(lockPath, { force: true });
      acquired = await tryCreateLock(lockPath, owner);
    }
  }
  if (!acquired) {
    throw new WorkItemConflictError("workspace write lock is busy");
  }
  try {
    return await operation();
  } finally {
    await releaseLock(lockPath, owner);
  }
}
