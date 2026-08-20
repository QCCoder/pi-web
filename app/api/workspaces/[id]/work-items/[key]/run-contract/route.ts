import { NextResponse } from "next/server";
import { loopHostClient } from "@/lib/loop/client";
import { DaemonHttpError } from "@/lib/loop/client";

/**
 * dev-loop v3 seeding entry for the work-item 「按合同执行」 button.
 * Forwards to the daemon's deterministic seeder (guard + `/skill:<loopId>`
 * prompt + conversations/milestone bookkeeping) — the exact same code path a
 * cron selection round takes after `LOOP_SEED: <KEY>`, so both entry points
 * stay byte-identical (design §5).
 *
 * 200 `{ seeded, sessionId?, reason }` — `seeded:false` is a guard refusal
 * (double-open protection), not an error; the UI surfaces `reason`.
 * 404 unknown work item, 503 daemon unavailable.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const input = await req.json().catch(() => ({})) as { mode?: string };
    const mode = input.mode === "adopt" ? "adopt" : "execute";
    const { seed } = await loopHostClient.seedExecution(id, key, mode);
    return NextResponse.json(seed);
  } catch (error) {
    if (error instanceof DaemonHttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "seeding failed" },
      { status: 503 },
    );
  }
}
