import { daemonProxy } from "@/lib/agent-proxy";

export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

// GET /api/agent/[id]/events - SSE stream of agent events.
// Pure proxy over the session daemon (C2). The daemon serves live sessions
// (interactive, subagent children, loop orchestrators — all in its registry)
// and cold-starts idle ones from their .jsonl for viewing, mirroring the
// semantics this route used to implement locally. `req.signal` propagates the
// client disconnect upstream so both sides tear down together.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let upstream: Response;
  try {
    const client = await daemonProxy();
    upstream = await client.sessionEvents(id, req.signal);
  } catch {
    return new Response("Session daemon event stream unavailable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    // 404 from the daemon = session file does not exist at all.
    return new Response(upstream.status === 404 ? "Session not found" : "Session daemon event stream unavailable", {
      status: upstream.status === 404 ? 404 : 502,
    });
  }
  return new Response(upstream.body, { headers: SSE_HEADERS });
}
