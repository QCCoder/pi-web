import { NextResponse } from "next/server";
import { loopHostClient } from "@/lib/loop/client";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { id, runId } = await params;
    return NextResponse.json(await loopHostClient.getRun(id, runId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
