import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Pure proxy over the session daemon (C2): the session is created in the
// daemon process — the single session owner. The web layer only syncs its
// file-access allow-list with the daemon-returned cwd and invalidates the
// session-list cache so the new .jsonl shows up immediately.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };

    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
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

    // Keep the files-route allowed-roots cache in sync so the new cwd is
    // immediately readable via /api/files (the allow-list lives in the web
    // process — the daemon only tells us where the session landed).
    allowFileRoot(result.cwd || body.cwd);
    invalidateSessionListCache();

    return NextResponse.json({ success: true, sessionId: result.sessionId, data: result.data });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: daemonErrorStatus(error) });
  }
}
