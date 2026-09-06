/** 统一 fire 序列（host spec §5 时序）：daemon tick 与 beat 共用，跨宿主 TOCTOU 安全。 */
import { acquireRoundLock, releaseRoundLock, type RoundLockHolder } from "./round-lock.ts";
import { shouldFire, writeLastrun } from "./due.ts";
import type { LoopDeclaration } from "./protocol.ts";

export type FireResult = "fired" | "skipped" | "busy";

export async function runDueRound(
  declaration: LoopDeclaration,
  holder: RoundLockHolder,
  runner: () => Promise<void>,
  deps: { now?: () => Date } = {},
): Promise<FireResult> {
  const now = deps.now ?? (() => new Date());
  if (!shouldFire(declaration, now())) return "skipped";
  if (!acquireRoundLock(declaration.dir, holder, { maxStaleMs: declaration.maxMinutes * 60_000 + 15 * 60_000 })) return "busy";
  try {
    if (!shouldFire(declaration, now())) return "skipped"; // 锁内复查
    writeLastrun(declaration.dir, now());
    await runner();
    return "fired";
  } finally {
    releaseRoundLock(declaration.dir);
  }
}

export async function runNow(
  declaration: LoopDeclaration,
  holder: RoundLockHolder,
  runner: () => Promise<void>,
): Promise<"fired" | "busy"> {
  if (!acquireRoundLock(declaration.dir, holder, { maxStaleMs: declaration.maxMinutes * 60_000 + 15 * 60_000 })) return "busy";
  try {
    writeLastrun(declaration.dir, new Date());
    await runner();
    return "fired";
  } finally {
    releaseRoundLock(declaration.dir);
  }
}
