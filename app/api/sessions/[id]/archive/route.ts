import { NextResponse } from "next/server";
import { archiveSession, SessionArchiveError } from "@/lib/session-archive";

// POST /api/sessions/[id]/archive — move the session into its project's
// `.archived/` subdirectory (hides it from the active list; reversible).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json(await archiveSession(id));
  } catch (error) {
    if (error instanceof SessionArchiveError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
