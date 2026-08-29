import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { deleteLoopDefinition, updateLoopDefinition, type UpdateLoopInput } from "@/lib/loop/authoring";
import { readLoopDefinition } from "@/lib/loop/store";
import { loopErrorResponse } from "@/lib/loop/web";
import { getWorkspace } from "@/lib/workspaces/service";

/** Legacy check: the `loop` workspace capability is retired (read-path strip —
 *  see LEGACY_READ_CAPABILITIES in lib/workspaces/service.ts), so parsed
 *  manifests can never carry it and this gate now always refuses. The whole v3
 *  loop route tree is deleted in kit-teardown Task 5. */
function loopCapabilityMissing(manifest: { capabilities: string[] }): boolean {
  return !manifest.capabilities.includes("loop");
}

type Params = { params: Promise<{ id: string; loopId: string }> };

/** GET single loop + raw LOOP.md text (for the edit dialog). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id, loopId } = await params;
    const { path, manifest } = await getWorkspace(id);
    if (loopCapabilityMissing(manifest)) {
      return NextResponse.json({ error: "loop capability is not enabled" }, { status: 409 });
    }
    const loop = await readLoopDefinition({ id: manifest.id, name: manifest.name, path }, loopId);
    const instructions = await readFile(loop.instructionsPath, "utf8");
    const agents: Record<string, string> = {};
    try {
      const agentsDir = join(loop.directory, "agents");
      for (const name of await readdir(agentsDir)) {
        if (name.endsWith(".md")) agents[name] = await readFile(join(agentsDir, name), "utf8");
      }
    } catch {
      // 无 agents 目录则返回空映射
    }
    return NextResponse.json({ loop, instructions, agents });
  } catch (error) {
    return loopErrorResponse(error);
  }
}

/** PATCH — surgical update of loop.yaml (and optionally LOOP.md). */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id, loopId } = await params;
    const { path, manifest } = await getWorkspace(id);
    if (loopCapabilityMissing(manifest)) {
      return NextResponse.json({ error: "loop capability is not enabled" }, { status: 409 });
    }
    const loop = await updateLoopDefinition(
      { id: manifest.id, name: manifest.name, path },
      loopId,
      await request.json() as UpdateLoopInput,
    );
    return NextResponse.json({ loop });
  } catch (error) {
    return loopErrorResponse(error);
  }
}

/** DELETE — remove the whole loop directory. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id, loopId } = await params;
    const { path, manifest } = await getWorkspace(id);
    if (loopCapabilityMissing(manifest)) {
      return NextResponse.json({ error: "loop capability is not enabled" }, { status: 409 });
    }
    await deleteLoopDefinition({ id: manifest.id, name: manifest.name, path }, loopId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return loopErrorResponse(error);
  }
}
