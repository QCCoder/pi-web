import { NextResponse } from "next/server";
import { loopHostClient } from "@/lib/loop/client";

/** Answer a paused `LOOP_GATE:` with free text. The message is forwarded
 *  verbatim to the orchestrator as its next prompt; its meaning is defined by
 *  the loop's LOOP.md. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { id, runId } = await params;
    const input = await request.json().catch(() => ({})) as { message?: string };
    if (typeof input.message !== "string" || !input.message.trim()) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    return NextResponse.json(await loopHostClient.answerGate({ workspaceId: id, runId, message: input.message }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
