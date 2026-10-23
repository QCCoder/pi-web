import { NextResponse } from "next/server";
import { probeSession, sendCommand, SessionHostError } from "@/lib/session-host/facade";

// POST /api/agent/[id] - Send a command to an existing session.
// Direct call into the in-process host facade — the single session owner, so
// ANY command (prompt, fork, navigate_tree, extension UI responses, …) goes
// verbatim. The facade cold-starts idle sessions from their .jsonl exactly
// like this route used to through the daemon — semantics preserved end-to-end.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Prompt 拒绝标注（upstream 6ac87ec）：prompt 命令未被受理就以错误应答时，
  // 附上 code/accepted，客户端据此区分「确定被拒（回滚+恢复草稿）」与
  // 「派发后传输失败（含糊，等 reconcile 定夺）」。
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    if (typeof body.type !== "string") {
      return NextResponse.json({ error: "command type is required" }, { status: 400 });
    }
    const result = await sendCommand(id, body);
    promptAccepted = body.type === "prompt";
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: error instanceof SessionHostError ? error.status : 500 });
  }
}

// GET /api/agent/[id] - Get current agent state.
// Direct probe through the facade: the host owns every session, so "is it
// running + its state" has exactly one answer. An idle session (no live
// wrapper in the registry) reports { running: false }, same as before.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const meta = await probeSession(id);
    if (!meta) {
      return NextResponse.json({ running: false });
    }
    return NextResponse.json({ running: meta.running, state: meta.state ?? undefined });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof SessionHostError ? error.status : 500 });
  }
}
