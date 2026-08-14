import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import {
  defaultNotifyConfig,
  mergeNotifyConfig,
  readNotifyConfig,
  toPublicNotifyConfig,
  writeNotifyConfig,
  deleteNotifyConfig,
} from "@/lib/notify/config";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** GET the workspace notify config (webhook key masked). Returns the default
 *  config (failover, feishu on, wecom off) when none is stored, so the UI always
 *  has a complete channel list to render. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const config = await readNotifyConfig(manifest.id);
    return NextResponse.json({ config: toPublicNotifyConfig(config) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PUT (create or update) the workspace notify config. The body is a partial
 *  patch merged onto the stored config: mode + a channels[] of {kind, enabled?,
 *  priority?, webhook?}. Fields omitted are preserved; an absent/empty `webhook`
 *  keeps the stored value (the UI only ever holds the masked form), a non-empty
 *  one replaces it — mirroring the Feishu appSecret rule. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const body = await req.json().catch(() => ({}));
    const existing = await readNotifyConfig(manifest.id);
    const merged = mergeNotifyConfig(existing, body);
    await writeNotifyConfig(manifest.id, merged);
    return NextResponse.json({ config: toPublicNotifyConfig(merged) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE resets the workspace notify config to the default (failover, feishu on,
 *  wecom off). We reset rather than wipe so the Exporter scheduler always has a
 *  usable config and existing Feishu-only behavior is preserved. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    await deleteNotifyConfig(manifest.id);
    const reset = defaultNotifyConfig();
    return NextResponse.json({ config: toPublicNotifyConfig(reset) });
  } catch (error) {
    return errorResponse(error);
  }
}
