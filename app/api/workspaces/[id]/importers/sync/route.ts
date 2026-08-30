import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import { daemonClient } from "@/lib/daemon/client";
import { syncImporterForWorkspace } from "@/lib/work-items/importers/runner";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** POST a manual Importer sync. Forwards to the daemon (which owns the cron
 *  timer per design §5; the web server holds no timers). If the host is
 *  unreachable, runs the sync in-process as a graceful fallback — a one-shot
 *  synchronous request is not a timer, so this does not violate "web server
 *  owns no unattended timers". */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);

    // Forward to the host first (single source of truth for importer runs).
    const forwarded = await daemonClient.syncImporters(manifest.id);
    if (forwarded) {
      return NextResponse.json({ summary: forwarded, ranVia: "daemon" });
    }

    // Host unreachable — run in-process so a manual click still works.
    const summary = await syncImporterForWorkspace(manifest.id);
    return NextResponse.json({ summary, ranVia: "web-process" });
  } catch (error) {
    return errorResponse(error);
  }
}
