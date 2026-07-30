import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { listArchivedSessions } from "@/lib/session-archive";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export async function GET(req: Request) {
  try {
    const archived = new URL(req.url).searchParams.has("archived");
    if (archived) {
      return NextResponse.json({ sessions: await listArchivedSessions() });
    }
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds() });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
