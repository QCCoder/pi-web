import { NextResponse } from "next/server";
import { loopHostClient } from "@/lib/loop/client";

/** Abort a run: destroy its orchestrator session and mark it failed. Independent
 *  of gate answering — works whether the run is running or paused at a gate. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { id, runId } = await params;
    return NextResponse.json(await loopHostClient.abortRun(id, runId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
