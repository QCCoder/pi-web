import { openSessionEventStream } from "@/lib/session-host/sse";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events, served directly by
// the in-process session host (live sessions, subagent children and kit loop
// rounds share one registry; idle sessions cold-start from their .jsonl).
// `req.signal` only cancels this subscription — never the session itself.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return openSessionEventStream(id, req.signal);
}
