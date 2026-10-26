// Phase-2 Task 1: 工作区交付自动化配置 `.pi/delivery.yaml` 的 GET|PUT 薄壳。
// PUT 在写入前先做 capability 门（work-items + workflows）；解析/读写的
// 校验错误经 workItemErrorResponse 映射（Validation → 400）。
// Seam-repositioning Task 3（2026-10-26）：PUT 写入成功后播种默认剧本模板到
// `<ws>/.pi/agents/`（seedRoleProfileTemplates——write-if-missing，已有用户
// 文件不改写；每次保存幂等空转），响应带 seeded（written/skipped 角色列表）。
import { NextResponse } from "next/server";
import { getWorkspace, readWorkspaceManifest } from "@/lib/workspaces/service";
import { WorkItemValidationError } from "@/lib/work-items/errors";
import { workItemErrorResponse } from "@/lib/work-items/web";
import {
  parseDeliveryRunnerConfig,
  readDeliveryRunnerConfig,
  writeDeliveryRunnerConfig,
  assertAutomationCapable,
} from "@/lib/work-items/delivery-runner/config";
import { seedRoleProfileTemplates } from "@/lib/work-items/delivery-runner/role-templates";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    return NextResponse.json({ config: await readDeliveryRunnerConfig(path) });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    assertAutomationCapable(await readWorkspaceManifest(path));
    const config = parseDeliveryRunnerConfig(
      await req.json().catch(() => {
        throw new WorkItemValidationError("invalid JSON body");
      }),
    );
    await writeDeliveryRunnerConfig(path, config);
    const seeded = await seedRoleProfileTemplates(path);
    return NextResponse.json({ config, seeded });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
