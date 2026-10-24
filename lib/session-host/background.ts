/** In-process host boot & background assembly.
 *
 *  The Next.js Node.js server is now THE single session owner: at boot it
 *  (1) refuses to start when a legacy pi-daemon still owns sessions
 *  (first-deployment migration guard, spec §5.4),
 *  (2) starts the loop kit heartbeat spawner exactly once (globalThis-guarded
 *      — route cold-loading and dev hot reload must never create a second
 *      timer), and
 *  (3) installs shutdown handlers (stop-new-work → abort → record → exit,
 *      spec §5.4) SYNCHRONOUSLY at the top of the boot — before the async
 *      chain, so the ordered shutdown is always the process's first signal
 *      listener (see ensureHostBooted).
 *  Background entry points are assembled HERE, never from an interactive
 *  session happening to be open (spec §4). */
import { hostname } from "node:os";
import type { LoopKitSpawner } from "./loop-spawner.ts";
import { getAllRpcSessions } from "./registry.ts";
import type { ExecutionRecord } from "../loops/executions.ts";

export interface ActiveRoundInfo {
  /** loop 名（kind="loop-round" 时有意义；M1 调用方照旧必填）。 */
  loopName?: string;
  workspacePath: string;
  /** loop 目录（kind="loop-round" 时有意义）。 */
  dir?: string;
  startedAt: number;
  /** 登记种类：缺省 = loop-round（M1 loop 调用方不写 kind，语义零变化）；
   *  "delivery" = Phase-2 角色执行（designer 会话，配 itemKey）。 */
  kind?: "loop-round" | "delivery";
  /** kind="delivery" 时的工作项 key（claim.recordInterruption 用）。 */
  itemKey?: string;
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

// ------------------------------------------------- delivery 执行登记（T6 泛化）
//
// Phase-2 designer 角色执行复用同一张登记表：关停序列一次消费两类登记——loop 轮
// 照旧写 loop 中断记录（M1 语义零变化），delivery 执行改写 claim 中断（claim.
// recordInterruption，恢复门禁的 5.1 中断记录）。复用而不另开一张表：关停的
// running 快照 → destroy 全量 → 记录链对两类登记是同一段代码路径。

/** 登记 delivery 角色执行（designer 会话在场期间挂，结束钩子/关停收尾清）。 */
export function markDeliveryExecutionActive(
  sessionId: string,
  info: { workspacePath: string; itemKey: string; startedAt?: number },
): void {
  markRoundActive(sessionId, {
    workspacePath: info.workspacePath,
    startedAt: info.startedAt ?? Date.now(),
    kind: "delivery",
    itemKey: info.itemKey,
  });
}

/** delivery 执行登记的清除（语义 = clearRoundMark，命名对称保留给 role-session）。 */
export function clearDeliveryExecutionMark(sessionId: string): void {
  clearRoundMark(sessionId);
}

// ----------------------------------------------------------------------------
// Graceful shutdown (spec §5.4): stop-new-work → abort → record → exit
// ----------------------------------------------------------------------------

export interface DeliveryInterruptionPlan {
  workspacePath: string;
  itemKey: string;
  sessionId: string;
}

export interface ShutdownPlan {
  /** 中断记录：仅为关停时仍在 running set 里的轮写（idle 的登记只是陈旧标记）。 */
  records: ExecutionRecord[];
  /** 计划销毁的轮会话 id（全部登记轮，含 idle）。 */
  destroySessionIds: string[];
  /** delivery 角色执行（kind="delivery"）关停时仍在跑 → 写 claim 中断（恢复
   *  门禁据此挡住新领取，直到人「重新检查并恢复」）。与 records 同口径：仅
   *  running 的登记才写。 */
  deliveryInterruptions: DeliveryInterruptionPlan[];
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
    .filter((round) => round.kind !== "delivery" && runningBySession.has(round.sessionId))
    .map((round) => ({
      schemaVersion: 1 as const,
      runId: round.sessionId,
      kind: "loop-round" as const,
      // loop 登记永远带 loopName（M1 调用方契约）；delivery 不进这条分支。
      loopName: round.loopName ?? "",
      sessionId: round.sessionId,
      workspacePath: round.workspacePath,
      host: { pid: process.pid, hostname: hostname() },
      startedAt: new Date(round.startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      stopResult: "interrupted-on-shutdown" as const,
      needsAttention: true,
    }));
  const deliveryInterruptions: DeliveryInterruptionPlan[] = [];
  for (const round of active) {
    if (round.kind !== "delivery" || round.itemKey === undefined) continue;
    if (!runningBySession.has(round.sessionId)) continue;
    deliveryInterruptions.push({
      workspacePath: round.workspacePath,
      itemKey: round.itemKey,
      sessionId: round.sessionId,
    });
  }
  return { records, destroySessionIds: active.map((round) => round.sessionId), deliveryInterruptions };
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
    const { records, deliveryInterruptions } = buildShutdownPlan(listActiveRounds(), runningIds);
    for (const session of getAllRpcSessions()) session.destroy();
    // 记录写失败不得吞掉销毁流程 —— 单条失败只记日志，最终仍 exit。delivery 执行
    // 的角色会话在 destroy 扫过时自身的结束钩子（role-session.ts）也会竞写 claim
    // 中断——recordInterruption 以 claim.sessionId 匹配幂等，先到者清 claim，后到
    // 者 no-op，两条路径不冲突。
    void Promise.all([
      ...records.map((record) =>
        import("../loops/executions.ts").then((mod) => mod.writeExecutionRecord(record)).catch((error) => {
          console.error("[pi-web] write execution record failed:", error);
        }),
      ),
      ...deliveryInterruptions.map((plan) =>
        import("../work-items/delivery-runner/claim.ts")
          .then((mod) => mod.recordInterruption(plan.workspacePath, plan.itemKey, plan.sessionId, "host shutdown"))
          .catch((error) => {
            console.error("[pi-web] delivery interruption record failed:", error);
          }),
      ),
    ]).finally(() => process.exit(0));
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

/** 模块级 spawner 停止引用 —— 关停钩子在 spawner 启动**之前**就注册（见
 *  ensureHostBooted），所以信号到来时 spawner 可能尚未启动 / 启动失败：
 * null 即安全 no-op。 */
let stopLoopSpawner: (() => void) | null = null;

/** 关停序列里的「停新轮」步骤，绝不能抛出信号处理器（那会吞掉后续的
 * running 快照 → destroy → 写中断记录）：spawner 未启动 = no-op，
 * stop() 抛错 = 记日志后照常走完关停。 */
function stopBackgroundSafely(): void {
  if (!stopLoopSpawner) return;
  try {
    stopLoopSpawner();
  } catch (error) {
    console.error("[pi-web] stopping loop spawner on shutdown failed:", error);
  }
}

export function ensureHostBooted(options: HostBootOptions = {}): void {
  if (g.__piHostBooted) return;
  g.__piHostBooted = true;
  // 关停钩子必须**同步**注册在这里 —— 在下方异步引导链之前。信号监听器按
  // 注册顺序触发：本进程的 SIGINT/SIGTERM 处理器必须以这条有序关停
  // （停新轮 → running 快照 → destroy → 写中断记录 → exit）为第一顺位，
  // 否则任何更早注册的清理（如旧版 registry 的信号 cleanup，首个页面渲染
  // 即注册、早于本函数的异步链完成）会先 destroy 全部 wrapper，把 running
  // 快照清零、静默丢掉全部中断记录。registry 自身不再挂信号处理器（见
  // registry.ts getRegistry 注释），只留 `exit` 尾保。install-once 守卫
  // 保证不重复挂。stopBackgroundSafely 容忍 spawner 未启动/启动失败。
  registerShutdownHandlers(stopBackgroundSafely);
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
      stopLoopSpawner = () => spawner.stop();
      g.__piLoopSpawnerTimer = (spawner as unknown as { timer?: unknown }).timer;
    })
    .catch((error) => {
      console.error("[pi-web] loop heartbeat spawner failed to start:", error);
    });
}
