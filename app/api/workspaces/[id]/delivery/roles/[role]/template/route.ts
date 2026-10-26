// final-arch step-6 Task 3（2026-10-26）：模板另存（POST …/delivery/roles/[role]/template）
// 薄壳——writeRoleTemplateCopy（role-templates.ts）把当前内置模板写到
// `<ws>/.pi/agents/<role>.template.md`（wx 写即全新，永不覆盖）。role ∉
// DELIVERY_ROLES → 404 JSON（词表门在写入之前，preview 路由同款）；它写盘，
// capability 门（assertAutomationCapable，与 PUT /delivery、init 同门）先于
// 写入；副本已存在 → WorkItemConflictError → workItemErrorResponse（409）；
// 工作区不存在 → 404；其它错误同映射。
import { NextResponse } from "next/server";
import { getWorkspace, readWorkspaceManifest } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { assertAutomationCapable } from "@/lib/work-items/delivery-runner/config";
import { writeRoleTemplateCopy } from "@/lib/work-items/delivery-runner/role-templates";
import { isDeliveryRole } from "@/lib/work-items/delivery-runner/roles";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; role: string }> },
) {
  const { id, role } = await params;
  if (!isDeliveryRole(role)) {
    return NextResponse.json({ error: `unknown delivery role: ${role}` }, { status: 404 });
  }
  try {
    const { path } = await getWorkspace(id);
    assertAutomationCapable(await readWorkspaceManifest(path));
    return NextResponse.json(await writeRoleTemplateCopy(path, role));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
