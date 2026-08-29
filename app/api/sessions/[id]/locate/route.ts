import { NextResponse } from "next/server";
import { daemonClient } from "@/lib/daemon/client";
import { findSessionIndexEntry } from "@/lib/session-index";
import { resolveProject } from "@/lib/worktree";
import { cacheSessionPath, firstMessageTitle } from "@/lib/session-reader";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Resolve a session id to a SessionInfo so the UI can open it by id.
 *
 *  Used by `handleOpenConversation` (work-item linked conversations, opened
 *  by id) and `handleOpenSessionViewer` (subagent children). Two sources,
 *  in order of authority:
 *    1. daemon probe — the orchestrator session physically lives in the daemon
 *       Host process, which knows its cwd + sessionFile immediately.
 *    2. Session index — mtime-incremental over `~/.pi/agent/sessions` (active +
 *       `.archived/`), so a freshly written .jsonl resolves without a full disk
 *       scan and WITHOUT invalidating the (cheap) list cache.
 */
async function sessionInfoFromIndex(id: string): Promise<SessionInfo | null> {
  const entry = await findSessionIndexEntry(id);
  if (!entry) return null;
  const project = entry.cwd ? await resolveProject(entry.cwd) : undefined;
  cacheSessionPath(entry.id, entry.path);
  return {
    path: entry.path,
    id: entry.id,
    cwd: entry.cwd,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    created: new Date(entry.createdMs).toISOString(),
    modified: new Date(entry.modifiedMs).toISOString(),
    messageCount: entry.messageCount,
    firstMessage: firstMessageTitle(entry),
    projectRoot: project?.projectRoot ?? entry.cwd,
    ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const meta = await daemonClient.probeSession(id);
    if (meta) {
      const session: SessionInfo = {
        path: meta.sessionFile ?? "",
        id: meta.id,
        cwd: meta.cwd ?? "",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 0,
        firstMessage: "(loop session)",
        projectRoot: meta.cwd ?? "",
      };
      // Best-effort enrich from the index: the probe carries no
      // firstMessage/stats, and the .jsonl (orchestrator or running subagent
      // child) usually exists already — real stats make the tab label
      // meaningful. Keep the probe's authoritative path/cwd when it has them
      // (live wrapper); a COLD orchestrator probe (gate-paused after a host
      // restart) has neither — then the index's values are the authority.
      const onDisk = await sessionInfoFromIndex(id);
      // Seed the path cache from the probe even when the index misses: a
      // freshly spawned subagent child's .jsonl may not exist yet (pi creates
      // it lazily on first append), so the index cannot know it — but the
      // daemon registry already does. With the path cached, GET
      // /api/sessions/[id] answers the empty-but-valid placeholder and the
      // viewer renders live SSE on top instead of 404ing ("cannot resolve").
      if (meta.sessionFile) cacheSessionPath(id, meta.sessionFile);
      if (onDisk) {
        return NextResponse.json({
          session: {
            ...onDisk,
            ...(meta.sessionFile ? { path: meta.sessionFile } : {}),
            ...(meta.cwd ? { cwd: meta.cwd, projectRoot: meta.cwd } : {}),
          },
          source: "loop",
        });
      }
      // Cold probe without a disk hit: the .jsonl is gone — nothing to open.
      if (!meta.sessionFile) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      return NextResponse.json({ session, source: "loop" });
    }
  } catch {
    // Daemon unreachable — fall through to the index.
  }
  const found = await sessionInfoFromIndex(id);
  if (found) return NextResponse.json({ session: found, source: "disk" });
  return NextResponse.json({ error: "Session not found" }, { status: 404 });
}
