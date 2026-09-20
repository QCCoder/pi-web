import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache, cacheSessionPath } from "@/lib/session-reader";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Pure proxy over the session daemon (C2): the session is created in the
// daemon process — the single session owner. The web layer only syncs its
// file-access allow-list with the daemon-returned cwd and invalidates the
// session-list cache so the new .jsonl shows up immediately.
export async function POST(req: Request) {
  // Prompt 拒绝标注（upstream 6ac87ec）：建会话请求携带的 prompt 未被受理就
  // 以错误应答时，附上 code/accepted 供客户端区分拒绝与含糊失败。
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, { status: 400 });
    }

    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = body as {
      provider?: string;
      modelId?: string;
      toolNames?: string[];
      thinkingLevel?: string;
      [key: string]: unknown;
    };

    const client = await daemonProxy();
    const result = await client.createSession({
      cwd: body.cwd,
      ...(provider ? { provider } : {}),
      ...(modelId ? { modelId } : {}),
      ...(toolNames ? { toolNames } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // ensure_session (and any other create-only input) stops at creation.
      ...(promptCommand.type === "ensure_session" || typeof promptCommand.type !== "string"
        ? {}
        : { command: promptCommand as { type: string; [key: string]: unknown } }),
    });

    // Mark the prompt as accepted as soon as the daemon accepted the session —
    // BEFORE the cache/invalidate bookkeeping below. If any of those throws,
    // the catch must not mislabel an already-accepted prompt as rejected
    // (downstream reconcile would paper over it, but the flag would lie).
    promptAccepted = promptCommand.type === "prompt";

    // Keep the files-route allowed-roots cache in sync so the new cwd is
    // immediately readable via /api/files (the allow-list lives in the web
    // process — the daemon only tells us where the session landed).
    allowFileRoot(result.cwd || body.cwd);
    // Seed the id→path cache: the daemon creates the .jsonl lazily (first
    // append), so without this the client's immediate GET /api/sessions/:id
    // would scan the disk, miss the file, and poison the 30s session-list
    // cache with a 404 — exactly the "new session reply invisible until you
    // switch away and back" bug. With the path seeded the GET resolves from
    // cache and answers "empty but valid" until the first append lands.
    if (result.sessionFile) cacheSessionPath(result.sessionId, result.sessionFile);
    invalidateSessionListCache();

    return NextResponse.json({ success: true, sessionId: result.sessionId, data: result.data });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: daemonErrorStatus(error) });
  }
}
