import { NextResponse } from "next/server";
import {
  getWorkspace,
  removeWorkspace,
  updateWorkspace,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from "@/lib/workspaces/service";
import type { UpdateWorkspaceInput } from "@/lib/workspaces/types";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError
    ? 404
    : error instanceof WorkspaceConflictError
      ? 409
      : error instanceof WorkspaceValidationError
        ? 400
        : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return NextResponse.json(await getWorkspace(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const input = await req.json() as UpdateWorkspaceInput;
    const workspace = await updateWorkspace(id, input);
    // Sync the feishu-channel service when capabilities change: start the
    // long-connection if feishu-channel was just enabled, stop it if removed.
    if (input.capabilities !== undefined) {
      const { ensureFeishuChannelStarted } = await import("@/lib/feishu-channel/manager");
      void ensureFeishuChannelStarted(id).catch((err) => {
        console.error(
          "[feishu-channel] sync after workspace update failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }
    return NextResponse.json({ workspace });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return NextResponse.json(await removeWorkspace(id));
  } catch (error) {
    return errorResponse(error);
  }
}
