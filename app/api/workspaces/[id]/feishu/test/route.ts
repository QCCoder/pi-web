import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import { readFeishuConfig } from "@/lib/feishu/config";
import { FeishuClient } from "@/lib/feishu/client";
import type { FeishuReceiveIdType } from "@/lib/feishu/types";

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

/** POST a test message through the workspace's Feishu app. Verifies the
 *  configured credentials end-to-end without involving the agent. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const config = await readFeishuConfig(manifest.id);
    if (!config) {
      return NextResponse.json(
        { error: "Feishu is not configured for this workspace" },
        { status: 400 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as {
      message?: string;
      receiveId?: string;
      receiveIdType?: string;
    };

    const receiveId = (body.receiveId ?? config.receiveId).trim();
    if (!receiveId) {
      return NextResponse.json(
        { error: "No receiveId configured or provided" },
        { status: 400 },
      );
    }
    const receiveIdType =
      body.receiveIdType && VALID_RECEIVE_ID_TYPES.includes(body.receiveIdType as FeishuReceiveIdType)
        ? (body.receiveIdType as FeishuReceiveIdType)
        : config.receiveIdType;

    const text =
      body.message?.trim()
      || `Pi Web 飞书推送测试 ✅\n来自工作区「${manifest.name}」\n时间 ${new Date().toISOString()}`;

    const client = new FeishuClient({ ...config, receiveIdType });
    const result = await client.sendText(receiveId, text, receiveIdType);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Feishu send failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (error) {
    return errorResponse(error);
  }
}
