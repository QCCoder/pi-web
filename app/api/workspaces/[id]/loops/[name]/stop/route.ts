import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { stopRound, type StopRoundDeps } from "@/lib/loops/rounds";
import { destroySession, runningStatus, SessionHostError } from "@/lib/session-host/facade";

/** 终止本轮（S4）：宿主持有 → facade destroy（定向中止在飞 prompt）+ 释放锁
 *  （下轮可立即补跑——确认弹层「未完成工作由下轮补」的承诺）；
 *  beat 持有 → 409 提示走 pi-loop stop（web 不代杀本机 beat 进程）。 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    const deps: StopRoundDeps = {
      destroySession: async (sessionId) => destroySession(sessionId),
      // 共享宿主禁止 cwd 收割：destroy() 内 abortBash 已按进程组定向杀
      reap: async () => undefined,
      // 幽灵锁判定：轮已收尾（会话不在 running set）时直接清锁，无需 destroy
      runningSessionIds: async () => runningStatus().ids,
    };
    const outcome = await stopRound(declaration, deps);
    if (outcome === "not-running") {
      return NextResponse.json({ error: "本轮未在运行" }, { status: 409 });
    }
    if (outcome === "beat-held") {
      return NextResponse.json(
        { error: `该轮由 pi-loop beat 持有，请在宿主机执行 \`pi-loop stop ${declaration.loopName}\`` },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof SessionHostError ? error.status : 500 },
    );
  }
}
