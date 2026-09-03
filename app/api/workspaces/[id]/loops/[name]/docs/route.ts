import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { getLoopDocs, writeLoopFile, LoopManageError, type WriteTarget } from "@/lib/loops/manage";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof LoopManageError) {
    return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
  }
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** 配置面板数据包（spec §5.1）：知识文档列表+内容 / LOOP.md 正文 / STATE.md（只读）/
 *  宪法两文件（存在性+内容+模板）/ 绑定工作项 / running+paused。 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    return NextResponse.json(await getLoopDocs(path, name));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 唯一写入口（spec §5.1/§5.2）：target 判别联合 doc|body|constitution；
 *  文件名白名单与路径越界校验在 manage.ts；baseMtime 乐观并发（409 附当前内容）。 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const body = (await req.json().catch(() => ({}))) as {
      target?: WriteTarget;
      content?: string;
      baseMtimeMs?: number;
    };
    if (!body.target || typeof body.content !== "string") {
      return NextResponse.json({ error: "body 需要 {target, content}" }, { status: 400 });
    }
    return NextResponse.json(
      await writeLoopFile(path, name, body.target, body.content, body.baseMtimeMs),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
