import { daemonProxy } from "@/lib/agent-proxy";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pure proxy over the session daemon (C2): its registry is keyed
// by real session id and contains interactive sessions, subagent children AND
// loop orchestrators, so this single stream is the complete running answer —
// the web-side pin/reprobe + client-side loop-badge merge existed only because
// the old local set could never contain daemon-owned sessions.
export async function GET(req: Request) {
  let upstream: Response;
  try {
    const client = await daemonProxy();
    upstream = await client.runningEvents(req.signal);
  } catch {
    return new Response("Session daemon unavailable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("Session daemon unavailable", { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
