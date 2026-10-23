import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { autoNameSession, SessionHostError } from "@/lib/session-host/facade";

// POST /api/sessions/[id]/auto-name - generate + apply a session title.
// Direct call into the in-process host facade: title generation needs the
// session's AgentSession (message history + LLM call), which lives in the host
// registry. The facade cold-starts idle sessions from their .jsonl, exactly
// like the old implementation.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const result = await autoNameSession(id);
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof SessionHostError ? error.status : 500 },
    );
  }
}
