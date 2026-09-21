import { NextResponse } from "next/server";
import { daemonClient, DaemonHttpError } from "@/lib/daemon/client";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { run } = await daemonClient.getSubagentRun(id);
    return NextResponse.json({ run });
  } catch (error) {
    if (error instanceof DaemonHttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req) || !hasJsonContentType(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = await req.json() as { action?: unknown; message?: unknown };
    if (body.action === "steer") {
      if (typeof body.message !== "string" || !body.message.trim()) {
        return NextResponse.json({ error: "message required" }, { status: 400 });
      }
      await daemonClient.controlSubagent(id, "steer", body.message);
    } else if (body.action === "abort") {
      await daemonClient.controlSubagent(id, "abort");
    } else {
      return NextResponse.json({ error: "action must be steer or abort" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, run: (await daemonClient.getSubagentRun(id)).run });
  } catch (error) {
    if (error instanceof DaemonHttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("not running") ? 409 : 500 });
  }
}
