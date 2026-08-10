/**
 * agent-event-reducer.ts
 *
 * applyAgentEvent —— 把 useAgentSession.handleAgentEvent 抽成的纯函数
 * （REQ-0001 阶段 B，设计 4.2）。
 *
 * 语义与原 handleAgentEvent 逐字对齐：
 *   - 流式累积（message_start/update 写 streamingMessage，message_end 落盘 + reset）；
 *   - tool 解析（normalizeToolCalls 把 pi 的 {id,name,arguments} 归一为 {toolCallId,toolName,input}）；
 *   - tool phase 转移（tool_execution_start/end 维护 running_tools 列表）；
 *   - result 匹配（readCompactResult）；
 *   - compaction 新老事件名（compaction_* 与 auto_compaction_* 都支持，AGENTS.md）；
 *   - 晚到事件 guard（agent_end 后的 message_* 用 agentRunning 判断丢弃，防 ghost bubble）；
 *   - 乐观气泡去重（message_end(user) 消费 optimisticUserMessageKey）。
 *
 * 与原 hook 的区别（设计 4.2）：
 *   - 直接读写传入的 prev runtime（不再 dispatch / setState）；
 *   - 副作用（reloadSession、刷新 agent state、notice、extensionDialog、
 *     document.title、editor 注入、完成音）以 effects[] 返回，由调用方执行——
 *     不在纯函数里碰网络 / DOM / 本地 UI 态；
 *   - 无变化的 case 保持 runtime === prev（调用方可据此跳过 store 写入，
 *     复刻 React 的 bailout，契合决策 5「引用不变则跳过重渲染」）。
 *
 * 单测用真实事件序列逐一覆盖（见 agent-event-reducer.test.ts）。
 */

import type { AgentMessage, ExtensionUiRequest } from "../types";
import { normalizeToolCalls } from "../normalize";
import type { SessionRuntimeState } from "../stores/session-runtime-store";
import type {
  AgentEvent,
  ExtensionUiCustomRequest,
  ExtensionUiDialogRequest,
  NoticeType,
} from "./agent-types";
import { readCompactResult, userMessageKey } from "./agent-event-helpers";

export interface AgentEventCtx {
  sessionId: string;
  /** 当前 session 的消息列表（来自 SessionMessagesCache）。
   *  message_end(user) 的乐观气泡去重需要读取最后一条。 */
  messages: AgentMessage[];
}

export type AgentEventEffect =
  | { kind: "reloadSession" }
  | { kind: "refreshAgentState" }
  | { kind: "onAgentEnd" }
  | { kind: "finishPromptWithoutStream" }
  | { kind: "addNotice"; id?: string; message: string; type: NoticeType }
  | { kind: "setExtensionDialog"; request: ExtensionUiDialogRequest }
  | { kind: "resolveExtensionCustomUi"; request: ExtensionUiCustomRequest }
  | { kind: "setDocumentTitle"; title: string }
  | { kind: "editorInsertText"; text: string };

export interface ApplyAgentEventResult {
  /** 新 runtime；无变化时 === prev（调用方据此决定是否写 store）。 */
  runtime: SessionRuntimeState;
  /** 变化后的消息列表；无变化时 undefined（调用方据此决定是否写 messages cache）。 */
  messages: AgentMessage[] | undefined;
  /** 调用方需执行的副作用（顺序敏感：按返回顺序执行）。 */
  effects: AgentEventEffect[];
}

export function applyAgentEvent(
  prev: SessionRuntimeState,
  event: AgentEvent,
  ctx: AgentEventCtx,
): ApplyAgentEventResult {
  const effects: AgentEventEffect[] = [];
  let runtime = prev;
  let messages: AgentMessage[] | undefined = undefined;

  switch (event.type) {
    case "agent_start": {
      runtime = {
        ...runtime,
        agentRunning: true,
        agentPhase: { kind: "waiting_model" },
        streamState: { isStreaming: true, streamingMessage: null },
        // Fresh run: drop any stale partials from a previous run.
        toolExecutionUpdates: {},
      };
      break;
    }

    case "agent_end": {
      // A late agent_end can arrive over SSE after reconcileAgentState already
      // finished this run — don't re-trigger completion.
      if (!runtime.agentRunning) break;
      runtime = {
        ...runtime,
        agentRunning: false,
        agentPhase: null,
        retryInfo: null,
        streamState: { isStreaming: false, streamingMessage: null },
      };
      effects.push({ kind: "reloadSession" });
      effects.push({ kind: "refreshAgentState" });
      effects.push({ kind: "onAgentEnd" });
      break;
    }

    case "prompt_done": {
      if (!runtime.agentRunning) break;
      effects.push({ kind: "finishPromptWithoutStream" });
      break;
    }

    case "prompt_error": {
      effects.push({
        kind: "addNotice",
        type: "error",
        message: (event.errorMessage as string | undefined) ?? "Command failed",
      });
      break;
    }

    case "extension_error": {
      effects.push({
        kind: "addNotice",
        type: "error",
        message: (event.error as string | undefined) ?? "Extension command failed",
      });
      break;
    }

    case "message_start":
    case "message_update": {
      // Ignore streaming events arriving after this run already finished
      // (SSE data buffered while the tab was frozen, flushed after reconcile) —
      // they would resurrect a ghost streaming bubble.
      if (!runtime.agentRunning) break;
      const msg = event.message as Partial<AgentMessage> | undefined;
      if (msg?.role === "user") break;
      const nextStream = msg
        ? { isStreaming: true, streamingMessage: normalizeToolCalls(msg as AgentMessage) }
        : runtime.streamState;
      runtime = { ...runtime, streamState: nextStream, agentPhase: null };
      break;
    }

    case "message_end": {
      // Same late-event guard as message_update: after reconcile finished this
      // run, loadSession already loaded this message — appending again would
      // duplicate it.
      if (!runtime.agentRunning) break;
      const completed = event.message as AgentMessage | undefined;
      if (completed && completed.role === "user") {
        // Delivered steering/follow-up messages surface here as user messages.
        // The run's initial prompt also emits one, but handleSend already
        // appended it optimistically. Consume only the still-adjacent optimistic
        // bubble; later same-text queue deliveries must render.
        const delivered = normalizeToolCalls(completed);
        const deliveredKey = userMessageKey(delivered);
        const optimisticKey = runtime.optimisticUserMessageKey;
        const base = ctx.messages;
        const last = base[base.length - 1];
        if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
          if (optimisticKey === deliveredKey) {
            // 完全一致：复刻 React setState 同引用 bailout —— messages 不变。
            messages = undefined;
          } else {
            messages = [...base.slice(0, -1), delivered];
          }
        } else {
          messages = [...base, delivered];
        }
        runtime = { ...runtime, optimisticUserMessageKey: null };
      } else if (completed) {
        messages = [...ctx.messages, normalizeToolCalls(completed)];
      }
      runtime = {
        ...runtime,
        streamState: { isStreaming: false, streamingMessage: null },
        agentPhase: { kind: "waiting_model" },
      };
      break;
    }

    case "tool_execution_update": {
      const id = event.toolCallId as string | undefined;
      const partial = event.partialResult as
        | { content?: unknown; details?: unknown }
        | undefined;
      if (!id || !partial) break;
      const content = Array.isArray(partial.content)
        ? (partial.content as Array<{ type: "text"; text: string }>).filter(
            (c) => c && c.type === "text" && typeof c.text === "string",
          )
        : [];
      runtime = {
        ...runtime,
        toolExecutionUpdates: {
          ...runtime.toolExecutionUpdates,
          [id]: { toolCallId: id, content, details: partial.details },
        },
      };
      break;
    }

    case "tool_execution_start": {
      const id = event.toolCallId as string;
      const name = event.toolName as string;
      const current = runtime.agentPhase?.kind === "running_tools" ? runtime.agentPhase.tools : [];
      const tools = current.some((t) => t.id === id) ? current : [...current, { id, name }];
      runtime = { ...runtime, agentPhase: { kind: "running_tools", tools } };
      break;
    }

    case "tool_execution_end": {
      const id = event.toolCallId as string;
      if (runtime.agentPhase?.kind !== "running_tools") break;
      const tools = runtime.agentPhase.tools.filter((t) => t.id !== id);
      runtime = {
        ...runtime,
        agentPhase: tools.length === 0 ? { kind: "waiting_model" } : { kind: "running_tools", tools },
      };
      break;
    }

    case "queue_update": {
      runtime = {
        ...runtime,
        queuedMessages: {
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        },
      };
      break;
    }

    case "auto_retry_start": {
      runtime = {
        ...runtime,
        retryInfo: {
          attempt: event.attempt as number,
          maxAttempts: event.maxAttempts as number,
          errorMessage: event.errorMessage as string | undefined,
        },
      };
      break;
    }

    case "auto_retry_end": {
      runtime = { ...runtime, retryInfo: null };
      break;
    }

    case "auto_compaction_start":
    case "compaction_start": {
      runtime = { ...runtime, isCompacting: true, compactError: null, compactResult: null };
      break;
    }

    case "auto_compaction_end":
    case "compaction_end": {
      if (event.errorMessage) {
        runtime = {
          ...runtime,
          isCompacting: false,
          compactError: event.errorMessage as string,
          compactResult: null,
        };
      } else if (!event.aborted) {
        runtime = {
          ...runtime,
          isCompacting: false,
          compactResult: readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"),
        };
        effects.push({ kind: "reloadSession" });
      } else {
        runtime = { ...runtime, isCompacting: false };
      }
      break;
    }

    case "extension_ui_request": {
      const request = event as ExtensionUiRequest;
      switch (request.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor":
          effects.push({ kind: "setExtensionDialog", request });
          break;
        case "notify":
          effects.push({
            kind: "addNotice",
            id: request.id,
            message: request.message,
            type: request.notifyType ?? "info",
          });
          break;
        case "setStatus": {
          const rest = runtime.extensionStatuses.filter((item) => item.key !== request.statusKey);
          runtime = {
            ...runtime,
            extensionStatuses: request.statusText !== undefined
              ? [...rest, { key: request.statusKey, text: request.statusText }]
              : rest,
          };
          break;
        }
        case "setWidget": {
          const rest = runtime.extensionWidgets.filter((item) => item.key !== request.widgetKey);
          runtime = {
            ...runtime,
            extensionWidgets: request.widgetLines
              ? [...rest, {
                  key: request.widgetKey,
                  lines: request.widgetLines,
                  placement: request.widgetPlacement ?? "aboveEditor",
                }]
              : rest,
          };
          break;
        }
        case "setTitle":
          if (request.title) effects.push({ kind: "setDocumentTitle", title: request.title });
          break;
        case "set_editor_text":
          effects.push({ kind: "editorInsertText", text: request.text });
          break;
        case "custom":
          // extensionCustomUi 是本地 UI 态（不迁入 store，设计 4.1「不迁入」清单）。
          // 用 effect 把"带 closed 的合并"交给调用方：非 closed → 替换；
          // closed 且 id 命中当前 → 清空，否则保持（与原 setExtensionCustomUi 回调一致）。
          effects.push({ kind: "resolveExtensionCustomUi", request });
          break;
      }
      break;
    }

    default:
      // 未识别事件：不变（runtime === prev）。
      break;
  }

  return { runtime, messages, effects };
}
