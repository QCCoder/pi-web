// final-arch step-6 Task 1（2026-10-26）：就绪清单（GET …/delivery/readiness）
// 只读投影薄壳——无 capability 门（roles / attention 路由同款只读约定；非门禁
// 投影，设置面板常驻显示）。投影语义（五类缺项、宽容坏配置）归
// lib/workspaces/delivery-init.ts；错误统一 workItemErrorResponse。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { deliveryReadiness } from "@/lib/workspaces/delivery-init";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    return NextResponse.json(await deliveryReadiness(path));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
