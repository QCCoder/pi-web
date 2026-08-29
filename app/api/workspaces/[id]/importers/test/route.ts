import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import { readImporterConfig } from "@/lib/work-items/importers/config";
import { ChandaoImporter } from "@/lib/work-items/importers/chandao-importer";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** POST a test connection: reads the stored Chandao credentials and runs
 *  listAssigned end-to-end (token sign-in + list bugs/tasks), returning counts
 *  and a sample. Verifies the credentials work without involving the agent. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const config = await readImporterConfig(manifest.id);
    if (!config?.chandao) {
      return NextResponse.json(
        { error: "Chandao importer is not configured for this workspace" },
        { status: 400 },
      );
    }
    const importer = new ChandaoImporter(config.chandao);
    const items = await importer.listAssigned();
    const bugs = items.filter((item) => item.kind === "bug");
    const tasks = items.filter((item) => item.kind === "task");
    return NextResponse.json({
      ok: true,
      counts: { bugs: bugs.length, tasks: tasks.length },
      sample: items.slice(0, 5).map((item) => ({
        sourceId: item.sourceId,
        kind: item.kind,
        title: item.title,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
