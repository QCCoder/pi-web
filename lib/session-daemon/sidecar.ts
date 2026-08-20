import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Session-daemon sidecar lifecycle.
 *
 * The loop host process (bin/pi-loop.js, `npm run loop`) is being promoted to
 * THE single session-owning daemon (C2). The web server attaches to it when it
 * is already running and spawns it detached when it is not — so `npm run dev`
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
 *  can own. A PI_LOOP_URL pointing at a remote host means the daemon is managed
 *  elsewhere — never spawn a local process for it. */
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
  return (process.env.PI_LOOP_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");
}

/** Env for the spawned daemon so it listens exactly where this web process
 *  will look for it. The daemon binds PI_LOOP_HOST/PI_LOOP_PORT (NOT
 *  PI_LOOP_URL — that is the web-side client address), so a PI_LOOP_URL-only
 *  configuration must be translated; otherwise the sidecar would spawn a
 *  daemon on the default port and then poll the URL's port forever. Explicit
 *  PI_LOOP_HOST/PI_LOOP_PORT in the environment always win. */
export function sidecarSpawnEnv(
  daemonUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const url = new URL(daemonUrl);
  const hostname = url.hostname.replace(/^\[(.+)\]$/, "$1");
  return {
    ...baseEnv,
    PI_LOOP_HOST: baseEnv.PI_LOOP_HOST ?? hostname,
    PI_LOOP_PORT: baseEnv.PI_LOOP_PORT ?? url.port,
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

interface SidecarGlobals {
  __piSessionDaemonStart?: Promise<StartState>;
}

const globals = globalThis as typeof globalThis & SidecarGlobals;

async function startOnce(): Promise<StartState> {
  const baseUrl = daemonBaseUrl();
  if (await probeHealth(baseUrl, 1_000)) return "attached";

  if (!spawnableDaemonUrl(baseUrl)) {
    throw new Error(
      `session daemon is not reachable at ${baseUrl} and PI_LOOP_URL points at a ` +
      "non-local host — refusing to spawn a local sidecar for it",
    );
  }

  // The web server always runs from the package root (`npm run dev` /
  // `npm start`), so resolve the daemon entry from cwd. Deliberately no
  // `import.meta.url`: this module is webpack-bundled into an app route, and
  // `new URL(".", import.meta.url)` fails that build ("Can't resolve '.'").
  const entry = join(process.cwd(), "bin", "pi-loop.js");
  if (!existsSync(entry)) {
    throw new Error("bin/pi-loop.js not found — cannot spawn the session daemon sidecar");
  }

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: sidecarSpawnEnv(baseUrl),
  });
  child.unref();

  // Wait for the spawned daemon to become healthy before declaring success.
  // The losing side of a spawn race exits quietly on EADDRINUSE (see bin).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await probeHealth(baseUrl, 1_000)) return "spawned";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`session daemon sidecar spawned (${entry}) but did not become healthy at ${baseUrl} within 15s`);
}

/** Ensure the session daemon is running: attach if healthy, otherwise spawn a
 *  detached sidecar and wait for its /health. Concurrent callers share one
 *  in-flight promise; a failed start clears the guard so the next caller
 *  retries. Set PI_SESSION_DAEMON_DISABLED=1 to opt out entirely. */
export async function ensureSessionDaemonStarted(): Promise<StartState> {
  if (process.env.PI_SESSION_DAEMON_DISABLED === "1") return "attached";
  if (!globals.__piSessionDaemonStart) {
    globals.__piSessionDaemonStart = startOnce().catch((error: unknown) => {
      globals.__piSessionDaemonStart = undefined;
      throw error;
    });
  }
  return globals.__piSessionDaemonStart;
}
