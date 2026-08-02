import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { createWorkItem, listWorkItems } from "@/lib/work-items/service";
import type { CreateWorkItemInput } from "@/lib/work-items/types";
import { workItemErrorResponse } from "@/lib/work-items/web";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspace = await getWorkspace(id);
    const result = await listWorkItems(workspace.path);
    // ?archived=1 returns only archived items (for the View Archived modal);
    // the default omits them so the overview shows only active work.
    if (new URL(req.url).searchParams.has("archived")) {
      return NextResponse.json({
        items: result.items.filter((item) => item.archivedAt !== null),
        invalid: result.invalid,
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    return workItemErrorResponse(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const input = await req.json() as CreateWorkItemInput;
    return NextResponse.json(await createWorkItem(id, input), { status: 201 });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
