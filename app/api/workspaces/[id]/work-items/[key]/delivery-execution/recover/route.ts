// Phase-2 Task 8: 交付执行中断的「重新检查并恢复」（POST，spec §5.3；与 M1
// loop recover 同形）。探测作用域 = 工作区根（T8 裁定——designer 角色会话
// cwd=工作区根，detectSurvivingRoundProcesses 的 ppid=1+cwd 判定按根收口）：
// 探测到存活命令进程 → 409 {error, pids}（manual=true 也不放行实测存活）；
// 干净 → resolveInterruptions（needsAttention:false，manual 登记诊断 actor
// =user）+ delivery.exec_recovered 事件 → {ok:true, resolved:n}。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { appendEvent, eventFor, readWorkItem } from "@/lib/work-items/service";
import { resolveInterruptions } from "@/lib/work-items/delivery-runner/attempts";
import { detectSurvivingRoundProcesses } from "@/lib/loops/executions";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const { path } = await getWorkspace(id);
    const detail = await readWorkItem(path, key); // item 不存在 → 404

    const body = await req.json().catch(() => ({})) as { manual?: boolean };
    const pids = await detectSurvivingRoundProcesses(path);
    if (pids.length > 0) {
      return NextResponse.json(
        {
          error: `检测到 ${pids.length} 个疑似残留命令进程（pid: ${pids.join(", ")}），请先在本机处理后再恢复`,
          pids,
        },
        { status: 409 },
      );
    }
    const resolved = await resolveInterruptions(detail.path, {
      needsAttention: false,
      diagnostic: {
        checkedAt: new Date().toISOString(),
        ...(body.manual === true ? { actor: "user" } : {}),
      },
    });
    await appendEvent(
      detail.path,
      eventFor("delivery.exec_recovered", body.manual === true ? "user" : "system", undefined, {
        resolved,
        ...(body.manual === true ? { manual: true } : {}),
      }),
    );
    return NextResponse.json({ ok: true, resolved });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
