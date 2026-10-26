// Seam-repositioning Task 4（2026-10-26）：四角色摘要只读 GET（薄壳）。
// GET /api/workspaces/[id]/delivery/roles → { roles: RoleSummary[] }——
// summarizeRoles（role-preview.ts）over readDeliveryRunnerConfig（config null
// = 文件缺失，按全缺省投影）。只读无 capability 门（与 GET /delivery 同款）；
// 配置坏 YAML → workItemErrorResponse（Validation → 400）。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { readDeliveryRunnerConfig } from "@/lib/work-items/delivery-runner/config";
import { summarizeRoles } from "@/lib/work-items/delivery-runner/role-preview";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    return NextResponse.json({ roles: summarizeRoles(path, await readDeliveryRunnerConfig(path)) });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
