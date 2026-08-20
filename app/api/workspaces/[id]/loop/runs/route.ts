import { NextResponse } from "next/server";
import { listRunSnapshots } from "@/lib/loop/store";
import { orchestratorWorkItemIndex } from "@/lib/loop/session-tags";
import type { LoopRunWithWorkItem } from "@/lib/loop/types";
import { getWorkspace } from "@/lib/workspaces/service";

/** Sidebar Loop run records: web-process direct read of RUNS.jsonl (deduped
 *  latest snapshot per run — see listRunSnapshots) joined with the work item
 *  each run's orchestrator session picked. The loop host is NOT involved: it
 *  owns the runtime (trigger/gate/abort), while authoring and reads stay in
 *  the web process (same split as loop authoring).
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
    const runs = await listRunSnapshots(workspace, loopId);
    const items = await orchestratorWorkItemIndex(workspace);
    const withItems: LoopRunWithWorkItem[] = runs.map((run) => ({
      run,
      ...(run.sessionId && items.has(run.sessionId)
        ? { workItem: items.get(run.sessionId) }
        : {}),
    }));
    return NextResponse.json({ runs: withItems });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
