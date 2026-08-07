import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { deleteLoopDefinition, updateLoopDefinition, type UpdateLoopInput } from "@/lib/loop/authoring";
import { readLoopDefinition } from "@/lib/loop/store";
import { loopErrorResponse } from "@/lib/loop/web";
import { effectiveCapabilities, getWorkspace } from "@/lib/workspaces/service";

type Params = { params: Promise<{ id: string; loopId: string }> };

/** GET single loop + raw LOOP.md text (for the edit dialog). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id, loopId } = await params;
    const { path, manifest } = await getWorkspace(id);
    if (!effectiveCapabilities(manifest).includes("loop")) {
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
    if (!effectiveCapabilities(manifest).includes("loop")) {
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
    if (!effectiveCapabilities(manifest).includes("loop")) {
      return NextResponse.json({ error: "loop capability is not enabled" }, { status: 409 });
    }
    await deleteLoopDefinition({ id: manifest.id, name: manifest.name, path }, loopId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return loopErrorResponse(error);
  }
}
