import { NextResponse } from "next/server";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";

// POST /api/agent/[id] - Send a command to an existing session.
// Pure proxy over the session daemon (C2): the daemon is the single session
// owner, so ANY command (prompt, fork, navigate_tree, extension UI responses,
// …) is forwarded verbatim. The daemon cold-starts idle sessions from their
// .jsonl exactly like this route used to, and answers 409 for loop
// orchestrators (gate-driven only) — both semantics preserved end-to-end.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    if (typeof body.type !== "string") {
      return NextResponse.json({ error: "command type is required" }, { status: 400 });
    }
    const client = await daemonProxy();
    const result = await client.sendSessionCommand(id, body);
    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: daemonErrorStatus(error) });
  }
}

// GET /api/agent/[id] - Get current agent state.
// Pure proxy: the daemon owns every session, so "is it running + its state"
// has exactly one answer — the daemon's. An idle session (no live wrapper in
// the daemon) reports { running: false }, same as before.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const client = await daemonProxy();
    const meta = await client.probeSession(id);
    if (!meta) {
      return NextResponse.json({ running: false });
    }
    return NextResponse.json({ running: meta.running, state: meta.state ?? undefined });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: daemonErrorStatus(error) });
  }
}
