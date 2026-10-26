// final-arch step-6 Task 1（2026-10-26）：交付初始化（POST …/delivery/init）薄壳。
// capability 门先于一切写入（work-items + workflows，与 PUT /delivery 同门）；
// body 经 parseInitInput 校验（形状 → 400），init 语义（只补缺、只建议、永不
// 启用、永不执行命令）归 lib/workspaces/delivery-init.ts；错误统一
// workItemErrorResponse（Validation → 400、工作区不存在 → 404）。
// Task 2（2026-10-26）：init 成功后同步 AGENTS.md delivery managed 块（有标记
// 才改写）——失败记日志不挡 init（初始化已落盘即事实）。
import { NextResponse } from "next/server";
import { getWorkspace, readWorkspaceManifest } from "@/lib/workspaces/service";
import { updateManagedDeliveryInstructions } from "@/lib/workspaces/delivery-managed";
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
    const result = await initializeDelivery(path, input);
    // AGENTS.md delivery managed 块同步（有标记才改写）：失败记日志不挡 init。
    try {
      await updateManagedDeliveryInstructions(path);
    } catch (error) {
      console.error(`[delivery-runner] managed AGENTS.md sync failed for workspace ${id}:`, error);
    }
    return NextResponse.json(result);
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
