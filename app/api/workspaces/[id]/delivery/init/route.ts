// final-arch step-6 Task 1（2026-10-26）：交付初始化（POST …/delivery/init）薄壳。
// capability 门先于一切写入（work-items + workflows，与 PUT /delivery 同门）；
// body 经 parseInitInput 校验（形状 → 400），init 语义（只补缺、只建议、永不
// 启用、永不执行命令）归 lib/workspaces/delivery-init.ts；错误统一
// workItemErrorResponse（Validation → 400、工作区不存在 → 404）。
import { NextResponse } from "next/server";
import { getWorkspace, readWorkspaceManifest } from "@/lib/workspaces/service";
import { assertAutomationCapable } from "@/lib/work-items/delivery-runner/config";
import { WorkItemValidationError } from "@/lib/work-items/errors";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { initializeDelivery, parseInitInput } from "@/lib/workspaces/delivery-init";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    assertAutomationCapable(await readWorkspaceManifest(path));
    const input = parseInitInput(
      await req.json().catch(() => {
        throw new WorkItemValidationError("invalid JSON body");
      }),
    );
    return NextResponse.json(await initializeDelivery(path, input));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
