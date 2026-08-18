import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";

// POST /api/sessions/[id]/auto-name - generate + apply a session title.
// Pure proxy over the session daemon (C2): title generation needs the session's
// AgentSession (message history + LLM call), which lives in the daemon. The
// daemon cold-starts idle sessions from their .jsonl, exactly like the old
// in-process implementation.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const client = await daemonProxy();
    const result = await client.autoNameSession(id);
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: daemonErrorStatus(error) },
    );
  }
}
