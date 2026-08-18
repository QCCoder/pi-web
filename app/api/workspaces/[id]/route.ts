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
