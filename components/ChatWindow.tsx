"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getDisplayableAssistantBlocks, splitFinalAssistantBlocks, splitThinkingBlocks } from "@/lib/message-display";
import { MessageView, ThinkingBlock, anyToolCallBlockExpanded } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { SessionChangedFilesDrawer } from "./SessionChangedFiles";
import { SessionSubagentsDrawer } from "./SessionSubagents";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useShell } from "./shell/context";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { deriveSessionChangedFiles } from "@/lib/session-changed-files";
import { deriveSessionSubagents } from "@/lib/session-subagents";
import type { SessionStatsInfo } from "@/lib/pi-types";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /** 会话搜索深跳转目标（上游 1cbd96f）：定位 entryId（+ blockIndex）并滚动
   *  高亮；完成后经 onSearchTargetHandled 注销。 */
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  reloadSignal?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  /** When true, renders as a compact view-oriented viewer (no input bar or
   *  minimap) — used when embedded in the right split pane. */
  embedded?: boolean;
  /** Overrides the composer draft key (default: session id or `new:<cwd>`).
   *  Used by the home new-session page: one home-scoped draft that survives
   *  workspace-selection changes. */
  draftKeyOverride?: string;
  /** Optional control rendered at the very LEFT of the composer controls row
   *  (before the attach-image button) — passed through to ChatInput's
   *  leadingControl. The home new-session page hosts its workspace selector
   *  there (next to the upload button, per user feedback). */
  inputLeadingControl?: React.ReactNode;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return t("chat.thinking");
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, hasExpandedChild, reveal, children, t }: { messageCount: number; toolCallCount: number; hasExpandedChild?: boolean; reveal?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  // 分组内的块在流式气泡里被展开过（如盯着看长 bash 输出），message_end 后块移入
  // 分组 —— 分组要跟着张开一次，否则展开的块藏进折叠头里，看起来仍是被收起。
  // 用户手动收起仍优先（只在 hasExpandedChild 翻 true 的那一次张开）。
  useEffect(() => {
    if (hasExpandedChild) setExpanded(true);
  }, [hasExpandedChild]);
  // 搜索深跳转命中分组内的消息：临时强制张开让高亮目标可见（上游 1cbd96f）。
  useLayoutEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded || reveal}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {(expanded || reveal) && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, newSessionCwd, searchTarget, onSearchTargetHandled, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, reloadSignal, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onOpenSession, embedded, draftKeyOverride, inputLeadingControl }: Props) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();
  // Composer prefill epoch from the shell state (contract prefill, D11) —
  // keys the ChatInput mount so a draft written while the input is already
  // mounted still gets picked up. ChatWindow only renders inside the shell
  // tree (DesktopShell / MobileShell), so the provider is always present.
  const { composerEpoch } = useShell();

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    toolExecutionUpdates,
    hasEarlierMessages, loadingEarlier, loadEarlier,
    isNew,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef,
    scrollToMessage,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, reloadSignal, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });

  const sessionBusy = agentRunning || bashRunning;

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);

  // Reset lazy-load window when switching sessions so the previous (possibly much
  // larger) accumulated visibleCount doesn't render hundreds of messages at once.
  useEffect(() => {
    setVisibleCount(VISIBLE_PAGE_SIZE);
  }, [session?.id, reloadSignal]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible: grow the local render window first; when the
  // whole loaded window is already rendered and the server has older messages
  // (L3 tail-first loading), fetch the next earlier page instead.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          if (visibleCount < messages.length) {
            setVisibleCount((prev) => getNextVisibleCount(prev));
          } else if (hasEarlierMessages && !loadingEarlier) {
            void loadEarlier();
          }
        }
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, hasEarlierMessages, loadingEarlier, loadEarlier, scrollContainerRef]);

  // Prepend detection (L3): when older messages arrive at the FRONT of the
  // list, grow the render window by the same amount so the top of the freshly
  // loaded page is visible (not re-clipped back to the tail). A replacement
  // whose head doesn't match the previous head at the expected offset is a
  // branch/context swap — reset the window instead.
  const prevWindowHeadRef = useRef<{ head: string | undefined; length: number }>({ head: undefined, length: 0 });
  useEffect(() => {
    const prev = prevWindowHeadRef.current;
    const head = entryIds[0];
    if (prev.head !== undefined && entryIds.length > prev.length) {
      const delta = entryIds.length - prev.length;
      if (entryIds[delta - 1] === prev.head || entryIds[delta] === prev.head) {
        // true prepend (entry inserted before the old head)
        setVisibleCount((count) => count + delta);
        prevWindowHeadRef.current = { head, length: entryIds.length };
        return;
      }
      if (head !== prev.head) {
        // different head entirely — new context window (branch switch / reload)
        setVisibleCount(VISIBLE_PAGE_SIZE);
        prevWindowHeadRef.current = { head, length: entryIds.length };
        return;
      }
    }
    prevWindowHeadRef.current = { head, length: entryIds.length };
  }, [entryIds]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);

  // --- 会话搜索深跳转（上游 1cbd96f）---
  // 命中 entry 不在当前窗口时，多翻一页更早的消息再找（上游语义：一页 200 条；
  // 更深或其他分支的命中只打开会话、不定位）。找到后放大渲染窗口到全覆盖，
  // 交由下方 useLayoutEffect 滚动 + 高亮。
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? (searchMessage.content as AssistantContentBlock[]).find((block) => block.type === "text")
      : (searchMessage.content as AssistantContentBlock[])[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, hasEarlierMessages, loadingEarlier });
  searchHistoryRef.current = { entryIds, hasEarlierMessages, loadingEarlier };

  useEffect(() => {
    if (!searchTarget || loading) return;
    let cancelled = false;
    const locate = async () => {
      let found = searchHistoryRef.current.entryIds.includes(searchTarget.entryId);
      if (!found && !sessionBusy && searchHistoryRef.current.hasEarlierMessages && !searchHistoryRef.current.loadingEarlier) {
        await loadEarlier(200);
        found = !cancelled && searchHistoryRef.current.entryIds.includes(searchTarget.entryId);
      }
      if (cancelled) return;
      if (found) {
        prevScrollDistanceRef.current = null;
        setVisibleCount((current) => Math.max(current, (searchHistoryRef.current.entryIds.length + 200) * 2));
        setPendingSearchScroll(searchTarget);
      } else {
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => { cancelled = true; };
  }, [searchTarget, loading, sessionBusy, loadEarlier, onSearchTargetHandled]);

  useLayoutEffect(() => {
    if (!pendingSearchScroll || pendingSearchScroll !== searchTarget) return;
    const selector = `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const element = scrollContainerRef.current?.querySelector<HTMLElement>(
      searchMessage?.role === "user" ? selector : `${selector} [data-search-target]`,
    );
    if (element) {
      scrollToMessage(element);
      element.animate([
        { backgroundColor: "var(--bg-selected)" },
        { backgroundColor: "transparent" },
      ], { duration: 2500 });
    }
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [pendingSearchScroll, searchTarget, searchMessage, scrollContainerRef, scrollToMessage, onSearchTargetHandled]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    chatInputRef?.current?.addImages(files);
  }, [sessionBusy, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = useMemo(() => messages.filter((m) => m.role === "user" || m.role === "assistant"), [messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  // Historical message rendering is O(messages). During streaming, ChatWindow
  // re-renders per token but `messages` is stable — without this cache it
  // rebuilds the whole list every token, freezing long sessions. The key
  // object changes identity only when an input that affects the render
  // changes, so the IIFE reuses the cached nodes while streaming.
  // toolExecutionUpdates must be a dep: a running tool that streams progress
  // (e.g. subagent) emits tool_execution_update events whose details carry the
  // child-session id + live trail. Those updates mutate toolExecutionUpdates
  // WITHOUT touching messages/entryIds/isStreaming, so omitting it makes the
  // cache below short-circuit the re-render — and the subagent panel / "open →"
  // button never appears while the subagent is running.
  const historyRenderKey = useMemo(() => ({}), [messages, entryIds, visibleCount, sessionBusy, isNew, streamState.isStreaming, forkingEntryId, modelNames, messageCwd, onOpenFile, handleFork, handleNavigate, handleEditContent, session?.id, t, toolExecutionUpdates, pendingSearchScroll]);
  const historyRenderCacheRef = useRef<{ key: object; nodes: ReactNode } | null>(null);

  // Partial tool results streamed via tool_execution_update, surfaced to the
  // currently-streaming message so running tool calls (e.g. subagents) show
  // live progress + child-session links before the final result lands.
  const streamingToolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const [id, partial] of Object.entries(toolExecutionUpdates ?? {})) {
      map.set(id, {
        role: "toolResult",
        toolCallId: id,
        content: partial.content as ToolResultMessage["content"],
        details: partial.details,
      });
    }
    return map;
  }, [toolExecutionUpdates]);

  // Files written/edited in this session — derived purely from the message
  // stream (incl. the streaming message) so the count updates in real time.
  // Full-session scope: `messages` is the complete list, not the lazy-load
  // `visibleCount` slice.
  const changedFiles = useMemo(
    () => deriveSessionChangedFiles(messages, {
      streamingMessage: streamState.streamingMessage,
      cwd: messageCwd,
    }),
    [messages, streamState.streamingMessage, messageCwd],
  );

  // Subagent children delegated in this session (delegate_task transport) —
  // the durable entry into child sessions, which are hidden from every
  // session list. Includes RUNNING delegations via the streaming partials.
  const sessionSubagents = useMemo(
    () => deriveSessionSubagents(messages, { streamingToolResults }),
    [messages, streamingToolResults],
  );

  // Drawer open state for the changed-files quick access — lifted here because
  // the entry button lives in ChatInput while the drawer overlay renders at
  // ChatWindow level. Not persisted; switching sessions closes it (agreed).
  const [changedFilesOpen, setChangedFilesOpen] = useState(false);
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  useEffect(() => {
    setChangedFilesOpen(false);
    setSubagentsOpen(false);
  }, [session?.id]);
  const toggleChangedFiles = useCallback(() => setChangedFilesOpen((v) => !v), []);
  const toggleSubagents = useCallback(() => setSubagentsOpen((v) => !v), []);

  const chatInputElement = (
    <ChatInput
      // Prefill epoch (contract prefill, D11): a handler may write the new-session
      // draft WHILE this input is already mounted on the same draftKey — the
      // key bump forces a remount so ChatInput re-reads the draft store.
      key={`composer-${composerEpoch}`}
      ref={chatInputRef}
      leadingControl={inputLeadingControl}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      onModelChange={handleModelChange}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      changedFiles={!embedded && onOpenFile ? { count: changedFiles.length, open: changedFilesOpen, onToggle: toggleChangedFiles } : undefined}
      subagents={!embedded && onOpenSession ? { count: sessionSubagents.length, open: subagentsOpen, onToggle: toggleSubagents } : undefined}
      draftKey={draftKeyOverride ?? session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !sessionBusy && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>Pi Web</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: (isMobile || embedded) ? 0 : CHAT_MINIMAP_WIDTH,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        <div ref={scrollContainerRef} className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]">
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            {(() => {
              const historyCache = historyRenderCacheRef.current;
              if (historyCache && historyCache.key === historyRenderKey) {
                return historyCache.nodes;
              }
              const toolResultsMap = new Map<string, ToolResultMessage>();
              for (const msg of messages) {
                if (msg.role === "toolResult") {
                  toolResultsMap.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
                }
              }
              // Merge live tool_execution_update partials for tool calls that
              // don't have a finalized result yet (e.g. running subagents), so
              // their inline progress / child-session links render during the run.
              // Real toolResult messages above always win.
              if (toolExecutionUpdates) {
                for (const [id, partial] of Object.entries(toolExecutionUpdates)) {
                  if (toolResultsMap.has(id)) continue;
                  toolResultsMap.set(id, {
                    role: "toolResult",
                    toolCallId: id,
                    content: partial.content as ToolResultMessage["content"],
                    details: partial.details,
                  });
                }
              }

              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              // Anchor for live-tail detection: the last user message, or a
              // compaction summary when compaction has replaced it mid-turn.
              // Computed independently from lastUserIdx (which is kept for the
              // scroll-to-user ref) because a compaction summary can sit after
              // the last user message and anchor the still-streaming segment.
              let lastAnchorIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (msg.role === "user" || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                // key 用 entryId（兼容 entryIds 缺位时退回 idx）：尾窗滑动 / loadEarlier
                // 前插会让 idx 整体平移，idx-key 会导致同一条消息被当成新元素重挂，
                // ToolCallBlock / ProcessDetailsGroup 的展开状态全部丢失。
                const entryKey = entryIds[idx] ?? idx;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${entryKey}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    onFork={sessionBusy || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={sessionBusy ? undefined : handleNavigate}
                    prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
                    onEditContent={handleEditContent}
                    onSendUserMessage={handleSend}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                  />
                );
                if (!isVisible || currentRefIdx === undefined) return view;
                return (
                  // data-entry-id：搜索深跳转的定位锚点（上游 1cbd96f）。attachRef=false
                  // 的消息（处理详情分组内）也要带锚点——命中可能落在分组里。
                  <div key={`${keyPrefix}-${entryKey}`} data-entry-id={entryIds[idx]} ref={options.attachRef === false ? undefined : attachVisibleRef(idx, currentRefIdx)}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                if (!isGroupAnchor(msg)) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }

                const userIdx = idx;
                let endIdx = userIdx + 1;
                while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                if (finalAssistantIdx === -1) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isLiveTail) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                rendered.push(renderMessage(userIdx));

                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                const finalAnswerMessage = finalSplit.answerBlocks.length > 0
                  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                  : null;

                // 分组内是否有用户展开着的 toolCall（含从流式气泡移入的）。思考块
                // 不再进分组（upstream #639：thinking 独立渲染），toolCall 只出现
                // 在非思考段里；这里仍按整回合收集，各分段组共享同一信号。
                const processToolCallIds: string[] = [];
                for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                  const pm = messages[processIdx];
                  if (pm.role === "assistant") {
                    for (const b of (pm as AssistantMessage).content) {
                      if (b.type === "toolCall") processToolCallIds.push((b as { toolCallId: string }).toolCallId);
                    }
                  }
                }
                for (const b of finalSplit.processBlocks) {
                  if (b.type === "toolCall") processToolCallIds.push((b as { toolCallId: string }).toolCallId);
                }
                const hasExpandedToolCall = anyToolCallBlockExpanded(processToolCallIds);

                let processViews: ReactNode[] = [];
                let processToolCount = 0;
                let processRefIdx: number | undefined;
                let processKey = "";
                let revealProcess = false;
                const flushProcess = () => {
                  if (processViews.length === 0) return;
                  const refIndex = processRefIdx;
                  rendered.push(
                    <div
                      // 同 renderMessage 的 entryKey 语义：key 用段内首条消息的
                      // entryId —— 尾窗滑动 / loadEarlier 前插时 idx 平移不再重挂
                      // 分段组，展开状态不丢。
                      key={`process-group-${processKey}`}
                      ref={refIndex === undefined ? undefined : (el) => { messageRefs.current[refIndex] = el; }}
                    >
                      <ProcessDetailsGroup
                        messageCount={processViews.length}
                        t={t}
                        reveal={revealProcess}
                        hasExpandedChild={hasExpandedToolCall}
                        toolCallCount={processToolCount}
                      >
                        {processViews}
                      </ProcessDetailsGroup>
                    </div>,
                  );
                  processViews = [];
                  processToolCount = 0;
                  processRefIdx = undefined;
                  revealProcess = false;
                };

                // Flush each process segment before its next thinking block so
                // reasoning stays outside the fold without reordering the turn
                // (upstream #639).
                for (let processIdx = userIdx + 1; processIdx <= finalAssistantIdx; processIdx++) {
                  const processMessage = messages[processIdx];
                  const messageKey = entryIds[processIdx] ?? processIdx;
                  if (processMessage.role === "custom") {
                    if (processViews.length === 0) processKey = String(messageKey);
                    revealProcess ||= Boolean(pendingSearchScroll && pendingSearchScroll.entryId === entryIds[processIdx]);
                    processViews.push(renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }));
                    continue;
                  }
                  if (processMessage.role !== "assistant") continue;
                  const blocks = processIdx === finalAssistantIdx ? finalSplit.processBlocks : getDisplayableAssistantBlocks(processMessage);
                  const groups = splitThinkingBlocks(blocks);
                  const lastProcessGroup = groups.findLast((group) => !group.thinking);
                  for (const group of groups) {
                    const blockIndex = processMessage.content.indexOf(group.blocks[0]);
                    const key = `${messageKey}-${blockIndex}`;
                    if (group.thinking) {
                      flushProcess();
                      const previousTimestamp = (messages[processIdx - 1] as (AgentMessage & { timestamp?: number }) | undefined)?.timestamp;
                      const processTimestamp = (processMessage as AgentMessage & { timestamp?: number }).timestamp;
                      const duration = processTimestamp && previousTimestamp
                        ? Math.round((processTimestamp - previousTimestamp) / 1000)
                        : 0;
                      const refIndex = visibleRefIndexByMessage.get(processIdx);
                      rendered.push(
                        <div key={`thinking-${key}`} style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }} ref={refIndex === undefined ? undefined : (el) => { messageRefs.current[refIndex] = el; }}>
                          {group.blocks.map((block) => block.type === "thinking" && (
                            <ThinkingBlock key={processMessage.content.indexOf(block)} block={block} blockIndex={processMessage.content.indexOf(block)} entryId={entryIds[processIdx]} sessionId={session?.id ?? sessionIdRef.current ?? undefined} duration={duration > 0 ? duration : undefined} />
                          ))}
                        </div>,
                      );
                    } else {
                      if (processViews.length === 0) processKey = key;
                      processRefIdx ??= visibleRefIndexByMessage.get(processIdx);
                      processToolCount += countToolCallBlocks(group.blocks);
                      revealProcess ||= Boolean(pendingSearchScroll && entryIds[processIdx] === pendingSearchScroll.entryId && (!searchBlock || group.blocks.includes(searchBlock)));
                      processViews.push(renderMessage(processIdx, {
                        attachRef: false,
                        keyPrefix: `process-${blockIndex}`,
                        messageOverride: withAssistantBlocks(processMessage, group.blocks, { omitUsage: processIdx === finalAssistantIdx || group !== lastProcessGroup }),
                        showTimestamp: false,
                      }));
                    }
                  }
                }
                flushProcess();

                if (finalAnswerMessage) {
                  rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage }));
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                idx = endIdx;
              }
              const { startIndex, hasMore } = getVisibleRenderWindow(rendered.length, visibleCount);
              const nodes = (
                <>
                  {(hasMore || hasEarlierMessages) && (
                     <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                      {loadingEarlier
                        ? t("chat.loading")
                        : hasMore
                          ? t("chat.loadEarlier", { count: startIndex })
                          : t("chat.loadEarlierCount", { count: 100 })}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
              historyRenderCacheRef.current = { key: historyRenderKey, nodes };
              return nodes;
            })()}
            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming toolResults={streamingToolResults} modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
            )}

            {agentRunning && !streamState.streamingMessage && (
              <div className="py-2 text-[13px] text-text-muted" data-dbg-running>
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}
            </div>
          </div>
        </div>
        {(embedded || isMobile) ? null : (
          <ChatMinimap
            messages={messages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
          />
        )}
      </div>

      {!embedded && (
      <div className="relative">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
        {!embedded && onOpenFile ? (
          <SessionChangedFilesDrawer
            files={changedFiles}
            open={changedFilesOpen}
            onClose={() => setChangedFilesOpen(false)}
            cwd={messageCwd}
            onOpenFile={onOpenFile}
            variant={isMobile ? "mobile" : "desktop"}
          />
        ) : null}
        {!embedded && onOpenSession ? (
          <SessionSubagentsDrawer
            subs={sessionSubagents}
            open={subagentsOpen}
            onClose={() => setSubagentsOpen(false)}
            onOpenSession={onOpenSession}
            variant={isMobile ? "mobile" : "desktop"}
          />
        ) : null}
        <ExtensionStatusBar statuses={extensionStatuses} />
      </div>
      )}
      </>
      )}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
