// final-arch step-2 Task 5（2026-10-26）：attention 队列只读 GET（薄壳，spec §8
// ——唯一的人工待办队列）。GET /api/workspaces/[id]/attention → { entries:
// AttentionEntry[] }——collectAttention（attention.ts，与 dispatcher 第三步共用
// 同一装配器）。只读无 capability 门（与 GET /delivery/roles 同款）；投影内部
// 错误 → workItemErrorResponse 映射。nudge/park 的写侧在 dispatcher（催办/泊车
// 是宿主心跳的事，不是路由的事）。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { collectAttention } from "@/lib/work-items/attention";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    return NextResponse.json({ entries: await collectAttention(path) });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
