// Phase-2 Task 8: 恢复自动领取（POST body {key}）。薄壳直调 resumeAutomation
// （清 automation-paused + 重置失败窗口 + delivery.resumed 事件，actor=user）
// ——key 在 body 而非路径（该路由在 work-items 段之外，配置/控制动作共用
// /delivery 前缀）。未暂停 → 服务 Validation → 400（workItemErrorResponse）。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { WorkItemValidationError } from "@/lib/work-items/errors";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { resumeAutomation } from "@/lib/work-items/delivery-runner/claim";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    const body = await req.json().catch(() => ({})) as { key?: string };
    if (typeof body.key !== "string" || !body.key.trim()) {
      throw new WorkItemValidationError("key is required");
    }
    const detail = await resumeAutomation(path, body.key.trim());
    return NextResponse.json(detail);
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
