import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { launchManualRound, RoundBusyError, type LaunchRoundDeps } from "@/lib/loops/rounds";
import { createSession, destroySession, runningStatus, sendCommand, SessionHostError } from "@/lib/session-host/facade";
import { markRoundActive } from "@/lib/session-host/background";
import { allowFileRoot } from "@/lib/file-access";
import { cacheSessionPath, invalidateSessionListCache } from "@/lib/session-reader";

/** 「立即跑一轮」（spec §4，S3）：web 进程 import pi-loop 纯逻辑组装开场合同，
 *  经宿主 facade 直连起轮。itemKey 存在则合同追加
 *  「本轮优先处理 <KEY>」。返回 sessionId，UI 打开会话 tab 实时观看。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as { itemKey?: string };
    if (body.itemKey !== undefined && typeof body.itemKey !== "string") {
      return NextResponse.json({ error: "itemKey must be a string" }, { status: 400 });
    }
    const deps: LaunchRoundDeps = {
      createSession: (input) => createSession(input),
      sendCommand: (sessionId, command) => sendCommand(sessionId, command),
      destroySession: async (sessionId) => destroySession(sessionId),
      // 幽灵锁活性接管：锁里的 sessionId 不在宿主 running set 即可清锁重起
      runningSessionIds: async () => runningStatus().ids,
    };
    const result = await launchManualRound(
      declaration,
      body.itemKey ? { itemKey: body.itemKey } : {},
      deps,
    );
    // 手动轮登记（spec §5.4）：关停时若该会话仍在 running set → 写中断记录
    // 阻塞恢复。轮结束无从得知（人不等）——已收尾的轮在关停序列里被
    // runningBySession 过滤，登记只作陈旧标记留在内存，进程退出即清。
    markRoundActive(result.sessionId, {
      loopName: declaration.loopName,
      workspacePath: declaration.workspacePath,
      dir: declaration.dir,
      startedAt: Date.now(),
    });
    // /api/agent/new 同款后处理：files 路由 allow-list 同步 + id→path 缓存播种
    // （.jsonl 懒建，不播种则紧随其后的 locate 404）+ 会话列表缓存失效。
    if (result.cwd) allowFileRoot(result.cwd);
    if (result.sessionFile) cacheSessionPath(result.sessionId, result.sessionFile);
    invalidateSessionListCache();
    return NextResponse.json({ sessionId: result.sessionId });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof RoundBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof SessionHostError ? error.status : 500 },
    );
  }
}
