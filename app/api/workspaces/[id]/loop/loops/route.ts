import { NextResponse } from "next/server";
import { daemonClient } from "@/lib/daemon/client";
import { createLoopDefinition, type CreateLoopInput } from "@/lib/loop/authoring";
import { LoopConflictError, LoopValidationError } from "@/lib/loop/store";
import { getWorkspace } from "@/lib/workspaces/service";

/** Legacy check: the `loop` workspace capability is retired (read-path strip —
 *  see LEGACY_READ_CAPABILITIES in lib/workspaces/service.ts), so parsed
 *  manifests can never carry it and this gate now always refuses. The whole v3
 *  loop route tree is deleted in kit-teardown Task 5. */
function loopCapabilityMissing(manifest: { capabilities: string[] }): boolean {
  return !manifest.capabilities.includes("loop");
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await daemonClient.listLoops(id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { path, manifest } = await getWorkspace(id);
    if (loopCapabilityMissing(manifest)) {
      return NextResponse.json({ error: "loop capability is not enabled" }, { status: 409 });
    }
    const loop = await createLoopDefinition(
      { id: manifest.id, name: manifest.name, path },
      await request.json() as CreateLoopInput,
    );
    return NextResponse.json({ loop }, { status: 201 });
  } catch (error) {
    const status = error instanceof LoopValidationError
      ? 400
      : error instanceof LoopConflictError
        ? 409
        : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
