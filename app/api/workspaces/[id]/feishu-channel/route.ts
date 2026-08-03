import { NextResponse } from "next/server";
import {
  effectiveCapabilities,
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import {
  getFeishuChannelStatus,
  restartFeishuChannel,
} from "@/lib/feishu-channel/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** GET the feishu-channel status + chat<->session bindings for the workspace. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await getWorkspace(id); // validates the workspace exists (404 otherwise)
    const status = await getFeishuChannelStatus(id);
    return NextResponse.json({ status });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST an action. Currently supports `restart` to stop+start the long-connection
 *  (e.g. after editing Feishu credentials or the event subscription). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    if (!effectiveCapabilities(manifest).includes("feishu-channel")) {
      return NextResponse.json(
        { error: "Workspace does not have the feishu-channel capability" },
        { status: 400 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action === "restart") {
      const status = await restartFeishuChannel(id);
      return NextResponse.json({ status });
    }
    return NextResponse.json(
      { error: "Unknown action; supported: { action: 'restart' }" },
      { status: 400 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
