import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { launchManualRound, RoundBusyError } from "@/lib/loops/rounds";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";
import { allowFileRoot } from "@/lib/file-access";
import { cacheSessionPath, invalidateSessionListCache } from "@/lib/session-reader";

/** 「立即跑一轮」（spec §4，S3）：web 进程 import pi-loop 纯逻辑组装开场合同，
 *  经现有 daemon 会话面起轮（不新增 daemon 路由）。itemKey 存在则合同追加
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
    const client = await daemonProxy();
    const result = await launchManualRound(
      declaration,
      body.itemKey ? { itemKey: body.itemKey } : {},
      {
        createSession: (input) => client.createSession(input),
        sendCommand: (sessionId, command) => client.sendSessionCommand(sessionId, command),
        destroySession: (sessionId) => client.destroySession(sessionId),
        // 幽灵锁活性接管：锁里的 sessionId 不在 daemon running set 即可清锁重起
        runningSessionIds: async () => (await client.runningSessionIds()).ids,
      },
    );
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
      { status: daemonErrorStatus(error) },
    );
  }
}
