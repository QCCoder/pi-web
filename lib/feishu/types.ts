/** feishu-transport module types. */

export type FeishuReceiveIdType = "open_id" | "user_id" | "chat_id" | "email";

/** Per-workspace Feishu app configuration + default push target. Stored outside
 *  the workspace directory (under the global pi agent dir) because appSecret is
 *  sensitive and workspace dirs are frequently git repos. */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  receiveIdType: FeishuReceiveIdType;
  /** Default push target (open_id / user_id / chat_id / email) for this workspace. */
  receiveId: string;
}

/** Config shape returned to the client / UI — secret never leaves the server. */
export interface FeishuConfigPublic {
  appId: string;
  hasAppSecret: boolean;
  receiveIdType: FeishuReceiveIdType;
  receiveId: string;
}

export interface FeishuSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}
