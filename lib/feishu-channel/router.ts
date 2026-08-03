import { randomUUID } from "node:crypto";
import { FeishuClient } from "../feishu/client.ts";
import { readFeishuConfig } from "../feishu/config.ts";
import { startRpcSession, type AgentSessionWrapper } from "../rpc-manager.ts";
import {
  getBinding,
  removeBinding,
  touchBinding,
  upsertBinding,
} from "./binding-store.ts";
import type { ChatSessionBinding, FeishuInboundDm } from "./types.ts";

export interface FeishuChannelRouterOptions {
  workspaceId: string;
  /** Absolute workspace path — the cwd for created/resumed pi sessions. */
  workspacePath: string;
}

/** Commands that force a fresh session for the chat. */
const NEW_SESSION_COMMANDS = new Set(["/new", "/reset", "/newchat"]);
/** Upper bound on waiting for a single agent turn before telling the user to wait. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type TurnOutcome =
  | { kind: "end" }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

/**
 * Inbound router: turn a decoded Feishu DM into a pi session turn and reply.
 *
 * pi-web is the SINGLE session owner: this reuses rpc-manager's startRpcSession
 * (the in-process AgentSession registry) — it never spawns a process that opens
 * its own AgentSession. 1 chat <-> 1 long-lived pi session (compaction handles
 * growth); `/new` drops the binding so the next message starts fresh.
 *
 * Messages for a single chat are serialized through a per-chat promise queue so
 * that turn boundaries (prompt -> agent_end -> reply) line up correctly even
 * when several messages arrive in quick succession.
 */

// --- per-chat serial queue -------------------------------------------------

const chatQueues = new Map<string, Promise<void>>();

function enqueue(chatId: string, task: () => Promise<void>): Promise<void> {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  // Run `task` whether or not the previous task succeeded, so one failed turn
  // never blocks the next message for that chat.
  const next = previous.then(task, task);
  chatQueues.set(chatId, next);
  void next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
  return next;
}

// --- turn completion -------------------------------------------------------

function waitForTurn(wrapper: AgentSessionWrapper): {
  promise: Promise<Extract<TurnOutcome, { kind: "end" | "error" }>>;
  cancel: () => void;
} {
  let resolve!: (value: Extract<TurnOutcome, { kind: "end" | "error" }>) => void;
  const promise = new Promise<Extract<TurnOutcome, { kind: "end" | "error" }>>((res) => {
    resolve = res;
  });
  const off = wrapper.onEvent((event) => {
    if (event.type === "agent_end") resolve({ kind: "end" });
    else if (event.type === "prompt_error") {
      resolve({ kind: "error", message: errMsg(event.errorMessage) });
    }
  });
  return { promise, cancel: () => off() };
}

function startTimer(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: "timeout") => void;
  const promise = new Promise<"timeout">((res) => {
    resolve = res;
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => { if (handle) clearTimeout(handle); } };
}

// --- reply -----------------------------------------------------------------

async function sendReply(workspaceId: string, chatId: string, text: string): Promise<void> {
  const config = await readFeishuConfig(workspaceId);
  if (!config) return; // nothing we can do without credentials
  const client = new FeishuClient(config);
  // Read fresh each time so a credential update (PUT /api/workspaces/[id]/feishu)
  // takes effect without restarting the channel.
  await client.sendText(chatId, text, "chat_id");
}

// --- session resolution ----------------------------------------------------

async function resolveSession(
  dm: FeishuInboundDm,
  opts: FeishuChannelRouterOptions,
): Promise<AgentSessionWrapper> {
  const existing = await getBinding(opts.workspaceId, dm.chatId);
  if (existing && existing.sessionId && existing.sessionFile) {
    // Reopen the long-lived session. startRpcSession coalesces concurrent
    // reopen calls for the same id onto one in-process AgentSession.
    const { session } = await startRpcSession(
      existing.sessionId,
      existing.sessionFile,
      opts.workspacePath,
      undefined,
    );
    await touchBinding(opts.workspaceId, dm.chatId, {
      lastMessageAt: new Date().toISOString(),
      senderOpenId: dm.senderOpenId,
    }).catch(() => {
      // Non-fatal: the binding file may have been removed concurrently.
    });
    return session;
  }

  // No binding yet — create a brand-new session. Use a one-time lock key so
  // startRpcSession does not coalesce this with a real session id; it returns
  // pi's real generated id.
  const tempKey = `__feishu__${randomUUID()}`;
  const { session, realSessionId } = await startRpcSession(
    tempKey,
    "",
    opts.workspacePath,
    undefined,
  );
  const now = new Date().toISOString();
  const binding: ChatSessionBinding = {
    chatId: dm.chatId,
    sessionId: realSessionId,
    sessionFile: session.sessionFile ?? "",
    senderOpenId: dm.senderOpenId,
    createdAt: now,
    updatedAt: now,
  };
  await upsertBinding(opts.workspaceId, binding);
  return session;
}

// --- per-message handlers --------------------------------------------------

async function handleNewSession(dm: FeishuInboundDm, opts: FeishuChannelRouterOptions): Promise<void> {
  await removeBinding(opts.workspaceId, dm.chatId);
  await sendReply(opts.workspaceId, dm.chatId, "✅ 已开启新会话，发送下一条消息即可开始。");
}

async function routePrompt(
  dm: FeishuInboundDm,
  text: string,
  opts: FeishuChannelRouterOptions,
): Promise<void> {
  let wrapper: AgentSessionWrapper;
  try {
    wrapper = await resolveSession(dm, opts);
  } catch (err) {
    await sendReply(opts.workspaceId, dm.chatId, `⚠️ 无法创建/恢复会话：${errMsg(err)}`);
    return;
  }

  // The queue serializes per chat, so the wrapper should be idle here; the
  // running guard defends against external use of the same session (e.g. the
  // pi-web UI chatting into it) without interleaving turn listeners.
  if (wrapper.isRunning()) {
    await sendReply(opts.workspaceId, dm.chatId, "⏳ 上一条消息仍在处理中，请稍后再试。");
    return;
  }

  // Attach the turn listener BEFORE sending the prompt so agent_end for this
  // turn can never be missed.
  const turn = waitForTurn(wrapper);
  const timer = startTimer(TURN_TIMEOUT_MS);
  try {
    await wrapper.send({ type: "prompt", message: text });
  } catch (err) {
    turn.cancel();
    timer.cancel();
    await sendReply(opts.workspaceId, dm.chatId, `⚠️ 发送失败：${errMsg(err)}`);
    return;
  }

  const raced = await Promise.race([turn.promise, timer.promise]);
  turn.cancel();
  timer.cancel();

  if (raced === "timeout") {
    await sendReply(
      opts.workspaceId,
      dm.chatId,
      "⏳ 仍在处理中，稍后会自动回复；如长时间无响应可发送 /new 重置。",
    );
    return;
  }
  if (raced.kind === "error") {
    await sendReply(opts.workspaceId, dm.chatId, `⚠️ 处理出错：${raced.message}`);
    return;
  }

  let reply = "";
  try {
    const result = (await wrapper.send({ type: "get_last_assistant_text" })) as { text?: string };
    reply = result.text ?? "";
  } catch {
    reply = "";
  }
  if (!reply.trim()) reply = "（处理完成，无文本回复）";
  await sendReply(opts.workspaceId, dm.chatId, reply);
}

async function handleOne(dm: FeishuInboundDm, opts: FeishuChannelRouterOptions): Promise<void> {
  const text = dm.text.trim();
  const command = text.toLowerCase();
  if (NEW_SESSION_COMMANDS.has(command)) {
    await handleNewSession(dm, opts);
    return;
  }
  if (!text) {
    await sendReply(opts.workspaceId, dm.chatId, "（目前仅支持文字消息。）");
    return;
  }
  await routePrompt(dm, text, opts);
}

/**
 * Route one inbound DM. Safe to call concurrently — per-chat serialization is
 * handled internally. Never throws: every failure path replies to the user.
 */
export function routeInboundDm(dm: FeishuInboundDm, opts: FeishuChannelRouterOptions): Promise<void> {
  return enqueue(dm.chatId, () => handleOne(dm, opts).catch((err) => {
    // Last-resort guard so a thrown task never rejects the queue chain.
    return sendReply(opts.workspaceId, dm.chatId, `⚠️ 处理出错：${errMsg(err)}`);
  }));
}
