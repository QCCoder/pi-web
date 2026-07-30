import { NextResponse } from "next/server";
import {
  addWorkspaceRepository,
  listWorkspaceRepositories,
  removeWorkspaceRepository,
  restoreWorkspaceRepository,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from "@/lib/workspaces/service";
import type { AddWorkspaceRepositoryInput } from "@/lib/workspaces/types";

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
    return NextResponse.json({ repositories: await listWorkspaceRepositories(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const input = await req.json() as AddWorkspaceRepositoryInput;
    return NextResponse.json(
      { repository: await addWorkspaceRepository(id, input) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const repositoryId = url.searchParams.get("repositoryId");
    if (!repositoryId) throw new WorkspaceValidationError("repositoryId is required");
    return NextResponse.json(
      await removeWorkspaceRepository(id, repositoryId),
    );
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
    const input = await req.json() as { repositoryId?: string; action?: string };
    if (!input.repositoryId) throw new WorkspaceValidationError("repositoryId is required");
    if (input.action !== "restore") {
      throw new WorkspaceValidationError("action must be restore");
    }
    return NextResponse.json(
      await restoreWorkspaceRepository(id, input.repositoryId),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
