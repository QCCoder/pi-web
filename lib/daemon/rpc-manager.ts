import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "../image-attachments";
import { invalidateModelsCache } from "../models-cache";
import { cacheSessionPath, invalidateSessionListCache } from "../session-reader";
import { getProjectTrustStatus, projectTrustReloadOptions } from "../project-trust";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "../pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "../types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "../custom-ui-terminal";
import { buildWorkspaceExtensions } from "../workspaces/extensions";
import { piSubagentExtension } from "./pi-subagent-host.ts";
import { raceAbort } from "../abort-race";
import { buildStalledSnapshot, classifyStall, HEARTBEAT_TICK_MS, stallInterruptMessage, type StalledSessionInfo } from "./session-heartbeat";
import { findWorkspaceForPath } from "../workspaces/service";
import { notifySessionComplete } from "../web-push";
import { isSubagentChildSession } from "../subagent-child";

// ============================================================================
// SESSION REGISTRY — daemon-process code only (C2 Phase 3)
// ============================================================================
// This module owns every AgentSession in the pi-daemon process
// (bin/pi-daemon.js). NO web-process code may import it: the Next.js routes are
// pure proxies (lib/agent-proxy.ts → lib/daemon/client.ts) and the web side
// never touches a live session. If a web route needs something from here, it
// must be exposed as a daemon route (lib/daemon/host.ts) and called through the
// client instead.
// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

/** Fired once per agent run, when the session settles with nothing left
 *  running — the Web Push completion trigger (upstream #496). */
type AgentRunCompleteListener = (sessionId: string) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Extensions require a complete Theme, while the web UI applies its own styling.
//
// pi 0.84's Theme constructor synthesizes optional colors from fallbacks
// (e.g. `searchMatchText: fgColors.searchMatchText ?? fgColors.text`) and
// feeds every resulting entry to fgAnsi()/bgAnsi(), so a partial record
// crashes on the undefined fallback (0.82 only iterated provided keys).
// "" is a valid color value that maps to the default fg/bg escape sequence,
// and every rendering method below is overridden to plain-text passthrough,
// so these values are never actually rendered. The records are complete
// literals (no casts) so tsc fails loudly if the SDK adds new required colors.
const PLAIN_TEXT_FG_COLORS = {
  accent: "",
  border: "",
  borderAccent: "",
  borderMuted: "",
  success: "",
  error: "",
  warning: "",
  muted: "",
  dim: "",
  text: "",
  thinkingText: "",
  userMessageText: "",
  customMessageText: "",
  customMessageLabel: "",
  toolTitle: "",
  toolOutput: "",
  mdHeading: "",
  mdLink: "",
  mdLinkUrl: "",
  mdCode: "",
  mdCodeBlock: "",
  mdCodeBlockBorder: "",
  mdQuote: "",
  mdQuoteBorder: "",
  mdHr: "",
  mdListBullet: "",
  toolDiffAdded: "",
  toolDiffRemoved: "",
  toolDiffContext: "",
  syntaxComment: "",
  syntaxKeyword: "",
  syntaxFunction: "",
  syntaxVariable: "",
  syntaxString: "",
  syntaxNumber: "",
  syntaxType: "",
  syntaxOperator: "",
  syntaxPunctuation: "",
  thinkingOff: "",
  thinkingMinimal: "",
  thinkingLow: "",
  thinkingMedium: "",
  thinkingHigh: "",
  thinkingXhigh: "",
  bashMode: "",
} satisfies ConstructorParameters<typeof Theme>[0];

const PLAIN_TEXT_BG_COLORS = {
  selectedBg: "",
  userMessageBg: "",
  customMessageBg: "",
  toolPendingBg: "",
  toolSuccessBg: "",
  toolErrorBg: "",
} satisfies ConstructorParameters<typeof Theme>[1];

class PlainTextTheme extends Theme {
  constructor() {
    super(PLAIN_TEXT_FG_COLORS, PLAIN_TEXT_BG_COLORS, "truecolor");
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !codingToolNames.has(name));

  return [...new Set([...toolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallbacks: Array<() => void> = [];
  /** Guards session_shutdown against double emission when shutdown is
   *  delivered out of band and destroy() only finishes the dispose. */
  private sessionShutdownEmitted = false;
  private _alive = true;
  /** Set on agent_start, consumed by notifyAgentRunCompleteIfIdle when the
   *  run settles — gates completion pushes to runs that actually started. */
  private agentRunNeedsCompletion = false;
  /** Heartbeat: last time this session showed life — any agent event (streaming
   *  delta, tool-execution partial, message boundary) or inbound command. The
   *  heartbeat monitor (see startSessionHeartbeatMonitor) interrupts a session
   *  that claims `running` but has been silent past STALL_KILL_MS — the
   *  4-hour-zombie class nothing else notices. */
  private lastActivityAt = Date.now();

  constructor(
    public readonly inner: AgentSessionLike,
    private readonly onAgentRunComplete?: AgentRunCompleteListener,
  ) {}

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      this.lastActivityAt = Date.now();
      if (event.type === "agent_start") this.agentRunNeedsCompletion = true;
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      this.emit(event);
      if (event.type === "agent_settled") this.notifyAgentRunCompleteIfIdle();
      // Streaming / compaction / tool events flow through here; re-broadcast
      // the running-status snapshot so the sidebar can update live.
      notifyRunningChange();
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /** Fire-and-forget the completion push once a started run has fully settled
   *  (queue drained, nothing streaming/compacting/bash). Never throws into the
   *  event stream — push failures must not touch the session's main flow. */
  private notifyAgentRunCompleteIfIdle(): void {
    if (!this.agentRunNeedsCompletion || this.isRunning()) return;
    this.agentRunNeedsCompletion = false;
    try {
      this.onAgentRunComplete?.(this.sessionId);
    } catch (error) {
      console.error("[pi-web] completion listener failed:", error instanceof Error ? error.message : error);
    }
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt" || type === "steer" || type === "follow_up" || type === "get_commands";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = "";
    }
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      this.destroy();
    }, 10 * 60 * 1000);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // Pi normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): () => void {
    this.onDestroyCallbacks.push(cb);
    return () => {
      const i = this.onDestroyCallbacks.indexOf(cb);
      if (i !== -1) this.onDestroyCallbacks.splice(i, 1);
    };
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    this.lastActivityAt = Date.now();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        this.promptRunning = true;
        this.agentRunNeedsCompletion = true;
        notifyRunningChange();
        this.inner.prompt(command.message as string, {
          ...(promptImages?.length ? { images: promptImages } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
          source: "rpc",
        }).then(() => {
          this.promptRunning = false;
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
          // agent_settled 从 SDK 到达时 prompt promise 往往还未落定
          // （isRunning() 仍为 true 会跳过），落定后再补一次完成判定。
          this.notifyAgentRunCompleteIfIdle();
        }).catch((error) => {
          this.promptRunning = false;
          invalidateSessionListCache();
          this.emit({
            type: "prompt_error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
          this.notifyAgentRunCompleteIfIdle();
        });
        return null;
      }

      case "abort":
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          /** Heartbeat: ms since the last agent event / command while running
           *  (null when idle). >= STALL_WARN_MS means 疑似无响应. */
          stalledMs: this.isRunning() ? this.activityIdleMs() : null,
          /** >= STALL_WARN_MS (5 min) means 疑似无响应. */
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = command.toolNames as string[];
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        this.syncProjectTrust();
        await this.inner.reload();
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        this.applyForcedEmptySystemPrompt();
        invalidateModelsCache();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  /** ms since the last sign of life (see lastActivityAt). */
  activityIdleMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  /** Emit a synthetic prompt_error to live viewers WITHOUT persisting it — used
   *  by the heartbeat monitor so a watching human sees WHY an auto-interrupt
   *  happened (the .jsonl cannot record it: the hung turn never settles). */
  emitSyntheticError(errorMessage: string): void {
    this.emit({ type: "prompt_error", errorMessage });
  }

  /** True while an extension UI request (confirm/select/input/editor/custom)
   *  awaits a human response. Such a session is human-paused, not hung — the
   *  heartbeat monitor must not auto-interrupt it (a human-wait can last
   *  arbitrarily long, same reasoning as gate-paused sessions). Fire-and-forget
   *  UI methods (notify/setStatus/setWidget) never enter the map; only requests
   *  that block a tool on a response do. */
  hasPendingUiRequests(): boolean {
    return this.pendingUiRequests.size > 0;
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    // Abort an in-flight agent run. Without this, a destroy that happens mid-run
    // (Loop round timeout/abort, session idle-timeout during a slow round) only
    // unsubscribes events and removes the wrapper from the registry — the inner
    // prompt keeps executing in the background (a "zombie" round that keeps
    // writing the .jsonl, spawning subagents and burning tokens while every
    // surface — running badge, SSE probe, run status — says it is gone).
    if (this.promptRunning || this.inner.isStreaming) {
      void this.inner.abort().catch(() => { /* already settling */ });
    }
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();

    const finishDispose = () => {
      try {
        // SDK dispose aborts retry/compaction/bash, invalidates the extension
        // runner and runs the registered per-session resource cleanups (MCP
        // children and friends). In a long-lived daemon, skipping it leaks
        // those resources for every session torn down here.
        this.inner.dispose?.();
      } finally {
        for (const cb of [...this.onDestroyCallbacks]) cb();
        notifyRunningChange();
      }
    };

    // Every dispose path funnels through destroy() (idle timeout, heartbeat
    // kill, session delete, fork-destroy, process exit), so notifying
    // extensions here covers them all (upstream d728526): without
    // session_shutdown, extensions holding per-session resources (MCP child
    // processes) never reap them. Await when possible so handlers finish
    // before the runner is invalidated; a handler that never settles only
    // defers dispose, it cannot resurrect the wrapper.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }
    this.sessionShutdownEmitted = true;
    const runner = this.inner.extensionRunner;
    const emit = runner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }
    void (async () => emit.call(runner, { type: "session_shutdown", reason: "quit" }))()
      .catch((error) => {
        console.error(
          "[pi-web] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.applyForcedEmptySystemPrompt();
      },
    };
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    startSessionHeartbeatMonitor();
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export function destroyRpcSessionsForCwd(cwd: string): number {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  for (const session of sessions) session.destroy();
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/** Stalled snapshot of currently-RUNNING sessions (see lib/session-heartbeat.ts):
 *  sessions silent past STALL_WARN_MS, classified and sorted longest-idle first.
 *  Exposed via the daemon's running endpoints for surfacing (badge/tooltip) —
 *  additive data, existing consumers that only read `ids` are unaffected. */
export function getStalledSessionSnapshot(): StalledSessionInfo[] {
  const running = Array.from(getRegistry().values())
    .filter((session) => session.isRunning())
    .map((session) => ({ id: session.sessionId, idleMs: session.activityIdleMs() }));
  return buildStalledSnapshot(running);
}

// ----------------------------------------------------------------------------
// Heartbeat monitor — the zombie-session safety net
//
// A session can claim `running` forever while being hung (stuck network call,
// an extension awaiting something that never comes, a tool ignoring its abort
// signal) — every surface keeps showing the spinner, the file stops growing,
// and nothing ever notices (REQ-0026: 4 silent hours). The monitor interrupts
// such sessions automatically once they cross STALL_KILL_MS: a synthetic
// prompt_error tells live viewers why, then destroy() aborts the in-flight
// prompt and drops the wrapper — badges clear, the human resends to resume.
// Daemon-process only (this module never loads in the web server); the
// interval is unref'd so it never keeps the process alive. Gate-paused
// sessions are NOT running and are never touched; sessions with a pending
// extension UI request (confirm/select/…) are running but human-paused —
// likewise exempt (AgentSessionWrapper.hasPendingUiRequests); creation-phase
// hangs are bounded separately by StartSessionOptions.signal / raceAbort.
// ----------------------------------------------------------------------------

function startSessionHeartbeatMonitor(): void {
  const g = globalThis as { __piHeartbeatMonitor?: ReturnType<typeof setInterval> };
  if (g.__piHeartbeatMonitor) return;
  const timer = setInterval(() => {
    for (const [key, session] of getRegistry()) {
      if (!session.isRunning()) continue;
      // Awaiting a human answer on an extension dialog — not a zombie. The
      // pending request is replayed to any (re)connecting viewer (see the
      // subscribe path), so it stays answerable however long the wait is.
      if (session.hasPendingUiRequests()) continue;
      const idleMs = session.activityIdleMs();
      if (classifyStall(idleMs) !== "kill") continue;
      const sid = session.sessionId || key;
      const minutes = Math.round(idleMs / 60_000);
      console.error(
        `[pi-web] session ${sid} still running but silent for ${minutes}min — auto-interrupting (heartbeat monitor); resend to resume`,
      );
      session.emitSyntheticError(stallInterruptMessage(idleMs));
      session.destroy();
    }
  }, HEARTBEAT_TICK_MS);
  timer.unref?.();
  g.__piHeartbeatMonitor = timer;
}

export interface LiveRpcSessionInfo {
  id: string;
  cwd: string;
  sessionFile: string;
}

/**
 * Minimal info for every alive RPC session, including brand-new sessions whose
 * .jsonl file has not been flushed to disk yet (pi delays the first flush until
 * an assistant message exists). Used to merge in-memory sessions into the
 * session list so they appear immediately instead of waiting for the disk scan
 * cache to expire.
 */
export function getLiveRpcSessionInfos(): LiveRpcSessionInfo[] {
  return Array.from(getRegistry().values())
    .filter((session) => session.isAlive())
    .map((session) => ({
      id: session.sessionId,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
    }));
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers. Cheap to call often.
 */
function notifyRunningChange(): void {
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of getRunningListeners()) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
/** Extra options for creating a child session in-process. */
export interface StartSessionOptions {
  /** Link this session to a parent session file (sidebar nests it as a child). */
  parentSession?: string;
  /** Append this text to the session's system prompt (e.g. a subagent role prompt). */
  appendSystemPrompt?: string;
  /** Explicit model to use instead of the saved/default model.
   *  Provider may be omitted to resolve a bare model id (e.g. agent frontmatter
   *  `model: claude-haiku-4-5`) against the model registry. */
  model?: { provider?: string; modelId: string };
  /** Abort session creation. The returned promise rejects promptly when the
   *  signal fires — including while creation is hung on something internal
   *  (e.g. a stuck network call during model resolution) that no timeout of
   *  its own exists for. JS promises cannot be cancelled, so creation keeps
   *  running in the background; if it eventually completes anyway, the
   *  wrapper is destroyed immediately so no live zombie stays in the
   *  registry (see raceAbort's onLateSettle). */
  signal?: AbortSignal;
}

export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  options?: StartSessionOptions,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  // Never even start on an already-aborted signal — the caller has moved on.
  if (options?.signal?.aborted) throw new Error("aborted");

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  // New sessions are requested with sessionId "" — key the start-lock by a
  // fresh one-time id instead. Keying by "" itself made concurrent creations
  // (e.g. parallel subagent workers) coalesce onto the FIRST session: the
  // second caller silently received the first caller's promise, so multiple
  // workers wrote into one shared child session.
  const lockKey = sessionId || `__new__${randomUUID()}`;
  const inflight = locks.get(lockKey);
  if (inflight) return inflight;

  const finishStartingSession = trackStartingSession(cwd);
  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    initTheme();
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(
          cwd,
          undefined,
          options?.parentSession ? { parentSession: options.parentSession } : undefined,
        );

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined;
    if (toolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in Pi Web sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = toolNames.length === 0 ? [] : undefined;
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    // Gate untrusted project extensions so opening a repository does not run
    // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
    const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
    const workspace = await findWorkspaceForPath(cwd);
    const selectedWorkspaceSkills = new Set(workspace?.manifest.skills ?? []);
    // `subagent` is a global capability: every session gets the community
    // package's `delegate_task` tool regardless of workspace or capability
    // toggles (lib/daemon/pi-subagent-host.ts — the former built-in
    // lib/subagent was deleted). Roles come from the package's own discovery:
    // built-in implementer/reviewer < project `<cwd>/.pi/agents/pi-subagent/`
    // < user `~/.pi/agent/config/pi-subagent/`. Loop sessions run with
    // cwd = workspace root, so a workspace's roles load with no extra wiring.
    const extensionFactories = [await piSubagentExtension()];
    const resourceLoaderOptions: Record<string, unknown> = workspace
      ? {
          extensionFactories: [...extensionFactories, ...buildWorkspaceExtensions(workspace.manifest, workspace.path)],
          ...(selectedWorkspaceSkills.size > 0
            ? {
                skillsOverride: (base: { skills: Array<{ name: string }> }) => ({
                  ...base,
                  skills: base.skills.filter((skill) => selectedWorkspaceSkills.has(skill.name)),
                }),
              }
            : {}),
        }
      : { extensionFactories };
    if (options?.appendSystemPrompt) {
      resourceLoaderOptions.appendSystemPrompt = [options.appendSystemPrompt];
    }
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(Object.keys(resourceLoaderOptions).length > 0 ? { resourceLoaderOptions } : {}),
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    let modelOption: ReturnType<typeof services.modelRuntime.getModel>;
    if (options?.model) {
      const { provider, modelId } = options.model;
      modelOption = provider
        ? services.modelRuntime.getModel(provider, modelId)
        : services.modelRuntime.getModels().find((m) => m.id === modelId);
    }
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
      ...(modelOption ? { model: modelOption } : {}),
    });

    // If specific tool names were requested (non-empty), set the active tools to the
    // requested builtin coding tools PLUS all extension/package tools, so installed
    // extensions stay usable in Pi Web just like in the `pi` CLI.
    if (toolNames && toolNames.length > 0) {
      inner.setActiveToolsByName(withExtensionTools(inner, toolNames));
    }

    const wrapper = new AgentSessionWrapper(inner, (completedSessionId) => {
      // Subagent children are internal work — completing them is not a
      // "your session is done" moment for the human (upstream suppresses
      // them the same way via suppressCompletionNotifications).
      if (isSubagentChildSession({ id: completedSessionId, name: inner.sessionManager.getSessionName() })) return;
      void notifySessionComplete(completedSessionId).catch((error) => {
        console.error("[pi-web] failed to send completion push:", error instanceof Error ? error.message : error);
      });
    });
    // When all tools are disabled, clear the system prompt entirely.
    // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // keep this forced after extension resource discovery and reloads as well.
    if (toolNames?.length === 0) {
      wrapper.setForceEmptySystemPrompt(true);
    }
    wrapper.start();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);
    wrapper.beginExtensionBinding({ forceEmptySystemPrompt: toolNames?.length === 0 });

    return { session: wrapper, realSessionId };
  })();

  // Abortable creation: stop waiting the moment the signal fires. A creation
  // that completes afterwards registers a live wrapper nobody owns anymore —
  // destroy it on arrival so it cannot linger in the registry (idle timer,
  // running badge, reopenable by id) as a zombie.
  const result = options?.signal
    ? raceAbort(starting, options.signal, { onLateSettle: (value) => value.session.destroy() })
    : starting;

  // Lock cleanup follows the *raced* promise: on abort it settles long before
  // (possibly instead of) the underlying creation, and the lock must not leak
  // in that case. The no-op handlers keep the rejection handled by this chain.
  const cleanup = (): void => {
    locks.delete(lockKey);
    finishStartingSession();
  };
  result.then(cleanup, cleanup);

  locks.set(lockKey, result);
  return result;
}
