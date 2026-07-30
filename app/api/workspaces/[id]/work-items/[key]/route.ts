import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import {
  readWorkItem,
  trashWorkItem,
  updateWorkItem,
} from "@/lib/work-items/service";
import type { UpdateWorkItemInput } from "@/lib/work-items/types";
import { workItemErrorResponse } from "@/lib/work-items/web";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const workspace = await getWorkspace(id);
    return NextResponse.json(await readWorkItem(workspace.path, key));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const input = await req.json() as UpdateWorkItemInput;
    return NextResponse.json(await updateWorkItem(id, key, input));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    return NextResponse.json(await trashWorkItem(id, key));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
