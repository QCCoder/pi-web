import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import {
  createWorkspace,
  discoverWorkspaces,
  getWorkspaceRoot,
  listWorkspaceTemplates,
  WorkspaceConflictError,
  WorkspaceValidationError,
} from "@/lib/workspaces/service";
import type { CreateWorkspaceInput } from "@/lib/workspaces/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const root = getWorkspaceRoot();
    const workspaces = await discoverWorkspaces(root);
    for (const workspace of workspaces) allowFileRoot(workspace.path);
    return NextResponse.json({
      root,
      workspaces,
      templates: listWorkspaceTemplates(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const input = await req.json() as CreateWorkspaceInput;
    const workspace = await createWorkspace(input);
    allowFileRoot(workspace.path);
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    const status = error instanceof WorkspaceConflictError
      ? 409
      : error instanceof WorkspaceValidationError
        ? 400
        : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
