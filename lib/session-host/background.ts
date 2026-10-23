/** In-process host boot & background assembly.
 *
 *  The Next.js Node.js server is now THE single session owner: at boot it
 *  (1) refuses to start when a legacy pi-daemon still owns sessions
 *  (first-deployment migration guard, spec §5.4),
 *  (2) starts the loop kit heartbeat spawner exactly once (globalThis-guarded
 *      — route cold-loading and dev hot reload must never create a second
 *      timer), and
 *  (3) installs shutdown handlers (stop-new-work → abort → record → exit,
 *      spec §5.4).
 *  Background entry points are assembled HERE, never from an interactive
 *  session happening to be open (spec §4). */
import { hostname } from "node:os";
import type { LoopKitSpawner } from "./loop-spawner.ts";
import { getAllRpcSessions } from "./registry.ts";
import type { ExecutionRecord } from "../loops/executions.ts";

export interface ActiveRoundInfo {
  loopName: string;
  workspacePath: string;
  dir: string;
  startedAt: number;
}

interface HostGlobals {
  __piHostBooted?: boolean;
  __piActiveRounds?: Map<string, ActiveRoundInfo>;
  __piLoopSpawnerTimer?: unknown;
  __piShutdownHookInstalled?: boolean;
}

const g = globalThis as typeof globalThis & HostGlobals;

export function markRoundActive(sessionId: string, info: ActiveRoundInfo): void {
  if (!g.__piActiveRounds) g.__piActiveRounds = new Map();
  g.__piActiveRounds.set(sessionId, info);
}

export function clearRoundMark(sessionId: string): void {
  g.__piActiveRounds?.delete(sessionId);
}

export function listActiveRounds(): Array<{ sessionId: string } & ActiveRoundInfo> {
  return Array.from(g.__piActiveRounds?.entries() ?? []).map(([sessionId, info]) => ({ sessionId, ...info }));
}

// ----------------------------------------------------------------------------
// Graceful shutdown (spec §5.4): stop-new-work → abort → record → exit
// ----------------------------------------------------------------------------

export interface ShutdownPlan {
  /** 中断记录：仅为关停时仍在 running set 里的轮写（idle 的登记只是陈旧标记）。 */
  records: ExecutionRecord[];
  /** 计划销毁的轮会话 id（全部登记轮，含 idle）。 */
  destroySessionIds: string[];
}

/** shutdown 内联逻辑的可测纯函数抽取：给定轮登记快照与 running 会话 id 集，
 *  算出要写哪些中断记录、要销毁哪些轮会话。真实销毁范围更大（shutdown 循环
 *  getAllRpcSessions 全量 destroy），这里只声明轮登记面。 */
export function buildShutdownPlan(
  active: Array<{ sessionId: string } & ActiveRoundInfo>,
  runningIds: string[],
): ShutdownPlan {
  const runningBySession = new Set(runningIds);
  const records: ExecutionRecord[] = active
    .filter((round) => runningBySession.has(round.sessionId))
    .map((round) => ({
      schemaVersion: 1 as const,
      runId: round.sessionId,
      kind: "loop-round" as const,
      loopName: round.loopName,
      sessionId: round.sessionId,
      workspacePath: round.workspacePath,
      host: { pid: process.pid, hostname: hostname() },
      startedAt: new Date(round.startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      stopResult: "interrupted-on-shutdown" as const,
      needsAttention: true,
    }));
  return { records, destroySessionIds: active.map((round) => round.sessionId) };
}

/** 宿主关停（spec §5.4）：先停新轮（spawner.stop），再中止全部活跃 wrapper
 *  （SDK destroy → abortBash → killProcessTree 按执行进程组定向杀），为关停时
 *  仍在跑的轮写中断记录（恢复期阻塞该 loop），最后退出。不承诺恢复内存中的
 *  模型调用现场；重启后按文件记录接续。 */
export function registerShutdownHandlers(stopBackground: () => void): void {
  if (g.__piShutdownHookInstalled) return;
  g.__piShutdownHookInstalled = true;
  const shutdown = (signal: string): void => {
    console.error(`[pi-web] ${signal} received — host shutting down (stop spawner → abort sessions → record interrupted rounds)`);
    stopBackground();
    // running 快照必须在 destroy 之前取（destroy 之后 isRunning 恒 false）。
    const runningIds = getAllRpcSessions().filter((s) => s.isRunning()).map((s) => s.sessionId);
    const { records } = buildShutdownPlan(listActiveRounds(), runningIds);
    for (const session of getAllRpcSessions()) session.destroy();
    // 记录写失败不得吞掉销毁流程 —— 单条失败只记日志，最终仍 exit。
    void Promise.all(records.map((record) =>
      import("../loops/executions.ts").then((mod) => mod.writeExecutionRecord(record)).catch((error) => {
        console.error("[pi-web] write execution record failed:", error);
      }),
    )).finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

/** First-deployment migration guard: a healthy legacy pi-daemon on the
 *  configured/default URL means the old owner is still alive — refuse to
 *  boot instead of silently becoming a second session writer (spec §5.4). */
async function refuseIfLegacyDaemonAlive(): Promise<void> {
  const url = (process.env.PI_DAEMON_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return; // nothing listening — good
  }
  const body = await response.json().catch(() => ({})) as { service?: string };
  if (response.ok && body?.service === "pi-daemon") {
    console.error(
      `[pi-web] 检测到旧 pi-daemon 仍在 ${url} 运行并持有会话。请先停掉它（kill 或 systemd stop），` +
      "再启动单进程 pi-web —— 两个进程同时写会话文件会损坏数据。本次启动中止。",
    );
    process.exit(1);
  }
}

export interface HostBootOptions {
  /** 测试/特殊部署注入自定义 spawner 启停；缺省 = LoopKitSpawner。 */
  createSpawner?: () => { start(): void; stop(): void; timer?: unknown };
}

export function ensureHostBooted(options: HostBootOptions = {}): void {
  if (g.__piHostBooted) return;
  g.__piHostBooted = true;
  // Test escape hatch (PI_TEST_NO_BACKGROUND=1): skip BOTH the migration
  // guard and the DEFAULT spawner — tests must never exit(1) on a live dev
  // daemon nor start real heartbeats. An explicitly injected spawner is
  // exempt: injection exists precisely for tests/special deployments.
  const testMode = process.env.PI_TEST_NO_BACKGROUND === "1";
  if (testMode && !options.createSpawner) return;
  // The spawner starts only AFTER the migration guard clears — a doomed boot
  // (legacy daemon alive → process.exit(1)) must never fire a real loop
  // round while the guard's fetch is still in flight.
  const guard: Promise<void> = testMode ? Promise.resolve() : refuseIfLegacyDaemonAlive();
  // Lazy import keeps this module importable from instrumentation without
  // dragging workspace/work-item services into every route bundle.
  void guard
    .then(() => import("./loop-spawner.ts"))
    .then(({ LoopKitSpawner }) => {
      const spawner: LoopKitSpawner = options.createSpawner
        ? (options.createSpawner() as unknown as LoopKitSpawner)
        : new LoopKitSpawner();
      spawner.start();
      g.__piLoopSpawnerTimer = (spawner as unknown as { timer?: unknown }).timer;
      // 关停钩子与 spawner 同生命周期：停新轮 → abort 全部会话 → 写中断记录。
      registerShutdownHandlers(() => spawner.stop());
    })
    .catch((error) => {
      console.error("[pi-web] loop heartbeat spawner failed to start:", error);
    });
}
