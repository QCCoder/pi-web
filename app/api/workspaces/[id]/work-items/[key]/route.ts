import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import {
  readWorkItem,
  trashWorkItem,
  updateWorkItem,
} from "@/lib/work-items/service";
import type { UpdateWorkItemInput } from "@/lib/work-items/types";
import { workItemErrorResponse } from "@/lib/work-items/web";
import {
  cascadeArchiveWorkItemSessions,
  cascadeRestoreWorkItemSessions,
} from "@/lib/archive-cascade";

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
    const detail = await updateWorkItem(id, key, input);
    // When the archived flag is toggled, cascade session state to match:
    // archiving tucks away the item's now-orphaned sessions; restoring brings
    // its conversations back out of the archive.
    if (input.archived !== undefined) {
      const workspace = await getWorkspace(id);
      if (detail.item.archivedAt) {
        await cascadeArchiveWorkItemSessions(detail.item, workspace.path);
      } else {
        await cascadeRestoreWorkItemSessions(detail.item);
      }
    }
    return NextResponse.json(detail);
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
