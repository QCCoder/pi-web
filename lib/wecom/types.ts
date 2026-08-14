/** WeCom (企业微信) notify result — mirrors the Feishu send-result shape so the
 *  two Notifiers report outcomes uniformly to the dispatcher. */
export interface WeComSendResult {
  ok: boolean;
  error?: string;
}
