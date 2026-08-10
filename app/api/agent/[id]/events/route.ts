import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loopHostClient } from "@/lib/loop/client";

export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/** A Loop orchestrator session physically lives in the Loop Host process. Re-
 *  loading its .jsonl here would create a second AgentSession writing the same
 *  file and would never see the host's live events. Instead, pipe the host's
 *  SSE straight to the browser. `req.signal` propagates client disconnects back
 *  to the upstream fetch so both sides tear down together. */
async function proxyLoopHostEvents(req: Request, sessionId: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await loopHostClient.sessionEvents(sessionId, req.signal);
  } catch {
    return new Response("Loop Host event stream unavailable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("Loop Host event stream unavailable", { status: 502 });
  }
  return new Response(upstream.body, { headers: SSE_HEADERS });
}

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Fast path: already-running session
  let session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    // A Loop orchestrator session lives in the Loop Host process. Probe it
    // before touching the .jsonl: if the host owns it, proxy its event stream
    // (re-loading here would race the host and never see its live events).
    if (await loopHostClient.probeSession(id)) {
      return await proxyLoopHostEvents(req, id);
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
    try {
      ({ session } = await startRpcSession(id, filePath, cwd));
    } catch (error) {
      return new Response(`Failed to start agent: ${error}`, { status: 500 });
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: id });

      const unsubscribe = session.onEvent((event) => {
        encode(event);
      });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}
