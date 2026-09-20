import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// 会话全文搜索的跨窗口同步轮询端点。上游把 sessionListVersion 夹在
// /api/agent/running 的轻量轮询里；本地的 running 通道已是 daemon SSE 纯代理
// （无法夹带 web 侧状态），等价物是只读缓存代数的独立轻量端点。
export async function GET() {
  return NextResponse.json(
    { sessionListVersion: getSessionListVersion() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
