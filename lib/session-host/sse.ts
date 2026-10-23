/** In-process SSE serving for Next.js route handlers.
 *
 *  The daemon used a node-http ServerResponse writer with a writableLength
 *  stall cap (the 2026-08-30 OOM lesson). Web ReadableStreams have no
 *  readable backpressure signal, so the cap here is our own byte counter:
 *  once a viewer leaves >SSE_STALL_BYTES enqueued and undrained, close the
 *  stream — the browser reconnects on its next poll (same recovery as any
 *  dropped SSE connection). Semantics preserved: connected frame first, 30s
 *  heartbeat comments, stream ends when the session is destroyed, aborting
 *  the request signal only cancels the subscription (never the session). */
import type { AgentSessionWrapper } from "./registry.ts";
import { getRunningRpcSessionIds, getRpcSession, startRpcSession, subscribeRunningSessions } from "./registry.ts";
import { resolveSessionPath } from "../session-reader.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const SSE_STALL_BYTES_DEFAULT = 1_000_000;
const HEARTBEAT_MS = 30_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export interface WebSseWriter {
  writeEvent(data: unknown): void;
  writeRaw(text: string): void;
  readonly stalled: boolean;
}

export interface WebSseController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
}

export function createWebSseWriter(
  controller: WebSseController,
  stallBytes: number,
  onStall: () => void,
): WebSseWriter {
  let queued = 0;
  let stalled = false;
  const encoder = new TextEncoder();
  const checkStall = (): void => {
    if (!stalled && queued >= stallBytes) {
      stalled = true;
      onStall();
    }
  };
  return {
    writeEvent(data: unknown): void {
      if (stalled) return;
      const chunk = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
      queued += chunk.byteLength;
      controller.enqueue(chunk);
      checkStall();
    },
    writeRaw(text: string): void {
      if (stalled) return;
      const chunk = encoder.encode(text);
      queued += chunk.byteLength;
      controller.enqueue(chunk);
      checkStall();
    },
    get stalled(): boolean { return stalled; },
  };
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { headers: SSE_HEADERS });
}

export function serveSessionEventStream(session: AgentSessionWrapper, signal: AbortSignal): Response {
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let unsubscribe: () => void = () => {};
      let offDestroy: () => void = () => {};
      // `heartbeat` is a const assigned below, after the writer exists — the
      // same TDZ-safe ordering as the daemon's http-sessions.ts (cleanup only
      // ever runs after start() has fully wired the stream).
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        offDestroy();
        try { controller.close(); } catch { /* already closed */ }
      };
      const writer = createWebSseWriter(controller, SSE_STALL_BYTES_DEFAULT, cleanup);
      writer.writeEvent({ type: "connected", sessionId: session.sessionId });
      unsubscribe = session.onEvent((event) => writer.writeEvent(event));
      const heartbeat = setInterval(() => writer.writeRaw(": \n\n"), HEARTBEAT_MS);
      offDestroy = session.onDestroy(cleanup);
      signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });
  return sseResponse(stream);
}

export function serveRunningEventStream(signal: AbortSignal): Response {
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let unsubscribe: () => void = () => {};
      // `heartbeat` is a const assigned below, after the writer exists — same
      // TDZ-safe ordering as serveSessionEventStream above.
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      const writer = createWebSseWriter(controller, SSE_STALL_BYTES_DEFAULT, cleanup);
      unsubscribe = subscribeRunningSessions((ids) => writer.writeEvent({ type: "running", runningSessionIds: ids }));
      writer.writeEvent({ type: "running", runningSessionIds: getRunningRpcSessionIds() });
      const heartbeat = setInterval(() => writer.writeRaw(": \n\n"), HEARTBEAT_MS);
      signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });
  return sseResponse(stream);
}

/** live-first + cold-start（旧 daemon events 分支语义）：idle 会话被观看时
 *  也起一个 wrapper（浏览器拿到 connected 帧 + 后续事件；idle timer 回收）。 */
export async function openSessionEventStream(sessionId: string, signal: AbortSignal): Promise<Response> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) return serveSessionEventStream(live, signal);
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return new Response("Session not found", { status: 404 });
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  const { session } = await startRpcSession(sessionId, filePath, cwd);
  return serveSessionEventStream(session, signal);
}
