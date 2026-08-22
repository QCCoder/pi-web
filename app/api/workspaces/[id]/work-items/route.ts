import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { createWorkItem, listWorkItems } from "@/lib/work-items/service";
import type { CreateWorkItemInput } from "@/lib/work-items/types";
import { workItemErrorResponse } from "@/lib/work-items/web";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspace = await getWorkspace(id);
    // One request carries both lists (active + archived) — the sidebar used to
    // fetch this endpoint twice and scan every item directory twice.
    const result = await listWorkItems(workspace.path);
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
