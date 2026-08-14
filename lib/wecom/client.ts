/** Minimal WeCom (企业微信) group-bot webhook client.
 *
 *  The group-bot webhook is the simplest outbound surface WeCom offers: a single
 *  URL (`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`) that accepts
 *  a JSON `{msgtype, markdown|text}` body. No app registration, no corpid/secret,
 *  no access-token management — which is why it is the recommended channel for
 *  dev-loop notifications (the richer "application message" API is a later option;
 *  it would be a second client, not a change here).
 *
 *  `fetch` is injectable so the dispatcher/client stays unit-testable without
 *  network I/O. */

import type { WeComSendResult } from "./types.ts";

export class WeComClient {
  constructor(
    private readonly webhook: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Send a Markdown message. WeCom markdown supports a subset (bold, line breaks,
   *  lists) — enough for the shared `renderNotifyBody` output. */
  sendMarkdown(content: string): Promise<WeComSendResult> {
    return this.send({ msgtype: "markdown", markdown: { content } });
  }

  /** Send a plain-text message. */
  sendText(content: string): Promise<WeComSendResult> {
    return this.send({ msgtype: "text", text: { content } });
  }

  private async send(payload: Record<string, unknown>): Promise<WeComSendResult> {
    try {
      const res = await this.fetchImpl(this.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { errcode?: number; errmsg?: string };
      if (data.errcode !== 0) {
        return {
          ok: false,
          error: `WeCom send failed (errcode ${data.errcode}): ${data.errmsg ?? res.statusText}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
