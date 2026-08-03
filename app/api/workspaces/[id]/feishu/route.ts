import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import {
  readFeishuConfig,
  writeFeishuConfig,
  toPublicConfig,
} from "@/lib/feishu/config";
import type { FeishuConfig, FeishuReceiveIdType } from "@/lib/feishu/types";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

const VALID_RECEIVE_ID_TYPES: FeishuReceiveIdType[] = [
  "open_id",
  "user_id",
  "chat_id",
  "email",
];

/** GET the workspace Feishu config (secret masked). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const config = await readFeishuConfig(manifest.id);
    return NextResponse.json({ config: toPublicConfig(config) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PUT (create or update) the workspace Feishu config. An empty appSecret keeps
 *  the previously stored secret, so the UI can update other fields without
 *  re-entering the secret each time. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const body = (await req.json()) as {
      appId?: string;
      appSecret?: string;
      receiveIdType?: string;
      receiveId?: string;
    };

    const existing = await readFeishuConfig(manifest.id);
    const receiveIdType =
      body.receiveIdType &&
      VALID_RECEIVE_ID_TYPES.includes(body.receiveIdType as FeishuReceiveIdType)
        ? (body.receiveIdType as FeishuReceiveIdType)
        : (existing?.receiveIdType ?? "open_id");

    const config: FeishuConfig = {
      appId: (body.appId ?? existing?.appId ?? "").trim(),
      appSecret: (body.appSecret && body.appSecret.trim()) || existing?.appSecret || "",
      receiveIdType,
      receiveId: (body.receiveId ?? existing?.receiveId ?? "").trim(),
    };

    if (!config.appId || !config.appSecret || !config.receiveId) {
      return NextResponse.json(
        { error: "appId, appSecret and receiveId are all required" },
        { status: 400 },
      );
    }

    await writeFeishuConfig(manifest.id, config);
    // The feishu-channel inbound service reuses these same credentials; restart
    // it so the long-connection picks up the new appId/appSecret immediately.
    // (No-op if the workspace lacks the feishu-channel capability.)
    const { restartFeishuChannel } = await import("@/lib/feishu-channel/manager");
    void restartFeishuChannel(manifest.id).catch((err) => {
      console.error(
        "[feishu-channel] restart after credential update failed:",
        err instanceof Error ? err.message : err,
      );
    });
    return NextResponse.json({ config: toPublicConfig(config) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE clears the stored Feishu config for the workspace. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    await writeFeishuConfig(manifest.id, {
      appId: "",
      appSecret: "",
      receiveIdType: "open_id",
      receiveId: "",
    });
    // Credentials removed: stop the inbound channel if it was running.
    const { ensureFeishuChannelStarted } = await import("@/lib/feishu-channel/manager");
    void ensureFeishuChannelStarted(manifest.id).catch(() => {
      /* best-effort; credentials are gone either way */
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
