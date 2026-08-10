import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DefaultLoopRuntime } from "./runtime.ts";
import { PiRoundExecutionBackend } from "./pi-execution.ts";
import { LoopHostScheduler } from "./scheduler.ts";
import { PiWorkspaceResolver } from "./workspace-resolver.ts";
import { LoopConflictError, LoopNotFoundError, LoopValidationError } from "./store.ts";
import type { AgentSessionWrapper } from "../rpc-manager.ts";
import type { GateCommand, TriggerCommand } from "./types.ts";

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
 *  this process can be watched live). Mirrors the SSE shape Pi Web emits. */
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
    try { response.end(); } catch { /* already ended */ }
  };
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
  const execution = new PiRoundExecutionBackend();
  const runtime = new DefaultLoopRuntime(workspaces, execution);
  const scheduler = new LoopHostScheduler(runtime, workspaces);
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
      const sessionProbe = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionProbe) {
        const sid = decodeURIComponent(sessionProbe[1]);
        const meta = execution.getLiveSessionMeta(sid);
        if (!meta) return json(response, 404, { error: "session not live in loop host" });
        const session = execution.getBySessionId(sid);
        let state: unknown;
        try { state = session ? await session.send({ type: "get_state" }) : undefined; }
        catch { state = undefined; /* session not ready yet */ }
        return json(response, 200, { ...meta, state });
      }
      // Session event stream: Pi Web proxies this SSE so the browser can watch
      // a Loop orchestrator session run live, exactly like a local session.
      const sessionEvents = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      if (request.method === "GET" && sessionEvents) {
        const sid = decodeURIComponent(sessionEvents[1]);
        const session = execution.getBySessionId(sid);
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
        const input = await body(request) as Omit<GateCommand, "workspaceId" | "runId">;
        return json(response, 200, {
          run: await runtime.answerGate({
            ...input,
            workspaceId: decodeURIComponent(gate[1]),
            runId: decodeURIComponent(gate[2]),
          }),
        });
      }
      return json(response, 404, { error: "route not found" });
    } catch (error) {
      console.error("[pi-loop] request failed:", error);
      return json(response, errorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { server, scheduler, runtime };
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
  console.log(`[pi-loop] listening on http://${host}:${port}`);
  const stop = () => {
    app.scheduler.stop();
    app.server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
