// Seam-repositioning Task 4（2026-10-26）：组合预览只读 GET（薄壳）。
// GET /api/workspaces/[id]/delivery/roles/[role]/preview → { preview }——
// previewRolePrompt（role-preview.ts）：composed 与 launch 的
// appendSystemPrompt 同一函数。role ∉ DELIVERY_ROLES → 404 JSON（词表门在
// 投影之前）；配置坏 YAML → workItemErrorResponse（Validation → 400）；只读
// 无 capability 门（与 GET /delivery 同款）。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { readDeliveryRunnerConfig } from "@/lib/work-items/delivery-runner/config";
import { previewRolePrompt } from "@/lib/work-items/delivery-runner/role-preview";
import { isDeliveryRole } from "@/lib/work-items/delivery-runner/roles";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; role: string }> },
) {
  const { id, role } = await params;
  if (!isDeliveryRole(role)) {
    return NextResponse.json({ error: `unknown delivery role: ${role}` }, { status: 404 });
  }
  try {
    const { path } = await getWorkspace(id);
    return NextResponse.json({
      preview: previewRolePrompt(path, role, await readDeliveryRunnerConfig(path)),
    });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
