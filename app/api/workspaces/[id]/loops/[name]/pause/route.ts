import { NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { collectStatus } from "../../../../../../../pi-loop/status.ts";

/** 写 loops/<name>/PAUSED 标记（web 进程 fs，loops route 先例）。幂等——
 *  已暂停再暂停成功。在跑的轮靠开场合同规则 6（发现 PAUSED 立即收尾）合作收尾。 */
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
    await writeFile(join(declaration.dir, "PAUSED"), "", "utf8");
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
