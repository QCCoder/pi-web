/** In-process host boot & background assembly.
 *
 *  The Next.js Node.js server is now THE single session owner: at boot it
 *  (1) refuses to start when a legacy pi-daemon still owns sessions
 *  (first-deployment migration guard, spec §5.4),
 *  (2) starts the loop kit heartbeat spawner exactly once (globalThis-guarded
 *      — route cold-loading and dev hot reload must never create a second
 *      timer), and
 *  (3) installs shutdown handlers (Task 7 grows these into the full
 *      stop-new-work → abort → record → exit sequence).
 *  Background entry points are assembled HERE, never from an interactive
 *  session happening to be open (spec §4). */
import type { LoopKitSpawner } from "./loop-spawner.ts";

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
    })
    .catch((error) => {
      console.error("[pi-web] loop heartbeat spawner failed to start:", error);
    });
}
