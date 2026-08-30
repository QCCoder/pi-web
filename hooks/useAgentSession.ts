"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { sendAgentCommand } from "@/lib/agent-client";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { getCachedSession, setCachedSession, dropCachedSession, sessionMessagesCache, updateCachedSessionData, makeMinimalSessionData } from "@/lib/stores/session-messages-cache";
import { useModels, fetchModels, deriveNewSessionDefaultModel, type SelectedModel } from "@/lib/stores/models-store";
import { useStoreSlice } from "@/lib/stores/create-map-store";
import { sessionRuntimeStore, setSessionRuntime, updateSessionRuntime, getSessionRuntime, createDefaultSessionRuntimeState, EMPTY_RUNTIME, type SessionRuntimeState } from "@/lib/stores/session-runtime-store";
import { globalAgentEvents } from "@/lib/sse/global-agent-events";


export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    hasEarlier?: boolean;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
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

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

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

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  /** 变化时强制重新加载当前 session（替代原 key={sessionKey} 的整树重建）。 */
  reloadSignal?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
/** 缓存命中且距上次加载不足此值时，纯用缓存不发请求（疯狂切换去重）。 */
const SESSION_REFETCH_THRESHOLD_MS = 1200;
const USER_SCROLL_INTENT_MS = 1200;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
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

function imageSignature(block: unknown): string {
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

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

/** 同步读取当前 session 的 runtime slice（回调里的 guard 用，替代原镜像 ref）。 */
function readRuntimeFor(keyRef: { current: string }): SessionRuntimeState {
  return getSessionRuntime(keyRef.current);
}

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_ENTRY_IDS: string[] = [];

/** 新会话乐观消息的最小 SessionData 占位（promote 后被 loadSession 的文件数据覆盖）。 */
export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, reloadSignal, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  // runtimeKey 早定义（cache + runtime 订阅共用）。
  const runtimeKey = session?.id ?? newSessionCwd ?? "__new__";
  const runtimeKeyRef = useRef(runtimeKey);
  runtimeKeyRef.current = runtimeKey;

  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  /** 会话是否由 session daemon 持有（kit 轮会话 / subagent
   *  child / interactive）。drives pin 语义：被查看但未在跑的 daemon 会话
   *  不被 running-set 清扫断流（见挂载 effect 的 liveInDaemon 处理）。 */
  const [liveInDaemon, setLiveInDaemon] = useState(false);

  // data / messages / entryIds 订阅 SessionMessagesCache（阶段 B4a）：后台 session 的
  // message_end 写 cache 也能反映到前台；切回已缓存 session 无空窗。
  const cachedEntry = useStoreSlice(sessionMessagesCache, runtimeKey, (e) => e ?? null);
  const data = cachedEntry?.data ?? null;
  const messages = data?.context.messages ?? EMPTY_MESSAGES;
  const entryIds = data?.context.entryIds ?? EMPTY_ENTRY_IDS;

  // SessionRuntimeStore 订阅（B3，per-session 分片）。整 slice 一次读 + destructure；写走
  // patchRuntime（见下）。新会话用 newSessionCwd 临时 key，promote 后从服务端重派生。
  const runtime = useStoreSlice(sessionRuntimeStore, runtimeKey, (s) => s ?? EMPTY_RUNTIME);
  const {
    agentRunning, bashRunning, agentPhase, retryInfo, streamState,
    contextUsage, systemPrompt, thinkingLevel, sessionStatsOverride,
    isCompacting, compactError, compactResult, currentModelOverride,
    forkingEntryId, activeLeafId, extensionStatuses, extensionWidgets,
    queuedMessages, pendingBash, toolExecutionUpdates,
    hasEarlierMessages, loadingEarlier,
  } = runtime;

  const loadSessionAbortRef = useRef<AbortController | null>(null);
  /** L3 earlier-page 单飞锁（loadEarlier 去重）。 */
  const earlierInFlightRef = useRef(false);
  /** 当前被 pin 住的 daemon 会话 id（见挂载 effect 的 liveInDaemon 处理）。 */
  const pinnedDaemonSidRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const bashRecoveryIdRef = useRef(0);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const promptRunIdRef = useRef(0);

  // 写 SessionRuntimeStore：key 用 runtimeKeyRef（响应式 runtimeKey 的镜像，覆盖新会话
  // pre-id 写入——agentRunning/optimisticKey 等在 ensureNewSession 之前就要可见）。
  // 支持函数更新（functional setter）。稳定（空依赖）。
  const patchRuntime = useCallback(
    (patch: Partial<SessionRuntimeState> | ((prev: SessionRuntimeState) => SessionRuntimeState)) => {
      const key = runtimeKeyRef.current;
      if (typeof patch === "function") updateSessionRuntime(key, patch);
      else setSessionRuntime(key, patch);
    },
    [],
  );
  // streamState 走 store（阶段 B3c）：dispatch 复用 streamReducer 纯函数，把结果写回 store slice。
  const dispatch = useCallback(
    (action: StreamAction) => patchRuntime((rt) => ({ ...rt, streamState: streamReducer(rt.streamState, action) })),
    [patchRuntime],
  );
  // messages 走 SessionMessagesCache（阶段 B4a）：setMessages(prev=>...) 复用为不可变更新
  // cache 条目的 data.context.messages。无条目时 no-op（新会话乐观消息由 handleSend 显式建条目）。
  const setMessages = useCallback(
    (updater: AgentMessage[] | ((prev: AgentMessage[]) => AgentMessage[])) => {
      updateCachedSessionData(runtimeKeyRef.current, (sd) => ({
        ...sd,
        context: { ...sd.context, messages: typeof updater === "function" ? updater(sd.context.messages) : updater },
      }));
    },
    [],
  );
  // 对外 setData 包装（接口兼容）：写 whole SessionData 到 cache。
  const setData = useCallback((d: SessionData | null) => {
    const key = runtimeKeyRef.current;
    if (d) setCachedSession(key, d, getCachedSession(key)?.revision);
    else dropCachedSession(key);
  }, []);

  // models 走全局 modelsStore（按 cwd 分片，REQ-0001 决策 11 / 阶段 B2）：同一 cwd 的
  // session 共享一份 + 一次请求，切 session 不再重复 loadModels。
  const modelCwd = newSessionCwd ?? session?.cwd ?? "";
  const modelsState = useModels(modelCwd, modelsRefreshKey ?? 0);
  const modelNames = modelsState.models;
  const modelList = modelsState.modelList;
  const modelError = modelsState.modelError;
  const modelThinkingLevels = modelsState.thinkingLevels;
  const modelThinkingLevelMaps = modelsState.thinkingLevelMaps;
  const newSessionDefaultModel = useMemo(
    () => deriveNewSessionDefaultModel(modelsState),
    [modelsState],
  );

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, session?.id, session?.name]);

  const applySessionData = useCallback((d: SessionData) => {
    // data/messages/entryIds 由 SessionMessagesCache 订阅驱动（setCachedSession / 缓存命中）；
    // 这里只同步 runtime 派生字段。
    patchRuntime({
      activeLeafId: d.leafId,
      currentModelOverride: null,
      hasEarlierMessages: d.context.hasEarlier === true,
      loadingEarlier: false,
      ...(d.context.thinkingLevel && d.context.thinkingLevel !== "off"
        ? { thinkingLevel: d.context.thinkingLevel as ThinkingLevelOption }
        : {}),
    });
    setError(null);
  }, [patchRuntime]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    let messagesLoaded = false;
    // 取消上一次未完成的加载，防止快速切换 Tab 时请求堆积（浏览器并发连接有限）。
    loadSessionAbortRef.current?.abort();
    const ac = new AbortController();
    loadSessionAbortRef.current = ac;
    // 切换/重载时先清 pin 语义标记。
    setLiveInDaemon(false);
    try {
      // SWR (REQ-0001 决策 2/3): 缓存命中则立即填充 UI 消除空窗；再发条件请求，
      // 304 复用缓存、200 覆盖更新。
      const cached = getCachedSession(sid);
      if (cached) {
        applySessionData(cached.data);
        messagesLoaded = true;
      } else if (showLoading) {
        setLoading(true);
      }
      // 短期内刚加载过：跳过 session 详情请求（大响应），但仍刷新 state 以检测
      // running 并连 SSE。疯狂切换时只跳大请求，避免堆积又不丢流式连接。
      const fresh = Boolean(cached) && Date.now() - (cached?.loadedAt ?? 0) < SESSION_REFETCH_THRESHOLD_MS;
      if (!fresh) {
        const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tail: "100" });
        const headers: Record<string, string> = {};
        if (cached?.revision) headers["If-None-Match"] = cached.revision;
        const fetchOpts: RequestInit = { signal: ac.signal };
        if (Object.keys(headers).length > 0) fetchOpts.headers = headers;
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sid)}?${params}`,
          fetchOpts,
        );
        if (res.status === 304) {
          // 文件未变，复用缓存（messagesLoaded 已由缓存命中时置位）。
          if (showLoading) setLoading(false);
        } else {
          if (res.status === 404) {
            dropCachedSession(sid);
            if (showLoading) {
              patchRuntime({ activeLeafId: null });
              setError(null);
            }
            return null;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const revision = res.headers.get("etag") ?? undefined;
          const d = await res.json() as SessionData;
          if (sessionIdRef.current !== sid) return null;
          // Daemon-created session whose .jsonl hasn't been written yet answers
          // an empty-but-valid placeholder (no revision). Live SSE events may
          // already have appended messages to the cache slice — don't let the
          // placeholder clobber them; the first real append brings a revision
          // and overwrites cleanly.
          if (!revision && d.context.messages.length === 0 && getCachedSession(sid)) {
            if (showLoading) setLoading(false);
          } else {
            applySessionData(d);
            setCachedSession(sid, d, revision);
            messagesLoaded = true;
            if (showLoading) setLoading(false);
          }
        }
      } else if (showLoading) {
        setLoading(false);
      }
      if (!includeState) return null;

      try {
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, { signal: ac.signal });
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse; liveInDaemon?: boolean };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (liveState) {
          const patch: Partial<SessionRuntimeState> = {};
          if (liveState.contextUsage !== undefined) patch.contextUsage = liveState.contextUsage ?? null;
          if (liveState.systemPrompt !== undefined) patch.systemPrompt = liveState.systemPrompt ?? null;
          if (liveState.thinkingLevel !== undefined) patch.thinkingLevel = (liveState.thinkingLevel as ThinkingLevelOption) ?? "auto";
          if (liveState.extensionStatuses !== undefined) patch.extensionStatuses = liveState.extensionStatuses ?? [];
          if (liveState.extensionWidgets !== undefined) patch.extensionWidgets = liveState.extensionWidgets ?? [];
          if (liveState.queuedMessages !== undefined) patch.queuedMessages = normalizeQueuedMessages(liveState.queuedMessages);
          if (Object.keys(patch).length > 0) patchRuntime(patch);
        } else if (!agentState.running) {
          patchRuntime({ queuedMessages: { steering: [], followUp: [] } });
        }
        setLiveInDaemon(Boolean(agentState.liveInDaemon));
        return agentState;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return null;
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null;
      setError(String(e));
      return null;
    } finally {
      if (loadSessionAbortRef.current === ac) loadSessionAbortRef.current = null;
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [applySessionData, patchRuntime]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tail: "100" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[]; hasEarlier?: boolean } };
      updateCachedSessionData(sid, (sd) => ({
        ...sd,
        context: {
          ...sd.context,
          messages: d.context.messages,
          entryIds: d.context.entryIds ?? [],
          ...(d.context.hasEarlier !== undefined ? { hasEarlier: d.context.hasEarlier } : {}),
        },
      }));
      // 分支切换后窗口语义重置：hasEarlier 以新分支为准。
      patchRuntime({ hasEarlierMessages: d.context.hasEarlier === true, loadingEarlier: false });
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, [patchRuntime]);

  /** L3：把更早的一页消息前置到当前窗口（顶部哨兵触发）。锚点 = 当前窗口头部
   *  entryId；分支用当前 activeLeafId（会话继续追加也不影响旧分支锚点）。 */
  const loadEarlier = useCallback(async () => {
    const sid = session?.id;
    if (!sid) return;
    if (earlierInFlightRef.current) return;
    earlierInFlightRef.current = true;
    patchRuntime({ loadingEarlier: true });
    try {
      const key = runtimeKeyRef.current;
      const sd = getCachedSession(key);
      const anchor = sd?.data.context.entryIds[0];
      if (!anchor) {
        patchRuntime({ hasEarlierMessages: false, loadingEarlier: false });
        return;
      }
      const params = new URLSearchParams({ before: anchor, limit: "100", deferThinking: "1", deferMedia: "1" });
      if (activeLeafId) params.set("leafId", activeLeafId);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/earlier?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[]; hasEarlier?: boolean } };
      if (d.context.messages.length === 0) {
        patchRuntime({ hasEarlierMessages: d.context.hasEarlier === true, loadingEarlier: false });
        return;
      }
      updateCachedSessionData(key, (prev) => ({
        ...prev,
        context: {
          ...prev.context,
          messages: [...d.context.messages, ...prev.context.messages],
          entryIds: [...d.context.entryIds, ...prev.context.entryIds],
          ...(d.context.hasEarlier !== undefined ? { hasEarlier: d.context.hasEarlier } : {}),
        },
      }));
      patchRuntime({ hasEarlierMessages: d.context.hasEarlier === true, loadingEarlier: false });
    } catch (e) {
      console.error("Failed to load earlier messages:", e);
      patchRuntime({ loadingEarlier: false });
    } finally {
      earlierInFlightRef.current = false;
    }
  }, [session?.id, activeLeafId, patchRuntime]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { sessionId: string };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, newSessionModel, newSessionDefaultModel, toolPreset, thinkingLevel]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);


  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId?: number) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (runId !== undefined && promptRunIdRef.current !== runId) return;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      patchRuntime({ optimisticUserMessageKey: null });
      if (!readRuntimeFor(runtimeKeyRef).agentRunning) return;
      patchRuntime({ agentRunning: false, agentPhase: null, retryInfo: null });
      dispatch({ type: "end" });
      onAgentEnd?.();
    }
  }, [loadSession, onAgentEnd, patchRuntime, dispatch]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (readRuntimeFor(runtimeKeyRef).agentRunning && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      readRuntimeFor(runtimeKeyRef).bashRunning
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        patchRuntime({ bashRunning: false, pendingBash: null });
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession, patchRuntime]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same path as prompt_done.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!readRuntimeFor(runtimeKeyRef).agentRunning) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      const reconcilePatch: Partial<SessionRuntimeState> = {
        isCompacting: state?.isCompacting ?? false,
        queuedMessages: normalizeQueuedMessages(state?.queuedMessages),
      };
      patchRuntime(reconcilePatch);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !readRuntimeFor(runtimeKeyRef).agentRunning) return;
      if (state) {
        const patch: Partial<SessionRuntimeState> = {};
        if (state.contextUsage !== undefined) patch.contextUsage = state.contextUsage ?? null;
        if (state.systemPrompt !== undefined) patch.systemPrompt = state.systemPrompt ?? null;
        if (state.extensionStatuses !== undefined) patch.extensionStatuses = state.extensionStatuses ?? [];
        if (state.extensionWidgets !== undefined) patch.extensionWidgets = state.extensionWidgets ?? [];
        if (Object.keys(patch).length > 0) patchRuntime(patch);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, patchRuntime]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  // 确保全局 SSE 已连上（发 prompt 前调用，防漏 agent_start）。连接失败抛
  // EventStreamConnectionError，由 handleSend 的 catch 走乐观消息回滚 + 文本恢复。
  const ensureSseConnected = useCallback(async (sid: string) => {
    const status = await globalAgentEvents.ensureConnected(sid);
    if (status !== "connected") throw new EventStreamConnectionError(status);
  }, []);

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (readRuntimeFor(runtimeKeyRef).agentRunning || readRuntimeFor(runtimeKeyRef).bashRunning) return;
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    // 新会话尚无缓存条目（runtimeKey=newSessionCwd）：建最小占位承载乐观消息，
    // promote 后 loadSession(真id) 用文件数据覆盖。已有条目则追加。
    {
      const key = runtimeKeyRef.current;
      if (!sessionMessagesCache.has(key)) {
        setCachedSession(key, makeMinimalSessionData([userMsg]), undefined);
      } else {
        updateCachedSessionData(key, (sd) => ({
          ...sd,
          context: { ...sd.context, messages: [...sd.context.messages, userMsg] },
        }));
      }
    }
    patchRuntime({ optimisticUserMessageKey: userMessageKey(userMsg) });
    promptRunIdRef.current = promptRunId;
    patchRuntime({ agentRunning: true, agentPhase: isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" } });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      let sentSessionId: string | null = null;
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureSseConnected(sid);
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          promoteNewSession(1, message);
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureSseConnected(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      if (e instanceof EventStreamConnectionError) {
        const optimisticKey = readRuntimeFor(runtimeKeyRef).optimisticUserMessageKey;
        if (optimisticKey) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last?.role === "user" && userMessageKey(last) === optimisticKey
              ? prev.slice(0, -1)
              : prev;
          });
        }
        addNotice({ type: "error", message: e.message });
        // The prompt never reached the agent, so restore the user's text into
        // the input instead of losing it. Mirrors the shell-command recovery in
        // executeBash; insertIfEmpty avoids clobbering anything typed since.
        if (message) opts.chatInputRef?.current?.insertIfEmpty(message);
      }
      patchRuntime({ optimisticUserMessageKey: null, agentRunning: false, agentPhase: null });
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureSseConnected, promoteNewSession, waitForPromptSettlement, addNotice, opts.chatInputRef, patchRuntime, dispatch, setMessages]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (readRuntimeFor(runtimeKeyRef).agentRunning || readRuntimeFor(runtimeKeyRef).bashRunning) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    patchRuntime({ bashRunning: true, pendingBash: { command, excludeFromContext } });
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      patchRuntime({ bashRunning: false, pendingBash: null });
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session, patchRuntime]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (readRuntimeFor(runtimeKeyRef).bashRunning) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    if (readRuntimeFor(runtimeKeyRef).bashRunning) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    patchRuntime({ forkingEntryId: entryId });
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      patchRuntime({ forkingEntryId: null });
    }
  }, [onSessionForked, patchRuntime]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (readRuntimeFor(runtimeKeyRef).bashRunning) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    patchRuntime({ activeLeafId: entryId });
    await loadContext(sid, entryId);
  }, [loadContext, patchRuntime]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (readRuntimeFor(runtimeKeyRef).bashRunning) return;
    patchRuntime({ activeLeafId: leafId });
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext, patchRuntime]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      setPendingModel({ provider, modelId });
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      patchRuntime({ currentModelOverride: { provider, modelId } });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel, patchRuntime]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    patchRuntime({ isCompacting: true, compactError: null, compactResult: null });
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      patchRuntime({ compactResult: readCompactResult(result, "manual") });
      await loadSession(sid, true);
    } catch (e) {
      patchRuntime({ compactError: e instanceof Error ? e.message : String(e), compactResult: null });
    } finally {
      patchRuntime({ isCompacting: false });
    }
  }, [isCompacting, loadSession, patchRuntime]);

  // models 由全局 modelsStore 维护（useModels 自动拉取）；/reload 等显式刷新走这里。
  const reloadModels = useCallback(() => fetchModels(modelCwd, { force: true }), [modelCwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          patchRuntime({ isCompacting: true, compactError: null, compactResult: null });
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          patchRuntime({ compactResult: readCompactResult(result, "manual") });
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            reloadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            patchRuntime({ sessionStatsOverride: stats });
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") patchRuntime({ isCompacting: false });
    }
  }, [addNotice, ensureNewSession, isCompacting, reloadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen, patchRuntime]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to queue prompt:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      patchRuntime({ queuedMessages: { steering: [], followUp: [] } });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice, patchRuntime]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    patchRuntime({ thinkingLevel: level });
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [patchRuntime]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!readRuntimeFor(runtimeKeyRef).agentRunning) return;
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    completionScrollAllowedRef.current = false;
  }, []);

  // Load session whenever the active session id or reloadSignal changes. ChatWindow is
  // now session-stable (no key remount), so this effect drives loading on switch.
  useEffect(() => {
    // Same-session re-run (promote: the new-session key resolved to this real
    // id while its first prompt is already streaming, or reloadSignal refresh):
    // the run state in the store belongs to THIS session — resetting it here
    // would clobber agentRunning mid-run and make the event reducer drop every
    // subsequent SSE event (no streaming bubble, no message_end append, no
    // agent_end reload). Only a genuine session switch needs the bleed guard.
    const sameSession = session != null && sessionIdRef.current === session.id;
    if (!sameSession) {
      // Reset transient run-state from the previous session so it does not bleed
      // into the new one before loadSession applies fresh data.
      patchRuntime({ agentRunning: false, bashRunning: false, pendingBash: null, forkingEntryId: null, retryInfo: null });
      dispatch({ type: "reset" });
    }
    initialScrollDoneRef.current = false;

    // 解除上一个会话的 daemon pin（切走的会话不再需要专属事件流）。
    const prevPinned = pinnedDaemonSidRef.current;
    if (prevPinned && prevPinned !== session?.id) {
      pinnedDaemonSidRef.current = null;
      globalAgentEvents.unpinSession(prevPinned);
    }

    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        // daemon 拥有的会话（kit 轮 / subagent child）不在 web 进程的
        // running 集里，syncRunningIds 会把它们的 SSE 拆掉。pin 住：观看期间事件流
        // 一直连着（包括 gate 暂停期间，resume 后 agent_start 直接从这条流到达）。
        if (agentState?.liveInDaemon) {
          pinnedDaemonSidRef.current = session.id;
          globalAgentEvents.pinSession(session.id);
        }
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            patchRuntime({ agentRunning: true, agentPhase: agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" } });
            dispatch({ type: "start" });
            void globalAgentEvents.ensureConnected(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          } else if (agentState.liveInDaemon) {
            // Host 说 running 但 state 快照不可用（会话还在起动）。agent_start
            // 可能已经发过，不会再来了 —— 直接置 running，靠后续事件推进。
            patchRuntime({ agentRunning: true, agentPhase: { kind: "waiting_model" } });
            dispatch({ type: "start" });
          }
          if (agentState.state?.isBashRunning) {
            patchRuntime({ bashRunning: true });
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          const patch: Partial<SessionRuntimeState> = {};
          if (agentState.state.isCompacting !== undefined) patch.isCompacting = agentState.state.isCompacting;
          if (agentState.state.contextUsage !== undefined) patch.contextUsage = agentState.state.contextUsage ?? null;
          if (agentState.state.systemPrompt !== undefined) patch.systemPrompt = agentState.state.systemPrompt ?? null;
          if (agentState.state.thinkingLevel !== undefined) patch.thinkingLevel = (agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto";
          if (agentState.state.extensionStatuses !== undefined) patch.extensionStatuses = agentState.state.extensionStatuses ?? [];
          if (agentState.state.extensionWidgets !== undefined) patch.extensionWidgets = agentState.state.extensionWidgets ?? [];
          if (agentState.state.queuedMessages !== undefined) patch.queuedMessages = normalizeQueuedMessages(agentState.state.queuedMessages);
          if (Object.keys(patch).length > 0) patchRuntime(patch);
        }
      });
    } else {
      // session 为空（新建会话 / 切到无活跃会话的 workspace）：清空历史消息，
      // 否则单实例 ChatWindow 会残留上一个 session 的内容。
      sessionIdRef.current = null;
      setError(null);
      // data/messages/entryIds 由 cache 订阅驱动；清掉该 cwd 可能残留的临时条目 + runtime slice。
      dropCachedSession(runtimeKeyRef.current);
      setSessionRuntime(runtimeKeyRef.current, createDefaultSessionRuntimeState());
    }
    return () => {
      bashRecoveryIdRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, reloadSignal]);

  // 组件卸载时解除 daemon pin（切换到别的 workspace / 关闭 tab 等）。
  useEffect(() => {
    return () => {
      const pinned = pinnedDaemonSidRef.current;
      if (pinned) globalAgentEvents.unpinSession(pinned);
    };
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        // Just sent a prompt: jump to the bottom so the user message and the
        // incoming response stay in view as the stream progresses. We no longer
        // pin the user message to the top (which required a full-viewport blank
        // spacer below it); instead we follow the stream like most chat UIs.
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (completionScrollAllowedRef.current) {
        // Follow the latest content while streaming and on completion.
        // completionScrollAllowedRef is cleared when the user scrolls up to
        // read, pausing auto-follow until the next prompt is sent.
        scrollToBottom(agentRunning ? "instant" : "smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => patchRuntime({ compactError: null }), 3000);
    return () => clearTimeout(t);
  }, [compactError, patchRuntime]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => patchRuntime({ compactResult: null }), 6000);
    return () => clearTimeout(t);
  }, [compactResult, patchRuntime]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    patchRuntime({ sessionStatsOverride: null });
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow, patchRuntime]);

  // 对外 setter 包装（接口兼容；写入 store）。dispatch 仍为本 useReducer（B3c）。
  const setActiveLeafId = useCallback((id: string | null) => patchRuntime({ activeLeafId: id }), [patchRuntime]);
  const setForkingEntryId = useCallback((id: string | null) => patchRuntime({ forkingEntryId: id }), [patchRuntime]);
  const setAgentRunning = useCallback((v: boolean) => patchRuntime({ agentRunning: v }), [patchRuntime]);

  // 注册当前 active session 的 UI effect handlers 给全局 SSE 管理器（B4b）：后台 session
  // 事件写 store/cache；UI effects（notice / 对话框 / 完成音 / editor 注入 / slash 完成）
  // 只送达 active session。
  useEffect(() => {
    globalAgentEvents.setActive(runtimeKey, {
      onAgentEnd,
      addNotice,
      setExtensionDialog,
      resolveExtensionCustomUi: (request) => setExtensionCustomUi((current) =>
        request.closed ? (current?.id === request.id ? null : current) : request),
      editorInsertText: (text) => opts.chatInputRef?.current?.insertText(text),
      finishPromptWithoutStream: (sid) => void finishPromptWithoutStream(sid),
    });
    return () => { globalAgentEvents.setActive(null, null); };
  }, [runtimeKey, onAgentEnd, addNotice, setExtensionDialog, setExtensionCustomUi, finishPromptWithoutStream, opts.chatInputRef]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    liveInDaemon,
    agentRunning, modelNames, modelList, modelError, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    toolExecutionUpdates,
    // L3 tail window
    hasEarlierMessages, loadingEarlier, loadEarlier,
    isNew,
    // Refs
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
  };
}

// L3 runtime 派生字段解构（见上 return）由调用方直接读取。
