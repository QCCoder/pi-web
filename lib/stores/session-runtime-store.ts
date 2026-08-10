/**
 * session-runtime-store.ts
 *
 * 按 sessionId 分片的运行态 store（REQ-0001 决策 6 / 阶段 B 设计 4.1）。
 *
 * 永不淘汰（轻量 UI 状态）：不设 maxSize，createMapStore 的 LRU 不启用。
 * 字段来源：useAgentSession 的 per-instance useState（详见阶段 B 设计文档 4.1 迁移映射表）。
 *
 * 阶段 B1 为「未接线」基础设施（零风险）：B3 才会把 useAgentSession 的读写改到这里。
 * 在此之前本 store 与 hook 内 useState 并存、互不影响。
 */

import type { ExtensionStatusItem, ExtensionWidgetItem } from "../types";
import type { SessionStatsInfo } from "../pi-types";
import { createMapStore } from "./create-map-store";
import type {
  AgentPhase,
  CompactResultInfo,
  ContextUsage,
  ModelOverride,
  PendingBash,
  QueuedMessages,
  StreamingState,
  ThinkingLevelOption,
  ToolExecutionPartial,
} from "../agent/agent-types";

export interface SessionRuntimeState {
  // --- 流式 / run 生命周期 ---
  streamState: StreamingState;
  agentRunning: boolean;
  agentPhase: AgentPhase;
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  /** handleSend 写入、message_end(user) 消费的乐观气泡去重键。 */
  optimisticUserMessageKey: string | null;

  // --- bash ---
  bashRunning: boolean;
  pendingBash: PendingBash | null;

  // --- 顶部栏显示（决策 11：systemPrompt/stats/contextUsage/modelOverride 归 session runtime）---
  contextUsage: ContextUsage | null;
  systemPrompt: string | null;
  thinkingLevel: ThinkingLevelOption;
  currentModelOverride: ModelOverride | null;
  sessionStatsOverride: SessionStatsInfo | null;

  // --- 扩展（per session）---
  extensionStatuses: ExtensionStatusItem[];
  extensionWidgets: ExtensionWidgetItem[];
  queuedMessages: QueuedMessages;

  // --- 压缩 ---
  isCompacting: boolean;
  compactError: string | null;
  compactResult: CompactResultInfo | null;

  // --- 分支 / fork UI ---
  activeLeafId: string | null;
  forkingEntryId: string | null;

  // --- 流式 tool 执行进度（tool_execution_update）---
  /** toolCallId → partial result，供运行中的 tool call 块实时渲染（如 subagent 进度）。
   *  最终 toolResult 消息落地后由 ChatWindow 以更高优先级覆盖；每个 agent_start 清空。 */
  toolExecutionUpdates: Record<string, ToolExecutionPartial>;

  // --- 跨切换保留（阶段 B 新增，设计 4.1）---
  scrollPosition: number | null;
  lastActiveAt: number;
}

/** 未设置 slice 的稳定空值（useStoreSlice selector 的兜底，保证引用稳定）。 */
export const EMPTY_RUNTIME: SessionRuntimeState = {
  streamState: { isStreaming: false, streamingMessage: null },
  agentRunning: false,
  agentPhase: null,
  retryInfo: null,
  optimisticUserMessageKey: null,
  bashRunning: false,
  pendingBash: null,
  contextUsage: null,
  systemPrompt: null,
  thinkingLevel: "auto",
  currentModelOverride: null,
  sessionStatsOverride: null,
  extensionStatuses: [],
  extensionWidgets: [],
  queuedMessages: { steering: [], followUp: [] },
  isCompacting: false,
  compactError: null,
  compactResult: null,
  activeLeafId: null,
  forkingEntryId: null,
  toolExecutionUpdates: {},
  scrollPosition: null,
  lastActiveAt: 0,
};

export function createDefaultSessionRuntimeState(): SessionRuntimeState {
  return {
    streamState: { isStreaming: false, streamingMessage: null },
    agentRunning: false,
    agentPhase: null,
    retryInfo: null,
    optimisticUserMessageKey: null,
    bashRunning: false,
    pendingBash: null,
    contextUsage: null,
    systemPrompt: null,
    thinkingLevel: "auto",
    currentModelOverride: null,
    sessionStatsOverride: null,
    extensionStatuses: [],
    extensionWidgets: [],
    queuedMessages: { steering: [], followUp: [] },
    isCompacting: false,
    compactError: null,
    compactResult: null,
    activeLeafId: null,
    forkingEntryId: null,
    toolExecutionUpdates: {},
    scrollPosition: null,
    lastActiveAt: Date.now(),
  };
}

/** 单例 store。按 sessionId 分片订阅，永不淘汰（无 maxSize）。 */
export const sessionRuntimeStore = createMapStore<string, SessionRuntimeState>();

/** 缺失时建默认并写入；存在则原样返回。全局 SSE 监听器（B4）读取入口。 */
export function ensureSessionRuntime(sessionId: string): SessionRuntimeState {
  const existing = sessionRuntimeStore.get(sessionId);
  if (existing) return existing;
  const created = createDefaultSessionRuntimeState();
  sessionRuntimeStore.set(sessionId, created);
  return created;
}

/** 纯读：缺失返回默认但不写入（不污染 store）。 */
export function getSessionRuntime(sessionId: string): SessionRuntimeState {
  return sessionRuntimeStore.get(sessionId) ?? createDefaultSessionRuntimeState();
}

/** 浅合并写入（缺失时以默认为底）。 */
export function setSessionRuntime(
  sessionId: string,
  patch: Partial<SessionRuntimeState>,
): void {
  const base = sessionRuntimeStore.get(sessionId) ?? createDefaultSessionRuntimeState();
  sessionRuntimeStore.set(sessionId, { ...base, ...patch });
}

/** 基于前值不可变更新（缺失时以默认为 prev）。 */
export function updateSessionRuntime(
  sessionId: string,
  updater: (prev: SessionRuntimeState) => SessionRuntimeState,
): void {
  sessionRuntimeStore.update(sessionId, (prev) => updater(prev ?? createDefaultSessionRuntimeState()));
}
