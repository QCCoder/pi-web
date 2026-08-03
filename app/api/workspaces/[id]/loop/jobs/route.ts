import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { listJobs, writeJob } from "@/lib/loop/store";
import { ensureLoopSchedulerStarted } from "@/lib/loop/scheduler";
import { loopErrorResponse } from "@/lib/loop/web";
import type { UpsertLoopJobInput } from "@/lib/loop/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    // Ensure the scheduler is live whenever the UI reads jobs (defensive — it
    // also starts on boot via instrumentation).
    ensureLoopSchedulerStarted();
    const jobs = await listJobs(path);
    return NextResponse.json({ jobs });
  } catch (error) {
    return loopErrorResponse(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    const input = (await req.json()) as UpsertLoopJobInput;
    const job = await writeJob(path, input);
    ensureLoopSchedulerStarted();
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return loopErrorResponse(error);
  }
}
