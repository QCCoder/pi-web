import { NextResponse } from "next/server";
import { invalidateSessionListCache, listAllSessions } from "@/lib/session-reader";
import { loopHostClient } from "@/lib/loop/client";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Resolve a session id to a SessionInfo so the UI can open it by id.
 *
 *  Used by `handleOpenLoopSession` after a Loop round reports its orchestrator
 *  session id. Two sources, in order of authority:
 *    1. Loop Host probe — the orchestrator session physically lives in the Loop
 *       Host process, which knows its cwd + sessionFile immediately. This works
 *       even before Pi's 30s session-list cache picks up the freshly written
 *       .jsonl, and regardless of where on disk the file landed.
 *    2. Disk fallback — force a fresh scan (bypass the cache) and look it up.
 *       Covers the case where the Loop Host is down or running older code. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const meta = await loopHostClient.probeSession(id);
    if (meta) {
      const session: SessionInfo = {
        path: meta.sessionFile || "",
        id: meta.id,
        cwd: meta.cwd,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 0,
        firstMessage: "(loop session)",
        projectRoot: meta.cwd,
      };
      // Best-effort enrich from disk: the probe carries no firstMessage/stats,
      // and the .jsonl (orchestrator or running subagent child) usually exists
      // already — real stats make the tab label meaningful. Keep the probe's
      // authoritative path/cwd even when the scan hasn't caught up yet.
      invalidateSessionListCache();
      const onDisk = (await listAllSessions()).find((s) => s.id === id);
      if (onDisk) {
        return NextResponse.json({ session: { ...onDisk, path: session.path, cwd: session.cwd, projectRoot: session.projectRoot }, source: "loop" });
      }
      return NextResponse.json({ session, source: "loop" });
    }
  } catch {
    // Loop Host unreachable — fall through to the disk scan.
  }
  invalidateSessionListCache();
  const all = await listAllSessions();
  const found = all.find((s) => s.id === id);
  if (found) return NextResponse.json({ session: found, source: "disk" });
  return NextResponse.json({ error: "Session not found" }, { status: 404 });
}
