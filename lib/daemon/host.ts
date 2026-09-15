import { createServer } from "node:http";
import { LoopKitSpawner } from "./loop-spawner.ts";
import { createSessionsRoutes } from "./http-sessions.ts";
import { daemonErrorStatus, sendJson, type DaemonRouteHandler } from "./http.ts";
import { DaemonJobRegistry } from "./jobs.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 30142;

/** The pi-daemon: THE single session-owning process, plus a host for
 *  registered background jobs (loop kit heartbeats).
 *
 *  The core is deliberately thin and domain-free. It provides exactly three
 *  things:
 *    1. the session surface (lib/daemon/http-sessions.ts — the daemon's own
 *       identity),
 *    2. a DaemonJob registry (lib/daemon/jobs.ts) — domains register their
 *       long-lived timers; the daemon starts/stops them uniformly and never
 *       imports their logic,
 *    3. a route mounting point — each domain exports a DaemonRouteHandler
 *       from its own directory and gets chained here.
 *
 *  Domains mounted today: the loop kit spawner (cron heartbeats — the sole
 *  successor of the removed v3 loop engine). Adding a third module means
 *  registering it here — one line each for routes and jobs. */
export function createDaemon() {
  // ---- Background jobs ----------------------------------------------------
  const jobs = new DaemonJobRegistry();
  // pi-loop kit spawner（design: docs/pi-loop-kit-design.md）— 转正为唯一的
  // loop 心跳（v3 loop-triggers cron 已随 v3 引擎拆除，生产翻转后无旗子门控）。
  jobs.register(new LoopKitSpawner()); // id: loop-kit-heartbeats

  // ---- Route chain --------------------------------------------------------
  const routes: DaemonRouteHandler[] = [createSessionsRoutes()];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: "pi-daemon" });
      }
      for (const route of routes) {
        if (await route(request, response, url)) return;
      }
      return sendJson(response, 404, { error: "route not found" });
    } catch (error) {
      console.error("[pi-daemon] request failed:", error);
      return sendJson(response, daemonErrorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { server, jobs };
}

export async function startDaemon(options: { host?: string; port?: number } = {}): Promise<void> {
  const host = options.host ?? process.env.PI_DAEMON_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.PI_DAEMON_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PI_DAEMON_PORT must be a valid port");
  }
  const app = createDaemon();
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, host, () => resolve());
  });
  app.jobs.startAll();
  console.log(`[pi-daemon] listening on http://${host}:${port}`);
  const stop = () => {
    app.jobs.stopAll();
    app.server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
