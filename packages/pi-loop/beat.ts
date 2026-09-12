/** beat 宿主轮 runner + 心跳入口（design: docs/pi-loop-host-design.md §4/§5）。
 *  spawn `pi --name "<loop> · <slot>" -p --approve "<合同>"` 的一次性轮进程
 *  （cwd=工作区根，detached 自成进程组）；`max_minutes` 超时 → 组 SIGTERM → 3s → SIGKILL。
 *  锁的 acquire/release 由 fire.ts 包住，runner 只负责把 .round.lock 指向真实子 pid ——
 *  detached 子进程自成进程组，宿主 pid 定位不到组，stopRound 必须按子 pid 组杀。 */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { buildRoundPrompt } from "./contract.ts";
import { discoverKitLoops, isWorkspaceHalted, type LoopDeclaration } from "./protocol.ts";
import { runDueRound } from "./fire.ts";
import { readRoundLock, writeRoundLock } from "./round-lock.ts";
import { loopDirPath } from "./paths.ts";
import { reapOrphansByCwd } from "./reap.ts";

export function piBinary(): string {
  return process.env.PI_BIN ?? "pi";
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* 组已消失 */ }
}

export function beatRoundRunner(declaration: LoopDeclaration, opts: { extraInstructions?: string; manual?: boolean } = {}): Promise<void> {
  const slot = new Date().toISOString().slice(0, 16).replace("T", " ");
  const prompt = buildRoundPrompt(declaration, { extraInstructions: opts.extraInstructions, manual: opts.manual });
  return new Promise<void>((resolve, reject) => {
    const child = spawn(piBinary(), ["--name", `${declaration.loopName} · ${slot}`, "-p", "--approve", prompt], {
      cwd: declaration.workspacePath, detached: true, stdio: "ignore",
    });
    // 监听必须在 !child.pid 早退之前挂上：spawn 同步失败时 libuv 仍会异步派发 'error'，
    // 无监听 → uncaught exception 杀死整个 beat/watch 宿主；已 settle 的 promise 上再 reject/resolve 是 no-op。
    // timer 同样无条件先建（const，prefer-const）：spawn 失败路径由下面两个监听 clearTimeout
    // 收掉；回调内快照 child.pid 为空即返回，不杀。
    const timer: NodeJS.Timeout = setTimeout(() => {
      const pid = child.pid;
      if (!pid) return;
      killGroup(pid, "SIGTERM");
      setTimeout(() => killGroup(pid, "SIGKILL"), 3_000).unref?.();
    }, declaration.maxMinutes * 60_000);
    timer.unref?.();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`round exited code=${code ?? "-"} signal=${signal ?? "-"}`));
    });
    if (!child.pid) { reject(new Error("spawn failed")); return; }
    writeRoundLock(declaration.dir, { pid: child.pid, host: hostname(), kind: "beat" });
  });
}

export interface BeatReport { fired: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }

export async function beatRoot(root: string): Promise<BeatReport> {
  const report: BeatReport = { fired: [], skipped: [], failed: [] };
  if (isWorkspaceHalted(root)) return report;
  for (const declaration of discoverKitLoops(root)) {
    const holder = { pid: process.pid, host: hostname(), kind: "beat" as const };
    try {
      const result = await runDueRound(declaration, holder, () => beatRoundRunner(declaration));
      if (result === "fired") report.fired.push(declaration.loopName);
      else report.skipped.push(declaration.loopName + (result === "busy" ? "（本轮已在跑）" : ""));
    } catch (error) {
      try { await reapOrphansByCwd(root); } catch { /* 收割不得掩盖轮错误 */ }
      report.failed.push({ name: declaration.loopName, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

export async function stopRound(root: string, name: string): Promise<{ ok: boolean; message: string }> {
  const lock = readRoundLock(loopDirPath(root, name));
  if (!lock) return { ok: false, message: `loop「${name}」没有在跑的轮` };
  if (lock.kind === "daemon") return { ok: false, message: "由 pi-web daemon 持有，请在 pi-web 界面停止" };
  killGroup(lock.pid, "SIGTERM");
  setTimeout(() => killGroup(lock.pid, "SIGKILL"), 3_000).unref?.();
  await reapOrphansByCwd(root).catch(() => undefined);
  return { ok: true, message: `已终止 loop「${name}」的轮（pid ${lock.pid}）` };
}
