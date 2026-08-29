import { createServer } from "node:http";
import { DefaultLoopRuntime } from "../loop/runtime.ts";
import { PiRoundExecutionBackend } from "../loop/pi-execution.ts";
import { LoopHostScheduler } from "../loop/scheduler.ts";
import { createLoopRoutes } from "../loop/http.ts";
import { PiWorkspaceResolver } from "../loop/workspace-resolver.ts";
import { ImporterScheduler } from "../work-items/importers/scheduler.ts";
import { createImporterRoutes } from "../work-items/importers/http.ts";
import { createSessionsRoutes } from "./http-sessions.ts";
import { daemonErrorStatus, sendJson, type DaemonRouteHandler } from "./http.ts";
import { DaemonJobRegistry } from "./jobs.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 30142;

/** The pi-daemon: THE single session-owning process, plus a host for
 *  registered background jobs (loop trigger cron, importer sync).
 *
 *  The core is deliberately thin and domain-free. It provides exactly three
 *  things:
 *    1. the session surface (lib/daemon/http-sessions.ts — the daemon's own
 *       identity, injected with the loop engine's orchestrator index),
 *    2. a DaemonJob registry (lib/daemon/jobs.ts) — domains register their
 *       long-lived timers; the daemon starts/stops them uniformly and never
 *       imports their logic,
 *    3. a route mounting point — each domain exports a DaemonRouteHandler
 *       from its own directory and gets chained here.
 *
 *  Domains mounted today: loop (engine routes + trigger cron) and importers
 *  (requirement-source sync job + sync route). Adding a fourth module means
 *  registering it here — one line each for routes and jobs. */
export function createDaemon() {
  // ---- Loop engine domain -------------------------------------------------
  const workspaces = new PiWorkspaceResolver();
  // v3: the backend runs one short selection round per run — no sessionNamer
  // seam (selection orchestrators keep their default title; seeded execution
  // sessions get a deterministic name from the seeder).
  const execution = new PiRoundExecutionBackend();
  const runtime = new DefaultLoopRuntime(workspaces, execution);

  // ---- Background jobs ----------------------------------------------------
  const jobs = new DaemonJobRegistry();
  jobs.register(new LoopHostScheduler(runtime, workspaces)); // id: loop-triggers
  jobs.register(new ImporterScheduler()); // id: importer-sync

  // ---- Route chain --------------------------------------------------------
  const sessionsRoutes = createSessionsRoutes({
    findOrchestratorSession: (sid) => execution.getBySessionId(sid),
  });
  const loopRoutes = createLoopRoutes({ runtime, workspaces });
  const importerRoutes = createImporterRoutes();
  const routes: DaemonRouteHandler[] = [sessionsRoutes, loopRoutes, importerRoutes];

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
  return { server, jobs, runtime, execution };
}

export async function startDaemon(options: { host?: string; port?: number } = {}): Promise<void> {
  // PI_DAEMON_HOST/PORT are canonical; PI_LOOP_HOST/PORT are legacy fallbacks
  // kept so existing shells/systemd units keep working.
  const host = options.host ?? process.env.PI_DAEMON_HOST ?? process.env.PI_LOOP_HOST ?? DEFAULT_HOST;
  const port = options.port
    ?? Number(process.env.PI_DAEMON_PORT ?? process.env.PI_LOOP_PORT ?? DEFAULT_PORT);
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
