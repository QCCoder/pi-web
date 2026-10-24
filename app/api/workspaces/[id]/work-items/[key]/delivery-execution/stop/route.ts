// Phase-2 Task 8: 人工停止正在执行的交付领取（POST）。链序即语义（与
// dispatcher 的超时收割同构）：probeSession 仍活 → 定向 destroySession（杀
// 在飞会话，不 cwd 收割）→ recordInterruption("stopped by user")（锁内清
// claim + needsAttention attempt + delivery.exec_interrupted 事件——池子的
// 中断门禁挡住自动重领，等人经 recover 解除）。无 claim → NotFound(404)。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { readWorkItem, WorkItemNotFoundError } from "@/lib/work-items/service";
import { readClaim } from "@/lib/work-items/delivery-runner/attempts";
import { recordInterruption } from "@/lib/work-items/delivery-runner/claim";
import { destroySession, probeSession } from "@/lib/session-host/facade";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const { path } = await getWorkspace(id);
    const detail = await readWorkItem(path, key);
    const claim = readClaim(detail.path);
    if (claim === null) {
      throw new WorkItemNotFoundError(`no active delivery claim on ${key}`);
    }
    const live = await probeSession(claim.sessionId);
    if (live !== null) destroySession(claim.sessionId);
    await recordInterruption(path, key, claim.sessionId, "stopped by user");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
