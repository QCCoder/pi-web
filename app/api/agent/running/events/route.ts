import { serveRunningEventStream } from "@/lib/session-host/sse";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE of the currently-running session id set
// (interactive + subagent children + kit rounds — the registry is the complete
// answer, in-process).
export async function GET(req: Request) {
  return serveRunningEventStream(req.signal);
}
