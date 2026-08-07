import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DefaultLoopRuntime } from "./runtime.ts";
import { PiRoundExecutionBackend } from "./pi-execution.ts";
import { LoopHostScheduler } from "./scheduler.ts";
import { PiWorkspaceResolver } from "./workspace-resolver.ts";
import { LoopConflictError, LoopNotFoundError, LoopValidationError } from "./store.ts";
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

function errorStatus(error: unknown): number {
  if (error instanceof LoopNotFoundError) return 404;
  if (error instanceof LoopValidationError) return 400;
  if (error instanceof LoopConflictError) return 409;
  return 500;
}

export function createLoopHost() {
  const workspaces = new PiWorkspaceResolver();
  const runtime = new DefaultLoopRuntime(workspaces, new PiRoundExecutionBackend());
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
