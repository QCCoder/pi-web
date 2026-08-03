import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FeishuClient } from "./client.ts";
import { readFeishuConfig } from "./config.ts";
import type { WorkspaceManifest } from "../workspaces/types.ts";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * feishu-transport module: exposes Feishu outbound tools (send message / card) to
 * the agent. Attached when the workspace has the `feishu-transport` capability.
 * Tools degrade gracefully (clear message) when credentials are not configured.
 */
export function createFeishuTransportExtension(manifest: WorkspaceManifest): InlineExtension {
  return {
    name: "pi-feishu-transport",
    factory: (pi: ExtensionAPI) => {
      async function resolveTarget(override?: string): Promise<{
        client: FeishuClient;
        receiveId: string;
      } | null> {
        const config = await readFeishuConfig(manifest.id);
        if (!config || !config.receiveId) return null;
        return { client: new FeishuClient(config), receiveId: override ?? config.receiveId };
      }

      pi.registerTool({
        name: "feishu_send_message",
        label: "Send Feishu Message",
        description:
          "Send a plain-text message to a Feishu user or chat through the workspace's Feishu app. Use for notifications and quick pushes. Requires Feishu credentials configured for the workspace.",
        promptSnippet: "Send a plain-text message to Feishu",
        parameters: Type.Object({
          text: Type.String({ description: "The message text to send." }),
          receive_id: Type.Optional(
            Type.String({
              description:
                "Override push target (open_id / user_id / chat_id / email). Defaults to the workspace default receive_id.",
            }),
          ),
        }),
        execute: async (_callId, params) => {
          const target = await resolveTarget(params.receive_id as string | undefined);
          if (!target) {
            return textResult(
              "Feishu is not configured for this workspace (missing appId/appSecret or receiveId). Ask the user to configure Feishu in Workspace settings.",
            );
          }
          const result = await target.client.sendText(target.receiveId, params.text as string);
          return textResult(
            result.ok
              ? `Sent Feishu message${result.messageId ? ` (message_id=${result.messageId})` : ""}.`
              : `Feishu send failed: ${result.error}`,
          );
        },
      });

      pi.registerTool({
        name: "feishu_send_card",
        label: "Send Feishu Card",
        description:
          "Send an interactive Feishu card with a title and a markdown body (lark_md supports tables, bold, links). Use for structured digests such as an end-of-day watchlist summary. Requires Feishu credentials configured for the workspace.",
        promptSnippet: "Send a structured Feishu card",
        parameters: Type.Object({
          title: Type.String({ description: "Card title." }),
          markdown: Type.String({
            description: "Card body in feishu lark_md markdown (tables, bold, links).",
          }),
          template: Type.Optional(
            Type.String({
              description:
                "Header color template: blue | turquoise | green | yellow | orange | red | grey. Defaults to blue.",
            }),
          ),
          receive_id: Type.Optional(
            Type.String({ description: "Override push target. Defaults to the workspace default." }),
          ),
        }),
        execute: async (_callId, params) => {
          const target = await resolveTarget(params.receive_id as string | undefined);
          if (!target) {
            return textResult(
              "Feishu is not configured for this workspace (missing appId/appSecret or receiveId). Ask the user to configure Feishu in Workspace settings.",
            );
          }
          const result = await target.client.sendCard(target.receiveId, {
            title: params.title as string,
            markdown: params.markdown as string,
            ...(params.template ? { template: params.template as string } : {}),
          });
          return textResult(
            result.ok
              ? `Sent Feishu card${result.messageId ? ` (message_id=${result.messageId})` : ""}.`
              : `Feishu send failed: ${result.error}`,
          );
        },
      });
    },
  };
}
