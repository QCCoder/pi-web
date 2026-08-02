import { NextResponse } from "next/server";
import { restoreSession, SessionArchiveError } from "@/lib/session-archive";

// POST /api/sessions/[id]/restore — move an archived session back to its
// project's session directory.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json(await restoreSession(id));
  } catch (error) {
    if (error instanceof SessionArchiveError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
