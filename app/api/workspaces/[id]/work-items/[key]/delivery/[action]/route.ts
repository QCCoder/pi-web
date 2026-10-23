import { NextResponse } from "next/server";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { applyDeliveryAction } from "@/lib/work-items/delivery";
import { DELIVERY_ACTIONS, type DeliveryAction } from "@/lib/work-items/delivery-types";

/** Slug gate over the canonical list (delivery-types.ts) instead of a
 * route-local copy — a newly added action becomes routable without touching
 * this file. */
const DELIVERY_ACTION_SLUGS: ReadonlySet<string> = new Set(DELIVERY_ACTIONS);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string; action: string }> },
) {
  try {
    const { id, key, action } = await params;
    if (!DELIVERY_ACTION_SLUGS.has(action)) {
      return NextResponse.json({ error: `Unknown delivery action: ${action}` }, { status: 400 });
    }
    const body = await req.json() as {
      expectedRevision?: number; requestId?: string; payload?: Record<string, unknown>;
    };
    const outcome = await applyDeliveryAction({
      workspaceId: id,
      key,
      action: action as DeliveryAction,
      expectedRevision: body.expectedRevision as number,
      requestId: body.requestId as string,
      payload: body.payload,
    });
    return NextResponse.json(outcome);
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
