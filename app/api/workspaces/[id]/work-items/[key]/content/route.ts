import { NextResponse } from "next/server";
import { updateWorkItemContent } from "@/lib/work-items/service";
import type { UpdateWorkItemContentInput } from "@/lib/work-items/types";
import { workItemErrorResponse } from "@/lib/work-items/web";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const input = await req.json() as UpdateWorkItemContentInput;
    return NextResponse.json(await updateWorkItemContent(id, key, input));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
