import type { FeishuChannelState, FeishuInboundDm } from "./types.ts";
import { decodeFrame, encodeFrame, type PbFrame } from "./proto.ts";

/**
 * Feishu long-connection (WebSocket) event client.
 *
 * Connects to the Feishu 长连接 endpoint, exchanges protobuf `pbbp2.Frame`
 * messages (see proto.ts), maintains the heartbeat, reassembles split events,
 * ACKs each event within the platform's 3-second deadline, and decodes
 * `im.message.receive_v1` DMs into {@link FeishuInboundDm} for the router.
 *
 * Zero third-party deps: uses the built-in global `WebSocket` (Node ≥ 22) and
 * `fetch`. The signed `wss://` URL returned by /callback/ws/endpoint is the
 * credential — no extra handshake headers, no IP allowlist (the socket is
 * outbound). Reconnects with jitter on drop.
 */

const FEISHU_DEFAULT_BASE = "https://open.feishu.cn";

// protobuf Frame.method values
const METHOD_CONTROL = 0;
const METHOD_DATA = 1;

// header keys / values (Feishu long-connection contract)
const H_TYPE = "type";
const H_MESSAGE_ID = "message_id";
const H_SUM = "sum";
const H_SEQ = "seq";
const H_BIZ_RT = "biz_rt";
const T_EVENT = "event";
const T_PING = "ping";
const T_PONG = "pong";

const EVENT_MESSAGE_RECEIVE = "im.message.receive_v1";
const ACK_CODE_OK = 200;

interface EndpointInfo {
  url: string;
  serviceId: number;
  pingIntervalMs: number;
  reconnectIntervalMs: number;
  reconnectNonceMs: number;
  reconnectCount: number; // -1 = infinite
}

interface FragmentBucket {
  sum: number;
  pieces: (Uint8Array | undefined)[];
}

export interface LongConnectionLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface LongConnectionCallbacks {
  /** Decoded 1:1 DM. Invoked after the ACK is already sent; may run slowly. */
  onDm: (dm: FeishuInboundDm) => void | Promise<void>;
  onStateChange: (state: FeishuChannelState) => void;
}

const noLogger: LongConnectionLogger = {
  info() {},
  warn() {},
  error() {},
};

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class FeishuLongConnection {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private endpoint: EndpointInfo | null = null;
  private reconnectAttempts = 0;
  private connectedAt: string | null = null;
  private lastEventAt: string | null = null;
  private readonly fragments = new Map<string, FragmentBucket>();

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly callbacks: LongConnectionCallbacks,
    private readonly base: string = FEISHU_DEFAULT_BASE,
    private readonly logger: LongConnectionLogger = noLogger,
  ) {}

  get connectedAtIso(): string | null {
    return this.connectedAt;
  }
  get lastEventAtIso(): string | null {
    return this.lastEventAt;
  }

  /** Start the long-connection. Idempotent. Resolves once the dial is attempted;
   *  ongoing connect/reconnect happens in the background. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /** Stop and tear down. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.emitState("stopped");
  }

  // --- connection lifecycle ------------------------------------------------

  private emitState(state: FeishuChannelState): void {
    try {
      this.callbacks.onStateChange(state);
    } catch (err) {
      this.logger.warn(`onStateChange threw: ${msg(err)}`);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.emitState(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");
    try {
      this.endpoint = await this.fetchEndpoint();
    } catch (err) {
      this.logger.error(`feishu endpoint lookup failed: ${msg(err)}`);
      this.emitState("error");
      this.scheduleReconnect();
      return;
    }
    this.openSocket();
  }

  private async fetchEndpoint(): Promise<EndpointInfo> {
    const res = await fetch(`${this.base}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", locale: "zh" },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
      // Uses the global undici dispatcher (proxy + idle timeouts) configured by
      // lib/http-dispatcher at boot.
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { URL?: string; ClientConfig?: Record<string, number> };
    };
    if (data.code !== 0 || !data.data?.URL) {
      throw new Error(`endpoint-open failed (code ${data.code}): ${data.msg ?? "no URL"}`);
    }
    const url = data.data.URL;
    const params = new URL(url).searchParams;
    const serviceId = Number(params.get("service_id") ?? "0");
    const cc = data.data.ClientConfig ?? {};
    return {
      url,
      serviceId: Number.isFinite(serviceId) ? serviceId : 0,
      pingIntervalMs: numOrDefault(cc.PingInterval, 30) * 1000,
      reconnectIntervalMs: numOrDefault(cc.ReconnectInterval, 2) * 1000,
      reconnectNonceMs: numOrDefault(cc.ReconnectNonce, 30) * 1000,
      reconnectCount: numOrDefault(cc.ReconnectCount, -1),
    };
  }

  private openSocket(): void {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint.url);
    } catch (err) {
      this.logger.error(`WebSocket constructor threw: ${msg(err)}`);
      this.emitState("error");
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.connectedAt = new Date().toISOString();
      this.emitState("connected");
      this.armPing();
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      this.onRawMessage(event.data);
    });

    ws.addEventListener("close", () => {
      this.clearPing();
      this.ws = null;
      if (this.stopped) {
        this.emitState("stopped");
        return;
      }
      this.emitState("reconnecting");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // undici fires 'error' before 'close'; the close handler drives reconnect.
      this.logger.warn("feishu long-connection WebSocket error event");
    });
  }

  // --- inbound --------------------------------------------------------------

  private onRawMessage(data: unknown): void {
    let bytes: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    }
    if (!bytes) return;
    let frame: PbFrame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      this.logger.warn(`failed to decode frame: ${msg(err)}`);
      return;
    }
    this.lastEventAt = new Date().toISOString();
    if (frame.method === METHOD_CONTROL) {
      this.handleControl(frame);
    } else if (frame.method === METHOD_DATA) {
      this.handleData(frame);
    }
  }

  private handleControl(frame: PbFrame): void {
    const headers = headerMap(frame);
    if (headers.get(H_TYPE) !== T_PONG) return;
    const payload = frame.payload;
    if (!payload || payload.length === 0) return; // plain ack, no retune
    // The server retunes ping/reconnect timing via a JSON ClientConfig payload.
    try {
      const cfg = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      const ep = this.endpoint;
      if (!ep) return;
      if (typeof cfg.PingInterval === "number") ep.pingIntervalMs = cfg.PingInterval * 1000;
      if (typeof cfg.ReconnectInterval === "number") ep.reconnectIntervalMs = cfg.ReconnectInterval * 1000;
      if (typeof cfg.ReconnectNonce === "number") ep.reconnectNonceMs = cfg.ReconnectNonce * 1000;
      if (typeof cfg.ReconnectCount === "number") ep.reconnectCount = cfg.ReconnectCount;
    } catch (err) {
      this.logger.warn(`failed to apply pong config: ${msg(err)}`);
    }
  }

  private handleData(frame: PbFrame): void {
    const headers = headerMap(frame);
    const type = headers.get(H_TYPE);
    if (type !== T_EVENT) {
      // card-action callbacks etc. are out of scope; ACK and ignore.
      this.sendAck(frame);
      return;
    }
    const messageId = headers.get(H_MESSAGE_ID);
    const sum = Number(headers.get(H_SUM) ?? "1") || 1;
    const seq = Number(headers.get(H_SEQ) ?? "0") || 0;

    // ACK within the 3-second deadline so the server does not redeliver. This
    // MUST NOT wait on agent processing (which can take minutes).
    this.sendAck(frame);

    const payload = frame.payload ?? new Uint8Array(0);
    if (sum > 1) {
      // Large events are split across frames sharing messageId; reassemble.
      if (!messageId) return;
      let bucket = this.fragments.get(messageId);
      if (!bucket) {
        bucket = { sum, pieces: new Array<Uint8Array | undefined>(sum).fill(undefined) };
        this.fragments.set(messageId, bucket);
      }
      bucket.pieces[seq] = payload;
      if (!bucket.pieces.every((piece) => piece !== undefined)) return;
      this.fragments.delete(messageId);
      this.dispatchEvent(concatU8(bucket.pieces as Uint8Array[]));
    } else {
      this.dispatchEvent(payload);
    }
  }

  private dispatchEvent(payloadBytes: Uint8Array): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch (err) {
      this.logger.warn(`event payload JSON parse failed: ${msg(err)}`);
      return;
    }
    const env = parsed as {
      header?: { event_type?: string };
      event?: {
        sender?: { sender_id?: { open_id?: string }; sender_type?: string };
        message?: {
          message_id?: string;
          chat_id?: string;
          chat_type?: string;
          message_type?: string;
          content?: string;
          create_time?: string;
        };
      };
    };
    if (env.header?.event_type !== EVENT_MESSAGE_RECEIVE) return;
    const message = env.event?.message;
    if (!message) return;
    if (message.chat_type !== "p2p") return; // DM only (per locked design)
    const dm: FeishuInboundDm = {
      messageId: message.message_id ?? "",
      chatId: message.chat_id ?? "",
      chatType: message.chat_type ?? "p2p",
      messageType: message.message_type ?? "text",
      text: message.message_type === "text" ? decodeTextContent(message.content) : "",
      senderOpenId: env.event?.sender?.sender_id?.open_id ?? "",
      rawContent: message.content ?? "",
      createTime: message.create_time ?? "",
    };
    if (!dm.chatId || !dm.messageId) return;
    // Fire and forget — ACK already sent; the router queues/serializes per chat.
    void Promise.resolve(this.callbacks.onDm(dm)).catch((err) => {
      this.logger.error(`onDm handler failed: ${msg(err)}`);
    });
  }

  // --- outbound frames ------------------------------------------------------

  private sendFrame(frame: PbFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encodeFrame(frame));
    } catch (err) {
      this.logger.error(`ws.send failed: ${msg(err)}`);
    }
  }

  /** ACK an inbound DATA frame: echo its identity fields + original headers,
   *  append a biz_rt header, and replace the payload with {code:200}. */
  private sendAck(inbound: PbFrame): void {
    this.sendFrame({
      seqId: inbound.seqId,
      logId: inbound.logId,
      service: inbound.service,
      method: METHOD_DATA,
      headers: [...inbound.headers, { key: H_BIZ_RT, value: "0" }],
      payload: new TextEncoder().encode(JSON.stringify({ code: ACK_CODE_OK })),
    });
  }

  // --- heartbeat ------------------------------------------------------------

  private armPing(): void {
    this.clearPing();
    const interval = this.endpoint?.pingIntervalMs ?? 30_000;
    this.pingTimer = setTimeout(() => {
      this.sendPing();
      this.armPing();
    }, interval);
  }

  private sendPing(): void {
    this.sendFrame({
      seqId: 0,
      logId: 0,
      service: this.endpoint?.serviceId ?? 0,
      method: METHOD_CONTROL,
      headers: [{ key: H_TYPE, value: T_PING }],
    });
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // --- reconnect ------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const endpoint = this.endpoint;
    if (!endpoint) return; // never connected (e.g. bad creds); nothing to retry from
    this.reconnectAttempts += 1;
    if (endpoint.reconnectCount !== -1 && this.reconnectAttempts > endpoint.reconnectCount) {
      this.logger.error(`feishu long-connection gave up after ${this.reconnectAttempts} attempts`);
      this.emitState("error");
      return;
    }
    // First retry uses a randomized jitter window (≤ reconnectNonceMs) to avoid
    // thundering-herd; later retries use the steady interval.
    const delay =
      this.reconnectAttempts === 1
        ? Math.floor(Math.random() * endpoint.reconnectNonceMs)
        : endpoint.reconnectIntervalMs;
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, Math.max(1000, delay));
  }
}

// --- helpers ----------------------------------------------------------------

function headerMap(frame: PbFrame): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of frame.headers) map.set(header.key, header.value);
  return map;
}

function decodeTextContent(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function concatU8(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function numOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
