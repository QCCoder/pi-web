import { NextResponse } from "next/server";
import { listRunSnapshots } from "@/lib/loop/store";
import type { LoopRun } from "@/lib/loop/types";
import { getWorkspace } from "@/lib/workspaces/service";

/** Sidebar Loop run records: web-process direct read of RUNS.jsonl (deduped
 *  latest snapshot per run — see listRunSnapshots). v3: runs are thin SELECTION
 *  rounds — there is no work-item join anymore (the run's `seededSessionId`,
 *  when present, opens the execution session directly; execution sessions are
 *  linked to their work item via `item.conversations` like any conversation).
 *
 *  Snapshots are surfaced as recorded — a `running` snapshot whose session
 *  file has since vanished is shown as-is (no read-time "correction"): some of
 *  those runs are user-driven self-checks and must not be auto-failed. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const loopId = new URL(request.url).searchParams.get("loopId") ?? undefined;
    const { path, manifest } = await getWorkspace(id);
    const workspace = { id: manifest.id, name: manifest.name, path };
    const runs: LoopRun[] = await listRunSnapshots(workspace, loopId);
    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
