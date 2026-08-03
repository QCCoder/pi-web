import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { listRuns } from "@/lib/loop/store";
import { loopErrorResponse } from "@/lib/loop/web";

/** GET run history for a job: ?job=<name>&limit=<n> (newest first). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    const url = new URL(req.url);
    const job = url.searchParams.get("job");
    if (!job) {
      return NextResponse.json({ error: "?job=<name> is required" }, { status: 400 });
    }
    const requested = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 200)
      : 50;
    const runs = await listRuns(path, job, limit);
    return NextResponse.json({ runs });
  } catch (error) {
    return loopErrorResponse(error);
  }
}
