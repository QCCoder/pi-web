import { NextResponse } from "next/server";
import { invalidateSessionListCache, listAllSessions } from "@/lib/session-reader";
import { listArchivedSessions } from "@/lib/session-archive";
import { loadSubagentChildIds } from "@/lib/subagent/registry";
import { daemonProxy } from "@/lib/agent-proxy";
import { invalidateLoopSessionTags, loopSessionTags } from "@/lib/loop/session-tags";
import type { SessionInfo } from "@/lib/types";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const archived = url.searchParams.has("archived");
    if (archived) {
      return NextResponse.json({ sessions: await listArchivedSessions() });
    }
    // A freshly triggered Loop round writes its .jsonl from the daemon
    // process; the disk scan below is cached 30s, so without an explicit
    // invalidate the new session would be invisible until the cache expires.
    if (url.searchParams.has("refresh")) {
      invalidateSessionListCache();
      invalidateLoopSessionTags();
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
    const subagentChildIds = loadSubagentChildIds();
    let sessionsWithFlags = subagentChildIds.size > 0
      ? merged.map((session) => (subagentChildIds.has(session.id) ? { ...session, subagentChild: true } : session))
      : merged;

    // Tag Loop selection orchestrators: hidden from session lists — their only
    // entry point is the Loop view's run record (which opens the seeded
    // execution session first). v3 execution sessions are NOT tagged; they
    // surface via their work item's conversations like any conversation.
    const loopTags = await loopSessionTags().catch(() => new Map());
    if (loopTags.size > 0) {
      sessionsWithFlags = sessionsWithFlags.map((session) => {
        const tag = loopTags.get(session.id);
        return tag ? { ...session, loopOrchestrator: true } : session;
      });
    }

    return NextResponse.json({ sessions: sessionsWithFlags, runningSessionIds: runningIds.ids });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
