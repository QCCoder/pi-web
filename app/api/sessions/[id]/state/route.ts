import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { probeSession, SessionHostError } from "@/lib/session-host/facade";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Direct probe through the in-process host facade: it owns every live
    // session, so it is the only place to ask. `liveInDaemon: true` here means
    // "live in the host process" (kit round, subagent child, or interactive
    // session) — the client pins such a viewed session so its event stream
    // survives the running-set sweep even while it is idle-warm between turns
    // (field name kept for client compatibility).
    const meta = await probeSession(id);
    if (meta) {
      return NextResponse.json({
        running: meta.running,
        liveInDaemon: true,
        state: meta.state ?? undefined,
      });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof SessionHostError ? error.status : 500 });
  }
}
