import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DefaultLoopRuntime } from "./runtime.ts";
import { PiRoundExecutionBackend } from "./pi-execution.ts";
import { LoopHostScheduler } from "./scheduler.ts";
import { PiWorkspaceResolver } from "./workspace-resolver.ts";
import { LoopConflictError, LoopNotFoundError, LoopValidationError } from "./store.ts";
import { ImporterScheduler } from "../importers/scheduler.ts";
import { syncImporterForWorkspace } from "../importers/runner.ts";
import { findWorkItemByConversation } from "../work-items/service.ts";
import { getRpcSession, type AgentSessionWrapper } from "../rpc-manager.ts";
import type { TriggerCommand } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 30142;

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** Stream a Loop-owned orchestrator session's agent events to an HTTP
 *  client (Pi Web proxies this to the browser so a Loop session that lives in
 *  this process can be watched live). Mirrors the SSE shape Pi Web emits.
 *  The stream also ends when the session is destroyed (round terminal /
 *  timeout / abort) — otherwise the browser-side pinned runtime would keep
 *  `agentRunning` true forever with no `agent_end` ever arriving. */
function serveSessionSse(request: IncomingMessage, response: ServerResponse, session: AgentSessionWrapper): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const write = (data: unknown) => {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  write({ type: "connected", sessionId: session.sessionId });
  const unsubscribe = session.onEvent((event) => write(event));
  const heartbeat = setInterval(() => {
    try { response.write(": \n\n"); } catch { /* response already closed */ }
  }, 30_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    offDestroy();
    try { response.end(); } catch { /* already ended */ }
  };
  const offDestroy = session.onDestroy(cleanup);
  request.on("close", cleanup);
  request.on("error", cleanup);
}

function errorStatus(error: unknown): number {
  if (error instanceof LoopNotFoundError) return 404;
  if (error instanceof LoopValidationError) return 400;
  if (error instanceof LoopConflictError) return 409;
  return 500;
}

export function createLoopHost() {
  const workspaces = new PiWorkspaceResolver();
  // Name an orchestrator session after the requirement its run picked: the
  // orchestrator links itself to a work item by appending its session id to the
  // item's `conversations` (per the dev-loop LOOP.md), so we resolve the title
  // from that linkage. Returns undefined for runs that picked nothing (idle /
  // park-all) -> those keep their default title.
  const execution = new PiRoundExecutionBackend(async (workspacePath, sessionId) => {
    const item = await findWorkItemByConversation(workspacePath, sessionId);
    return item ? `(Loop) ${item.title}` : undefined;
  });
  /** Any live pi session in THIS host process: Loop orchestrators first
   *  (authoritative, indexed by real session id), then the ordinary rpc
   *  registry — which is where the subagent children an orchestrator spawns
   *  live (worker.ts starts them via startRpcSession). Exposing both lets Pi
   *  Web probe + SSE-proxy a RUNNING subagent child exactly like its
   *  orchestrator; without this the child probe 404s and Pi Web would load the
   *  .jsonl itself — a second writer racing the live child. */
  const findLiveSession = (sid: string): AgentSessionWrapper | undefined => {
    const orchestrator = execution.getBySessionId(sid);
    if (orchestrator) return orchestrator;
    const child = getRpcSession(sid);
    return child?.isAlive() ? child : undefined;
  };
  const liveMeta = (session: AgentSessionWrapper) => ({
    id: session.sessionId,
    cwd: session.cwd,
    sessionFile: session.sessionFile,
    running: session.isRunning(),
  });
  const runtime = new DefaultLoopRuntime(workspaces, execution);
  const scheduler = new LoopHostScheduler(runtime, workspaces);
  const importerScheduler = new ImporterScheduler();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, service: "pi-loop" });
      }
      const loops = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/loops$/);
      if (request.method === "GET" && loops) {
        return json(response, 200, { loops: await runtime.listLoops(decodeURIComponent(loops[1])) });
      }
      if (request.method === "POST" && url.pathname === "/v1/triggers") {
        return json(response, 202, await runtime.trigger(await body(request) as TriggerCommand));
      }
      // Session probe: Pi Web asks "do you own this session?" before falling
      // back to loading the .jsonl itself. Returns metadata + live state.
      // Covers orchestrators AND their running subagent children (both live in
      // this process).
      const sessionProbe = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionProbe) {
        const sid = decodeURIComponent(sessionProbe[1]);
        const session = findLiveSession(sid);
        if (!session) return json(response, 404, { error: "session not live in loop host" });
        let state: unknown;
        try { state = await session.send({ type: "get_state" }); }
        catch { state = undefined; /* session not ready yet */ }
        return json(response, 200, { ...liveMeta(session), state });
      }
      // Session event stream: Pi Web proxies this SSE so the browser can watch
      // a Loop orchestrator — or its running subagent child — live, exactly
      // like a local session.
      const sessionEvents = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      if (request.method === "GET" && sessionEvents) {
        const sid = decodeURIComponent(sessionEvents[1]);
        const session = findLiveSession(sid);
        if (!session) return json(response, 404, { error: "session not live in loop host" });
        serveSessionSse(request, response, session);
        return;
      }
      const run = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)$/);
      if (request.method === "GET" && run) {
        return json(response, 200, {
          run: await runtime.getRun(decodeURIComponent(run[1]), decodeURIComponent(run[2])),
        });
      }
      const gate = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/gate$/);
      if (request.method === "POST" && gate) {
        const input = await body(request) as { message?: string };
        return json(response, 200, {
          run: await runtime.answerGate({
            message: typeof input.message === "string" ? input.message : "",
            workspaceId: decodeURIComponent(gate[1]),
            runId: decodeURIComponent(gate[2]),
          }),
        });
      }
      // Independent abort: destroy the orchestrator session and mark the run
      // failed. Works whether the run is running or paused at a gate.
      const abort = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/abort$/);
      if (request.method === "POST" && abort) {
        return json(response, 200, {
          run: await runtime.abortRun(decodeURIComponent(abort[1]), decodeURIComponent(abort[2])),
        });
      }
      // Importer manual/webhook sync — a non-Loop system task. Runs the same
      // runner the ImporterScheduler cron uses, just on demand.
      const importerSync = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/importers\/sync$/);
      if (request.method === "POST" && importerSync) {
        const summary = await syncImporterForWorkspace(decodeURIComponent(importerSync[1]));
        return json(response, 200, { summary });
      }
      return json(response, 404, { error: "route not found" });
    } catch (error) {
      console.error("[pi-loop] request failed:", error);
      return json(response, errorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { server, scheduler, runtime, importerScheduler };
}

export async function startLoopHost(options: { host?: string; port?: number } = {}): Promise<void> {
  const host = options.host ?? process.env.PI_LOOP_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.PI_LOOP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PI_LOOP_PORT must be a valid port");
  const app = createLoopHost();
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, host, () => resolve());
  });
  app.scheduler.start();
  app.importerScheduler.start();
  // Reap ghost gates: runs paused at a gate whose orchestrator `.jsonl` was
  // archived/removed (e.g. an idle-timed-out session whose file later got
  // archived) can never be resumed. Mark them failed so the UI stops offering a
  // dead gate. Runs whose file is still live are left for transparent rehydrate.
  try {
    const reaped = await app.runtime.reapOrphanedGates();
    if (reaped > 0) console.log(`[pi-loop] reaped ${reaped} orphaned gate run(s)`);
  } catch (error) {
    console.error("[pi-loop] orphan-gate reap failed:", error);
  }
  console.log(`[pi-loop] listening on http://${host}:${port}`);
  const stop = () => {
    app.scheduler.stop();
    app.importerScheduler.stop();
    app.server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
