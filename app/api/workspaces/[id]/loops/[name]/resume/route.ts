import { NextResponse } from "next/server";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { collectStatus } from "../../../../../../../pi-loop/status.ts";

/** 删 PAUSED 标记，幂等——未暂停时 resume 也成功。 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    await rm(join(declaration.dir, "PAUSED"), { force: true });
    return NextResponse.json({
      loop: collectStatus(workspacePath).find((entry) => entry.name === declaration.loopName),
    });
  } catch (error) {
    const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
