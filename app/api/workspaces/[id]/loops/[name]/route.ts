import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { applyLoopFrontmatterPatch, LoopFrontmatterError } from "../../../../../../pi-loop/frontmatter.ts";
import { collectStatus } from "../../../../../../pi-loop/status.ts";
import { deleteLoop, LoopManageError } from "@/lib/loops/manage";

const EDITABLE = new Set(["cron", "timezone", "level", "max_minutes"]);

function errorResponse(error: unknown): NextResponse {
  if (error instanceof LoopManageError) {
    return NextResponse.json(
      { error: error.message, ...error.details },
      { status: error.status },
    );
  }
  const status = error instanceof WorkspaceNotFoundError ? 404
    : error instanceof LoopFrontmatterError ? 400
    : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** Frontmatter round-trip 编辑（S5「人的手」）：只接受 cron/timezone/level/
 *  max_minutes 四字段；frontmatter 重序列化、正文 byte 保留（纯逻辑在
 *  pi-loop/frontmatter.ts）。cron 编辑后下一心跳自然生效（宿主每 tick 重读
 *  文件）；.lastrun 保留，next-due 按新 cron 重算。 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((key) => !EDITABLE.has(key));
    if (unknownKeys.length > 0) {
      return NextResponse.json(
        { error: `不可编辑的字段（仅 cron/timezone/level/max_minutes）：${unknownKeys.join(", ")}` },
        { status: 400 },
      );
    }
    if (body.cron !== undefined && typeof body.cron !== "string") {
      return NextResponse.json({ error: "cron must be a string" }, { status: 400 });
    }
    if (body.timezone !== undefined && typeof body.timezone !== "string") {
      return NextResponse.json({ error: "timezone must be a string" }, { status: 400 });
    }
    if (body.level !== undefined && !(["L1", "L2", "L3"] as const).includes(body.level as "L1")) {
      return NextResponse.json({ error: "level 只能是 L1/L2/L3" }, { status: 400 });
    }
    if (body.max_minutes !== undefined
      && (typeof body.max_minutes !== "number" || !Number.isInteger(body.max_minutes))) {
      return NextResponse.json({ error: "max_minutes must be an integer" }, { status: 400 });
    }
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ error: "至少提供一个字段（cron/timezone/level/max_minutes）" }, { status: 400 });
    }
    const patch = {
      ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
      ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
      ...(typeof body.level === "string" ? { level: body.level as "L1" | "L2" | "L3" } : {}),
      ...(typeof body.max_minutes === "number" ? { max_minutes: body.max_minutes } : {}),
    };
    const loopMdPath = join(declaration.dir, "LOOP.md");
    const raw = readFileSync(loopMdPath, "utf8");
    const next = applyLoopFrontmatterPatch(raw, patch);
    // tmp+rename 原子写（先例：writeLastrun / session-index）
    const tmp = `${loopMdPath}.tmp-${process.pid}`;
    await writeFile(tmp, next, "utf8");
    await rename(tmp, loopMdPath);
    return NextResponse.json({
      loop: collectStatus(workspacePath).find((entry) => entry.name === declaration.loopName),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 删除 loop（spec §5.3）：锁活 409；有绑定工作项需 {confirmBound:true} 二次确认；
 *  整目录删除（git 历史即审计），SKILL 与根宪法不动。 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const body = (await req.json().catch(() => ({}))) as { confirmBound?: boolean };
    return NextResponse.json(await deleteLoop(path, name, { confirmBound: body.confirmBound }));
  } catch (error) {
    return errorResponse(error);
  }
}
