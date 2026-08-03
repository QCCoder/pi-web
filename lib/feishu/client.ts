import type { FeishuConfig, FeishuReceiveIdType, FeishuSendResult } from "./types.ts";

const FEISHU_BASE_URL = "https://open.feishu.cn";

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Tenant access tokens are app-scoped; key by appId so workspaces sharing an app
// reuse the token. Refreshed ~1 min before expiry.
const tokenCache = new Map<string, CachedToken>();

/** Minimal Feishu Open API client: tenant access token management + outbound
 *  messaging. Only the outbound surface pi-web needs (push digests, reply to DMs).
 *  Inbound (long-connection event receiving) lives in the feishu-channel module. */
export class FeishuClient {
  constructor(private readonly config: FeishuConfig) {}

  private async getTenantAccessToken(): Promise<string> {
    const cached = tokenCache.get(this.config.appId);
    const now = Date.now();
    if (cached && cached.expiresAt - 60_000 > now) return cached.token;

    const res = await fetch(
      `${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (!data.tenant_access_token) {
      throw new Error(
        `Feishu tenant_access_token request failed: ${data.msg ?? res.statusText}`,
      );
    }
    const expireSeconds = typeof data.expire === "number" ? data.expire : 7200;
    tokenCache.set(this.config.appId, {
      token: data.tenant_access_token,
      expiresAt: now + expireSeconds * 1000,
    });
    return data.tenant_access_token;
  }

  /**
   * Low-level send. `content` is the JSON string feishu expects for the given
   * msg_type (text -> {"text":"..."}, interactive -> card object as a string).
   */
  async sendMessage(params: {
    receiveId: string;
    msgType: string;
    content: string;
    receiveIdType?: FeishuReceiveIdType;
  }): Promise<FeishuSendResult> {
    try {
      const token = await this.getTenantAccessToken();
      const receiveIdType = params.receiveIdType ?? this.config.receiveIdType;
      const res = await fetch(
        `${FEISHU_BASE_URL}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            receive_id: params.receiveId,
            msg_type: params.msgType,
            content: params.content,
          }),
        },
      );
      const data = (await res.json()) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (data.code !== 0) {
        return {
          ok: false,
          error: `Feishu send failed (code ${data.code}): ${data.msg ?? res.statusText}`,
        };
      }
      return { ok: true, messageId: data.data?.message_id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Send a plain-text message. */
  sendText(receiveId: string, text: string, receiveIdType?: FeishuReceiveIdType) {
    return this.sendMessage({
      receiveId,
      msgType: "text",
      content: JSON.stringify({ text }),
      receiveIdType,
    });
  }

  /** Send an interactive card: a colored header + a single lark_md body block. */
  sendCard(
    receiveId: string,
    card: { title: string; markdown: string; template?: string },
    receiveIdType?: FeishuReceiveIdType,
  ) {
    const feishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: card.title },
        template: card.template ?? "blue",
      },
      elements: [{ tag: "div", text: { tag: "lark_md", content: card.markdown } }],
    };
    return this.sendMessage({
      receiveId,
      msgType: "interactive",
      content: JSON.stringify(feishuCard),
      receiveIdType,
    });
  }
}
