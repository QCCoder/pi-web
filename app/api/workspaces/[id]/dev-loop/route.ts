import { NextResponse } from "next/server";
import { createDevLoopDefinition, ensureDevLoopDefinition } from "@/lib/loop/dev-loop/install";
import { readLoopDefinition } from "@/lib/loop/store";
import { LoopConflictError, LoopNotFoundError } from "@/lib/loop/store";
import { effectiveCapabilities, getWorkspace } from "@/lib/workspaces/service";

/** GET — whether the dev Loop exists for this workspace (and its definition). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path, manifest } = await getWorkspace(id);
    const definition = await readLoopDefinition(
      { id: manifest.id, name: manifest.name, path },
      "dev-loop",
    );
    return NextResponse.json({ exists: true, definition });
  } catch (error) {
    if (error instanceof LoopNotFoundError) {
      return NextResponse.json({ exists: false });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST — create the dev Loop definition. Body `{ ensure?: boolean }`:
 *  - ensure=true (default) -> idempotent create-or-return-existing.
 *  - ensure=false -> throw 409 if it already exists. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path, manifest } = await getWorkspace(id);
    if (!effectiveCapabilities(manifest).includes("loop")) {
      return NextResponse.json({ error: "loop capability is not enabled" }, { status: 409 });
    }
    const workspace = { id: manifest.id, name: manifest.name, path };
    const body = await request.json().catch(() => ({})) as { ensure?: boolean };
    const ensure = body.ensure !== false;
    const definition = ensure
      ? (await ensureDevLoopDefinition(workspace)).definition
      : await createDevLoopDefinition(workspace);
    return NextResponse.json({ definition }, { status: ensure ? 200 : 201 });
  } catch (error) {
    const status = error instanceof LoopConflictError ? 409 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
