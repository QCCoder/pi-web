/** feishu-channel module types — inbound bot chat over the Feishu long-connection.
 *
 *  Per the locked design (docs/stock-workspace-modules.md):
 *    1 Feishu app <-> 1 workspace; DM (p2p) only; 1 chat <-> 1 long-lived pi
 *    session (compaction handles growth); `/new` starts a fresh session.
 *  pi-web is the SINGLE session owner — the channel never spawns its own
 *  AgentSession; it reuses rpc-manager. */

/** A decoded inbound 1:1 DM event received over the long-connection. */
export interface FeishuInboundDm {
  /** Feishu message id ("om_..."). Used as the dedup key — Feishu may redeliver. */
  messageId: string;
  /** Feishu chat id ("oc_..."). Stable per (user × app) for p2p chats; the binding key. */
  chatId: string;
  /** "p2p" (the only type the channel routes) | "group". */
  chatType: string;
  /** Feishu message type ("text" | "post" | "image" | ...). */
  messageType: string;
  /** Decoded plain text for text-type messages; "" for non-text. */
  text: string;
  /** Sender open_id ("ou_..."). */
  senderOpenId: string;
  /** Raw JSON-encoded content string (Feishu's original `content` field). */
  rawContent: string;
  /** Epoch-ms string from Feishu `create_time`. */
  createTime: string;
}

/** A chat<->session binding: one Feishu p2p chat mapped to one long-lived pi
 *  session. Persisted per workspace under the global pi agent dir. */
export interface ChatSessionBinding {
  chatId: string;
  /** pi session id. */
  sessionId: string;
  /** Absolute path to the pi session .jsonl file. Required so the channel can
   *  reopen the session via startRpcSession after rpc-manager's idle teardown. */
  sessionFile: string;
  /** Last known sender open_id for this chat (display only). */
  senderOpenId?: string;
  createdAt: string;
  updatedAt: string;
  /** Epoch-ms ISO string of the last inbound message routed through this binding. */
  lastMessageAt?: string;
}

/** Long-connection lifecycle state surfaced to the API / config UI. */
export type FeishuChannelState =
  | "disabled" // workspace lacks the capability or has no Feishu credentials
  | "stopped" // capability present, not started (or explicitly stopped)
  | "connecting" // endpoint lookup / WS handshake in progress
  | "connected" // WS open; receiving events
  | "reconnecting" // dropped; backing off before retry
  | "error"; // unrecoverable (bad credentials, fatal server code)

/** Status snapshot returned by the feishu-channel API and shown in the UI. */
export interface FeishuChannelStatus {
  state: FeishuChannelState;
  /** Whether the workspace has the capability AND credentials configured. */
  enabled: boolean;
  appId?: string;
  hasAppSecret: boolean;
  message?: string;
  connectedAt?: string;
  lastEventAt?: string;
  bindings: ChatSessionBinding[];
}
