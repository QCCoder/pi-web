import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Pure proxy over the session daemon (C2): it owns every live session, so
    // it is the only place to ask. `loopOwned: true` here means "live in the
    // daemon" (kit round, subagent child, or interactive session) — the
    // client pins such a viewed session so its event stream survives the
    // running-set sweep even while it is idle-warm between turns.
    const client = await daemonProxy();
    const meta = await client.probeSession(id);
    if (meta) {
      return NextResponse.json({
        running: meta.running,
        loopOwned: true,
        state: meta.state ?? undefined,
      });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: daemonErrorStatus(error) });
  }
}
