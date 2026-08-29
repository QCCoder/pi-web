import { NextResponse } from "next/server";
import { daemonClient } from "@/lib/daemon/client";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { id, runId } = await params;
    return NextResponse.json(await daemonClient.getRun(id, runId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
