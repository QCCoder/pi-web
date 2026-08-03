import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { readJob } from "@/lib/loop/store";
import { ensureLoopSchedulerStarted, getLoopScheduler } from "@/lib/loop/scheduler";
import { loopErrorResponse } from "@/lib/loop/web";

/** POST triggers a manual run. The run is detached from the request so a long
 *  agent execution survives client disconnect; it resolves into the run history
 *  (GET .../loop/runs?job=<name>). Returns 202 immediately. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    // Validate the job exists before kicking off the run.
    const job = await readJob(path, name);
    ensureLoopSchedulerStarted();
    void getLoopScheduler().runJobNow(id, job.name).catch((error) => {
      console.error(
        `[loop] manual run failed for ${id}/${job.name}:`,
        error instanceof Error ? error.message : error,
      );
    });
    return NextResponse.json({ ok: true, started: true, jobName: job.name }, { status: 202 });
  } catch (error) {
    return loopErrorResponse(error);
  }
}
