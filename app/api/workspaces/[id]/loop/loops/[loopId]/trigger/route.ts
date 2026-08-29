import { NextResponse } from "next/server";
import { daemonClient } from "@/lib/daemon/client";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; loopId: string }> }) {
  try {
    const { id, loopId } = await params;
    const input = await request.json().catch(() => ({})) as { eventId?: string; payload?: Record<string, unknown> };
    const eventId = input.eventId?.trim() || `manual:${crypto.randomUUID()}`;
    return NextResponse.json(await daemonClient.trigger({
      workspaceId: id, loopId, source: "manual", eventId, payload: input.payload,
    }), { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
