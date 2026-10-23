import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { restoreWorkItemFromTrashInRoot } from "@/lib/work-items/service";
import { workItemErrorResponse } from "@/lib/work-items/web";

// M2 Task 5：回收站恢复。key 被占用 → 409（Conflict 已在 web.ts 映射）；
// 回收站无此 key → 404；坏墓碑 item.yaml → 400。
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const workspace = await getWorkspace(id);
    return NextResponse.json(await restoreWorkItemFromTrashInRoot(workspace.path, key));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
