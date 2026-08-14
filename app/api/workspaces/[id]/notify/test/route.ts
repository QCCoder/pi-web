import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import { readFeishuConfig } from "@/lib/feishu/config";
import { FeishuClient } from "@/lib/feishu/client";
import { readNotifyConfig } from "@/lib/notify/config";
import { WeComClient } from "@/lib/wecom/client";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

type TestChannel = "feishu" | "wecom";

/** POST a test message through one configured channel to verify the credentials
 *  end-to-end without involving the agent or the work-item event pipeline. Body:
 *  `{ channel: "feishu" | "wecom", message?: string }`. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const body = (await req.json().catch(() => ({}))) as {
      channel?: string;
      message?: string;
    };
    const channel: TestChannel = body.channel === "wecom" ? "wecom" : "feishu";
    const message = body.message?.trim() || "Pi Web 通知渠道测试 ✅";

    if (channel === "feishu") {
      const config = await readFeishuConfig(manifest.id);
      if (!config || !config.receiveId) {
        return NextResponse.json(
          { error: "飞书尚未配置（缺少 appId/appSecret/receiveId）" },
          { status: 400 },
        );
      }
      const client = new FeishuClient(config);
      const result = await client.sendCard(config.receiveId, {
        title: "Pi Web · 渠道测试",
        markdown: `**飞书测试**\n\n${message}`,
        template: "blue",
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error ?? "send failed" }, { status: 502 });
      }
      return NextResponse.json({ ok: true, channel: "feishu" });
    }

    // wecom
    const notify = await readNotifyConfig(manifest.id);
    const wecom = notify.channels.find((c) => c.kind === "wecom");
    if (!wecom?.enabled || !wecom.webhook) {
      return NextResponse.json(
        { error: "企业微信尚未配置（未启用或缺少 webhook）" },
        { status: 400 },
      );
    }
    const client = new WeComClient(wecom.webhook);
    const result = await client.sendMarkdown(`**企业微信测试**\n\n${message}`);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "send failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, channel: "wecom" });
  } catch (error) {
    return errorResponse(error);
  }
}
