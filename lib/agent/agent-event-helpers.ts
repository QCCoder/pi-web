/**
 * agent-event-helpers.ts
 *
 * applyAgentEvent 需要的纯函数工具（REQ-0001 阶段 B，设计 4.2）。
 *
 * NOTE（阶段 B 过渡）：这些函数目前在 hooks/useAgentSession.ts 有一份同名副本
 * （handleAgentEvent / handleSend 等仍直接使用 hook 内副本）。本文件是 lib 层权威定义，
 * 供 agent-event-reducer.ts 使用。阶段 B3 会让 useAgentSession 改为从这里导入并删除副本。
 * 逻辑与 hook 内副本逐字一致；agent-event-reducer.test.ts 覆盖 reducer 路径。
 */

import type { AgentMessage } from "../types";
import type { CompactCommandResult, CompactResultInfo, QueuedMessages } from "./agent-types";

export function normalizeQueuedMessages(
  q?: { steering?: string[]; followUp?: string[] } | null,
): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

export function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

export function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

/** 用户消息的去重键：文本 + 图片签名。handleSend 写入乐观气泡后用此键在
 *  message_end(user) 时判断「服务端确认的 user 消息」是否就是「乐观气泡」。 */
export function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

/** 按toolCallId 在消息流里反查工具名（归一后的 assistant toolCall 块）。中途接入
 *  SSE 的观看者（Loop orchestrator 会话）没看到 tool_execution_start，只有
 *  tool_execution_update partial —— 用它把 phase 升级成 running_tools 时需要名字。 */
export function findToolNameById(messages: AgentMessage[], toolCallId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block && typeof block === "object"
        && (block as { type?: unknown }).type === "toolCall"
        && (block as { toolCallId?: unknown }).toolCallId === toolCallId
      ) {
        const name = (block as { toolName?: unknown }).toolName;
        if (typeof name === "string" && name) return name;
      }
    }
  }
  return undefined;
}
