import { NextResponse } from "next/server";
import { loopHostClient } from "@/lib/loop/client";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { id, runId } = await params;
    const input = await request.json() as { decision: "approve" | "reject"; comment?: string };
    return NextResponse.json(await loopHostClient.answerGate({ workspaceId: id, runId, ...input }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
