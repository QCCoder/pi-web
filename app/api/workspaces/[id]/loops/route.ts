import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from "@/lib/workspaces/service";
import { discoverKitLoops } from "@/lib/daemon/loop-kit";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError
    ? 404
    : error instanceof WorkspaceConflictError
      ? 409
      : error instanceof WorkspaceValidationError
        ? 400
        : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** Kit-declared loops of a workspace (read-only). Discovery is pure fs+yaml
 *  (`lib/daemon/loop-kit.ts` has no daemon dependencies — safe to import in
 *  the web process): a loop EXISTS by its `loops/<name>/LOOP.md` frontmatter
 *  (D5 文件即声明), no manifest capability involved. The work-item contract
 *  prefill (D11) and the 开始对话/收养续跑 button gate read this list. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    const loops = discoverKitLoops(path).map((declaration) => ({
      name: declaration.loopName,
      pattern: declaration.pattern,
      level: declaration.level,
      cron: declaration.cron,
    }));
    return NextResponse.json({ loops });
  } catch (error) {
    return errorResponse(error);
  }
}
