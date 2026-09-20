import { NextResponse } from "next/server";
import { getSessionListVersion, invalidateSessionListCache } from "@/lib/session-reader";
import { listArchivedSessions } from "@/lib/session-archive";
import { buildSessionsPayload } from "@/lib/session-payload";
import { daemonProxy } from "@/lib/agent-proxy";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const archived = url.searchParams.has("archived");
    if (archived) {
      return NextResponse.json({ sessions: await listArchivedSessions() });
    }
    // A freshly created session writes its .jsonl from the daemon process;
    // the disk scan below is cached 30s, so without an explicit invalidate
    // the new session would be invisible until the cache expires.
    if (url.searchParams.has("refresh")) {
      invalidateSessionListCache();
    }
    // Payload assembly (disk list + best-effort daemon live merge + subagent
    // child tagging) lives in lib/session-payload.ts — shared with the SSR
    // prefetch in app/page.tsx. This route keeps daemonProxy(): it MAY wait
    // for a sidecar spawn (the sidebar list tolerates it); SSR does not.
    // Capture before awaiting: mutations during the scan still require a later
    // refresh (搜索的跨窗口同步以此版本比对，见 /api/sessions/version).
    const sessionListVersion = getSessionListVersion();
    const payload = await buildSessionsPayload(() => daemonProxy());
    return NextResponse.json({ ...payload, sessionListVersion });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
