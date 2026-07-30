import { NextResponse } from "next/server";
import { recordWorkItemMilestone } from "@/lib/work-items/service";
import type { RecordWorkItemMilestoneInput } from "@/lib/work-items/types";
import { workItemErrorResponse } from "@/lib/work-items/web";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const input = await req.json() as RecordWorkItemMilestoneInput;
    return NextResponse.json(await recordWorkItemMilestone(id, key, input), { status: 201 });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
