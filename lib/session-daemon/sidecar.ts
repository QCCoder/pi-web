import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Session-daemon sidecar lifecycle.
 *
 * The pi-daemon process (bin/pi-daemon.js, `npm run daemon`) is THE single
 * session-owning daemon (C2). The web server attaches to it when it is
 * already running and spawns it detached when it is not — so `npm run dev`
 * alone remains a complete, working setup. Re-attach (probe-first, never a
 * second spawn against a live port) keeps daemon timers decoupled from web
 * restarts: the "web owns no unattended timers" rule is preserved because the
 * daemon process survives web hot-reloads intact.
 */

export type SidecarAction = { kind: "attach" } | { kind: "spawn" };

/** Pure decision: given a health-probe outcome, what should this web process do? */
export function decideSidecarAction(daemonHealthy: boolean): SidecarAction {
  return daemonHealthy ? { kind: "attach" } : { kind: "spawn" };
}

/** Pure guard: a sidecar may only be spawned for a daemon address this machine
 *  can own. A PI_DAEMON_URL pointing at a remote host means the daemon is
 *  managed elsewhere — never spawn a local process for it. */
export function spawnableDaemonUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
}

function daemonBaseUrl(): string {
  // PI_DAEMON_URL is canonical; PI_LOOP_URL is the legacy fallback.
  return (process.env.PI_DAEMON_URL ?? process.env.PI_LOOP_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");
}

/** Env for the spawned daemon so it listens exactly where this web process
 *  will look for it. The daemon binds PI_DAEMON_HOST/PI_DAEMON_PORT (NOT
 *  PI_DAEMON_URL — that is the web-side client address), so a URL-only
 *  configuration must be translated; otherwise the sidecar would spawn a
 *  daemon on the default port and then poll the URL's port forever. Explicit
 *  PI_DAEMON_HOST/PI_DAEMON_PORT (or their PI_LOOP_* legacy spellings) always
 *  win. */
export function sidecarSpawnEnv(
  daemonUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const url = new URL(daemonUrl);
  const hostname = url.hostname.replace(/^\[(.+)\]$/, "$1");
  return {
    ...baseEnv,
    PI_DAEMON_HOST: baseEnv.PI_DAEMON_HOST ?? baseEnv.PI_LOOP_HOST ?? hostname,
    PI_DAEMON_PORT: baseEnv.PI_DAEMON_PORT ?? baseEnv.PI_LOOP_PORT ?? url.port,
  };
}


async function probeHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

type StartState = "attached" | "spawned";

/** How long a spawned daemon gets to answer /health before the spawn is
 *  declared failed. 15s covers a cold jiti-compile start of bin/pi-daemon.js. */
const SPAWN_HEALTH_TIMEOUT_MS = 15_000;
/** After a failed spawn, block retries for this long so a daemon that cannot
 *  start (broken checkout, port hijack) fails requests fast instead of
 *  stalling every caller for the full spawn-health window. */
const SPAWN_RETRY_COOLDOWN_MS = 10_000;
/** /health probe timeout on the attach path — the daemon answers in
 *  single-digit ms when healthy (see lib/daemon/client.ts). */
const PROBE_TIMEOUT_MS = 1_000;
/** Poll interval while waiting for a spawned daemon to come up. */
const SPAWN_POLL_INTERVAL_MS = 250;

interface SidecarGlobals {
  /** In-flight spawn attempt — dedupes CONCURRENT callers only; it is cleared
   *  on settle so success is never cached (a daemon that dies later must be
   *  re-detected by the next call's probe, not papered over by a stale
   *  "started" promise). */
  __piSessionDaemonSpawn?: Promise<StartState>;
  /** Last spawn failure + when, for the retry cooldown. */
  __piSidecarLastFailure?: { at: number; error: unknown };
}

const globals = globalThis as typeof globalThis & SidecarGlobals;

/** Injectable seams for the lifecycle tests (lib/session-daemon/sidecar.test.mjs):
 *  probe/spawn/clock/sleep are the real world, defaults are production. */
export interface EnsureSidecarDeps {
  probe?: (baseUrl: string, timeoutMs: number) => Promise<boolean>;
  spawnDaemon?: (entry: string, baseUrl: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnHealthTimeoutMs?: number;
  spawnRetryCooldownMs?: number;
}

function defaultSpawnDaemon(entry: string, baseUrl: string): void {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: sidecarSpawnEnv(baseUrl),
  });
  child.unref();
}

async function attemptSpawn(baseUrl: string, deps: EnsureSidecarDeps): Promise<StartState> {
  const {
    probe = probeHealth,
    spawnDaemon = defaultSpawnDaemon,
    now = Date.now,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawnHealthTimeoutMs = SPAWN_HEALTH_TIMEOUT_MS,
    spawnRetryCooldownMs = SPAWN_RETRY_COOLDOWN_MS,
  } = deps;

  // Fail fast inside the cooldown after a recent spawn failure.
  const lastFailure = globals.__piSidecarLastFailure;
  if (lastFailure && now() - lastFailure.at < spawnRetryCooldownMs) throw lastFailure.error;

  if (!spawnableDaemonUrl(baseUrl)) {
    throw new Error(
      `session daemon is not reachable at ${baseUrl} and PI_DAEMON_URL points at a ` +
      "non-local host — refusing to spawn a local sidecar for it",
    );
  }

  // The web server always runs from the package root (`npm run dev` /
  // `npm start`), so resolve the daemon entry from cwd. Deliberately no
  // `import.meta.url`: this module is webpack-bundled into an app route, and
  // `new URL(".", import.meta.url)` fails that build ("Can't resolve '.'").
  const entry = join(process.cwd(), "bin", "pi-daemon.js");
  if (!existsSync(entry)) {
    throw new Error("bin/pi-daemon.js not found — cannot spawn the session daemon sidecar");
  }

  spawnDaemon(entry, baseUrl);

  // Wait for the spawned daemon to become healthy before declaring success.
  // The losing side of a spawn race exits quietly on EADDRINUSE (see bin).
  const deadline = now() + spawnHealthTimeoutMs;
  while (now() < deadline) {
    if (await probe(baseUrl, PROBE_TIMEOUT_MS)) return "spawned";
    await sleep(SPAWN_POLL_INTERVAL_MS);
  }
  throw new Error(
    `session daemon sidecar spawned (${entry}) but did not become healthy at ${baseUrl}` +
    ` within ${spawnHealthTimeoutMs}ms`,
  );
}

/** Ensure the session daemon is running. EVERY call probes /health first and
 *  attaches when healthy (single-digit ms on localhost); only an unhealthy
 *  probe leads to a spawn — so a daemon that crashes is revived by the next
 *  request through here instead of leaving the web UI 500ing until a manual
 *  restart. Concurrent callers share one in-flight spawn attempt; a failed
 *  spawn is remembered for a short cooldown so requests fail fast while the
 *  daemon cannot start, then retried. Success is never cached. Set
 *  PI_SESSION_DAEMON_DISABLED=1 to opt out entirely. */
export async function ensureSessionDaemonStarted(deps: EnsureSidecarDeps = {}): Promise<StartState> {
  if (process.env.PI_SESSION_DAEMON_DISABLED === "1") return "attached";
  const { probe = probeHealth } = deps;
  const baseUrl = daemonBaseUrl();
  if (await probe(baseUrl, PROBE_TIMEOUT_MS)) return "attached";
  if (globals.__piSessionDaemonSpawn) return globals.__piSessionDaemonSpawn;

  const attempt = attemptSpawn(baseUrl, deps)
    .catch((error: unknown) => {
      globals.__piSidecarLastFailure = { at: (deps.now ?? Date.now)(), error };
      throw error;
    })
    .finally(() => {
      if (globals.__piSessionDaemonSpawn === attempt) globals.__piSessionDaemonSpawn = undefined;
    });
  globals.__piSessionDaemonSpawn = attempt;
  return attempt;
}

/** Reset module-global sidecar state between lifecycle tests. */
export function resetSidecarStateForTest(): void {
  globals.__piSessionDaemonSpawn = undefined;
  globals.__piSidecarLastFailure = undefined;
}
