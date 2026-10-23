import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { detectSurvivingRoundProcesses, resolveExecutionRecords } from "@/lib/loops/executions";

/** 「重新检查并恢复」（spec §5.4）：重查旧会话与已知命令进程。已证明停止 →
 *  解除（recovered-auto）；仍活动 → 拒绝（人工声明也不能覆盖实测存活）；
 *  探测干净时允许 manual 登记已停止（recovered-manual, actor=user）。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const declaration = findKitLoopByName(path, name);
    if (!declaration) return NextResponse.json({ error: "Loop not found" }, { status: 404 });

    const body = await req.json().catch(() => ({})) as { manual?: boolean };
    const pids = await detectSurvivingRoundProcesses(path);
    if (pids.length > 0) {
      return NextResponse.json(
        { error: `检测到 ${pids.length} 个疑似残留命令进程（pid: ${pids.join(", ")}），请先在本机处理后再恢复`, pids },
        { status: 409 },
      );
    }
    const resolved = await resolveExecutionRecords(path, declaration.loopName, {
      stopResult: body.manual === true ? "recovered-manual" : "recovered-auto",
      needsAttention: false,
      diagnostic: { checkedAt: new Date().toISOString(), ...(body.manual === true ? { actor: "user" } : {}) },
    });
    return NextResponse.json({ ok: true, resolved });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
