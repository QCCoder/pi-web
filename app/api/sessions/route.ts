import { NextResponse } from "next/server";
import { invalidateSessionListCache, listAllSessions } from "@/lib/session-reader";
import { listArchivedSessions } from "@/lib/session-archive";
import {
  isSubagentChildSession,
  loadLegacySubagentChildIds,
} from "@/lib/subagent-child";
import { daemonProxy } from "@/lib/agent-proxy";
import type { SessionInfo } from "@/lib/types";

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
    const sessions = await listAllSessions();

    // Merge live daemon sessions that are not yet on disk. A brand-new session
    // exists in the daemon's registry before pi flushes its .jsonl, so without
    // this it would be missing from the (cached) disk scan until the cache
    // expires — making the sidebar list lag behind a freshly created session.
    // (Registry access is daemon-side now — C2.)
    const client = await daemonProxy();
    const [liveMetas, runningIds] = await Promise.all([
      client.liveSessions(),
      client.runningSessionIds(),
    ]);
    const presentIds = new Set(sessions.map((session) => session.id));
    const liveSynthesized: SessionInfo[] = [];
    for (const live of liveMetas.sessions) {
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

    // Tag subagent worker sessions so the sidebar hides them. They stay in the
    // response so the parent's "open child" action can still resolve by id.
    // Community @henryqw/pi-subagent children persist with parent-generated
    // `pi-subagent-<uuid>` ids and `pi-subagent <role>` names — the prefix IS
    // the registry for new children; ids recorded by the retired built-in in
    // subagent-children.txt (read-only, mtime-cached) still tag as children.
    const legacyChildIds = loadLegacySubagentChildIds();
    const sessionsWithFlags = merged.map((session) =>
      isSubagentChildSession(session, legacyChildIds)
        ? { ...session, subagentChild: true }
        : session
    );

    return NextResponse.json({ sessions: sessionsWithFlags, runningSessionIds: runningIds.ids });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
