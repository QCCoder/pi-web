import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildEarlierContext, resolveSessionPath } from "@/lib/session-reader";
import { jsonResponse } from "@/lib/json-response";

/** Older-messages window for tail-first session loading (L3).
 *  GET /api/sessions/[id]/earlier?before=<entryId>&limit=100&leafId=<id>
 *  Returns up to `limit` messages immediately before `before` on the same
 *  branch, chronological order, plus `hasEarlier` for the next page. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const before = url.searchParams.get("before");
  if (!before) {
    return NextResponse.json({ error: "before is required" }, { status: 400 });
  }
  const leafId = url.searchParams.get("leafId");
  const limitParam = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isSafeInteger(limitParam) && limitParam > 0 ? limitParam : 100;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = SessionManager.open(filePath);
    // `buildContextEntries` needs an explicit leaf — null yields an empty branch.
    // Default to the session's current leaf when the client didn't pin one.
    const context = buildEarlierContext(sm.getEntries() as never, before, {
      leafId: leafId ?? sm.getLeafId() ?? undefined,
      limit,
      deferThinking,
      deferToolResultImages,
    });
    if (!context) {
      // Anchor not on this branch (compaction/branch switch raced) — treat as
      // exhausted rather than erroring; the client simply stops loading.
      return NextResponse.json({
        context: { messages: [], entryIds: [], thinkingLevel: "", model: null, hasEarlier: false },
      });
    }

    return jsonResponse(req, { context });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
// bump 1787327881060888000
