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
    // 导入去重（spec §8.1）：同 source+sourceId 已存在（含归档/回收站墓碑）
    // → 200 + 既有项（原样返回，未覆盖）；新建 → 201。响应体保留
    // WorkItemDetail 字段（path/item/content/events 展开），旧脚本读得到。
    const { detail, importOutcome } = await createWorkItem(id, input);
    return NextResponse.json(
      { ...detail, importOutcome },
      { status: importOutcome === "created" ? 201 : 200 },
    );
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
