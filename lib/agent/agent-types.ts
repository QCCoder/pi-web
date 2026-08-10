/**
 * agent-types.ts
 *
 * agent 运行态 / 事件管线共享类型（REQ-0001 阶段 B，决策 4/6/11）。
 *
 * NOTE（阶段 B 过渡）：这些类型目前在 hooks/useAgentSession.ts 有一份同名副本。
 * 本文件是 lib 层权威定义，供 lib/stores/session-runtime-store.ts 与
 * lib/agent/agent-event-reducer.ts 使用。阶段 B3 会让 useAgentSession 改为从这里导入，
 * 届时删除 hook 内副本。在此之前两份并存、结构相同（结构化类型可互换）。
 */

import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
} from "../types";

/** SSE / 命令返回的原始事件：type 字段判别，其余字段为宽松 unknown。 */
export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/** GET /api/agent/[id] 返回的 agent.state 形状（节选 reducer / reconcile 关心的字段）。 */
export type AgentStateResponse = {
  contextUsage?: ContextUsage | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
};

export type ThinkingLevelOption =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

/** /compact 命令返回（节选）。 */
export interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

/** 弹窗式扩展 UI 请求（select/confirm/input/editor）。 */
export type ExtensionUiDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

/** 自定义扩展 UI 请求（custom，带 closed 时表示关闭）。 */
export type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

export type NoticeType = "info" | "success" | "warning" | "error";

/** 流式状态：是否在流式 + 当前正在累积的 assistant 消息。 */
export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

/** Partial result streamed via `tool_execution_update` while a tool runs.
 *  Surfaced to the running tool-call block (e.g. live subagent progress). */
export interface ToolExecutionPartial {
  toolCallId: string;
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

/** 运行态：当前执行的 bash 命令（pending 显示用）。 */
export interface PendingBash {
  command: string;
  excludeFromContext: boolean;
}

/** 顶部栏 context usage 显示。 */
export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

/** 当前 session 的 model 覆盖（用户手动切换模型后）。 */
export interface ModelOverride {
  provider: string;
  modelId: string;
}
