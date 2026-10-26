// Phase-2 Task 1: 工作区交付自动化配置 `.pi/delivery.yaml` 的 GET|PUT 薄壳。
// PUT 在写入前先做 capability 门（work-items + workflows）；解析/读写的
// 校验错误经 workItemErrorResponse 映射（Validation → 400）。
// Seam-repositioning Task 3（2026-10-26）：PUT 写入成功后播种默认剧本模板到
// `<ws>/.pi/agents/`（seedRoleProfileTemplates——一次性，记录在产品持有的
// .pi/delivery-seeded.json；已记录角色永不重播、删了不重建），响应带 seeded
// （written/skipped 角色列表）。
// Final-fix B（2026-10-26）：播种失败不打死保存——配置写入成功即事实，播种
// 包在自身 try/catch 内，失败 → console.error + 200 { config, seeded: null,
// seedingError }（UI 出非阻断警告，保存状态照常成功）。
// final-arch step-6 Task 2（2026-10-26）：写成功后同步 AGENTS.md delivery
// managed 块（updateManagedDeliveryInstructions——有标记才改写）。失败同样只记
// 日志不挡保存（配置已落盘即事实）。
// Final-fix（2026-10-26，I1）：块同步移到播种之后——首次保存的剧本由播种创建，
// 先同步会把四个角色渲染成 (missing)；链序 = 配置落盘 → 播种 → 块同步。
import { NextResponse } from "next/server";
import { getWorkspace, readWorkspaceManifest } from "@/lib/workspaces/service";
import { updateManagedDeliveryInstructions } from "@/lib/workspaces/delivery-managed";
import { WorkItemValidationError } from "@/lib/work-items/errors";
import { workItemErrorResponse } from "@/lib/work-items/web";
import {
  parseDeliveryRunnerConfig,
  readDeliveryRunnerConfig,
  writeDeliveryRunnerConfig,
  assertAutomationCapable,
} from "@/lib/work-items/delivery-runner/config";
import { seedRoleProfileTemplates, type SeedResult } from "@/lib/work-items/delivery-runner/role-templates";

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
    // 配置已落盘：播种失败不打死保存——降级 seeded:null + seedingError（200，
    // UI 非阻断警告），由播种自身兜错。播种先于块同步（final-fix I1）：首次保
    // 存的剧本在此创建，块的 exists/missing 投影要反映播种后的真实状态。
    let seeded: SeedResult | null = null;
    let seedingError: string | undefined;
    try {
      seeded = await seedRoleProfileTemplates(path);
    } catch (error) {
      seedingError = error instanceof Error ? error.message : String(error);
      console.error(`[delivery-runner] role template seeding failed for workspace ${id}:`, error);
    }
    // AGENTS.md delivery managed 块同步（有标记才改写）：失败记日志不挡保存。
    try {
      await updateManagedDeliveryInstructions(path);
    } catch (error) {
      console.error(`[delivery-runner] managed AGENTS.md sync failed for workspace ${id}:`, error);
    }
    return seedingError === undefined
      ? NextResponse.json({ config, seeded })
      : NextResponse.json({ config, seeded, seedingError });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
