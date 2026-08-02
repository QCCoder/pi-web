import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { listArchivedSessions } from "@/lib/session-archive";
import { getLiveRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import type { SessionInfo } from "@/lib/types";

export async function GET(req: Request) {
  try {
    const archived = new URL(req.url).searchParams.has("archived");
    if (archived) {
      return NextResponse.json({ sessions: await listArchivedSessions() });
    }
    const sessions = await listAllSessions();

    // Merge in-memory RPC sessions that are not yet on disk. A brand-new
    // session exists in the registry before pi flushes its .jsonl, so without
    // this it would be missing from the (cached) disk scan until the cache
    // expires — making the sidebar list lag behind a freshly created session.
    const presentIds = new Set(sessions.map((session) => session.id));
    const liveSynthesized: SessionInfo[] = [];
    for (const live of getLiveRpcSessionInfos()) {
      if (!live.id || presentIds.has(live.id)) continue;
      presentIds.add(live.id);
      liveSynthesized.push({
        path: live.sessionFile || "",
        id: live.id,
        cwd: live.cwd,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 0,
        firstMessage: "(no messages)",
        projectRoot: live.cwd,
      });
    }
    const merged = liveSynthesized.length > 0 ? [...liveSynthesized, ...sessions] : sessions;

    return NextResponse.json({ sessions: merged, runningSessionIds: getRunningRpcSessionIds() });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
