import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { stopRound } from "@/lib/loops/rounds";
import { reapOrphanedRoundProcesses } from "../../../../../../../packages/pi-loop/reap.ts";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";

/** 终止本轮（S4）：daemon 持有 → DELETE /v1/sessions/:id（现有面）+ 包内 reap
 *  + 释放锁（下轮可立即补跑——确认弹层「未完成工作由下轮补」的承诺）；
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
    const client = await daemonProxy();
    const outcome = await stopRound(declaration, {
      destroySession: (sessionId) => client.destroySession(sessionId),
      reap: (path) => reapOrphanedRoundProcesses(path),
    });
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
      { status: daemonErrorStatus(error) },
    );
  }
}
