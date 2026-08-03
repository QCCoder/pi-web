import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { deleteJob, readJob, writeJob } from "@/lib/loop/store";
import { loopErrorResponse } from "@/lib/loop/web";
import type { UpsertLoopJobInput } from "@/lib/loop/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const job = await readJob(path, name);
    return NextResponse.json({ job });
  } catch (error) {
    return loopErrorResponse(error);
  }
}

/** PUT updates an existing job. The route name is authoritative. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const input = (await req.json()) as UpsertLoopJobInput;
    const job = await writeJob(path, { ...input, name });
    return NextResponse.json({ job });
  } catch (error) {
    return loopErrorResponse(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    await deleteJob(path, name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return loopErrorResponse(error);
  }
}
