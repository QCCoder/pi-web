import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { isSubagentChildSession } from "@/lib/subagent-child";
import { searchSessionContents } from "@/lib/session-search";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the same catalog used by the sidebar.
    const sessions = query && !request.signal.aborted ? await listAllSessions() : [];
    // 侧栏树隐藏 subagent 子会话——搜索目录与可见会话列表保持一致。
    const visible = sessions.filter((session) => !isSubagentChildSession(session));
    return NextResponse.json(await searchSessionContents(visible, query, request.signal), { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
