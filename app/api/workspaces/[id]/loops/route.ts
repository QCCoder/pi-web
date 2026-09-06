import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from "@/lib/workspaces/service";
import { collectStatus } from "../../../../../packages/pi-loop/status.ts";
import { createLoop, LoopManageError, type CreateLoopInput } from "@/lib/loops/manage";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof LoopManageError) {
    return NextResponse.json(
      { error: error.message, ...error.details },
      { status: error.status },
    );
  }
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

/** Kit-declared loops of a workspace with per-loop run status (read-only).
 *  Status collection (`pi-loop/status.ts` is pure fs+yaml — safe to import in
 *  the web process): a loop EXISTS by its `loops/<name>/LOOP.md` frontmatter
 *  (D5 文件即声明), no manifest capability involved. Returns the FULL set
 *  including paused loops (管理面全量, web spec §5.1) — consumers filter
 *  `paused` themselves (D11 gate semantics: paused = not there). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    // 管理面数据（web spec §5.1）：includePaused 发现 + 每 loop 的运行状态
    // （.round.lock 活性 + .lastrun + nextDue，与 pi-loop status CLI 同一口径）。
    // 消费方自行过滤 paused（D11 门控语义：暂停即不存在）。
    return NextResponse.json({ loops: collectStatus(path) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 创建 loop（spec §5.1）：向导表单 → 校验 → pi-loop initLoop 脚手架
 *  （五件套 + SKILL 骨架 + .lastrun=now，首轮等自然槽）。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    const input = (await req.json().catch(() => ({}))) as CreateLoopInput;
    const created = await createLoop(path, input);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
