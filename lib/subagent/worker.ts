/**
 * Spawn real, in-process child AgentSessions for the subagent tool.
 *
 * Each worker is a genuine first-class session — same creation path as any
 * Pi Web session — linked to its parent via `parentSession`. That makes it:
 *   - hidden from the sidebar list (openable only from the parent's subagent
 *     result card, not as a standalone conversation),
 *   - openable as a chat tab with LIVE streaming (it is in the in-process
 *     registry, so opening it reconnects to the running session),
 *   - fully inspectable afterwards (persisted to its own .jsonl).
 *
 * Internal steps are NOT copied into the parent; only streamed status + the
 * final result text return here. The full subagent conversation lives in its
 * own viewable session. We additionally capture per-agent usage stats and a
 * compact display-item trail (assistant text + tool calls) so the parent can
 * render an official-style progress/result view without opening the child.
 */
import type { AgentConfig } from "./agents.ts";
import type { AgentEvent, AgentSessionWrapper } from "../rpc-manager.ts";
import { startRpcSession } from "../rpc-manager.ts";
import { markSubagentChild } from "./registry.ts";

const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Cap the display-item trail we stream per update (bounds SSE bandwidth). */
const STREAM_ITEM_CAP = 12;

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface WorkerResult {
  agent: string;
  task: string;
  source: string;
  /** Final assistant text produced by the worker. */
  output: string;
  turns: number;
  model?: string;
  /** Id of the child session — open it in the UI to view the full subagent run. */
  childSessionId: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  usage: UsageStats;
  /** Compact trail of assistant text + tool calls, for inline display. */
  displayItems: DisplayItem[];
}

export interface WorkerDetails {
  agent: string;
  task: string;
  source: string;
  turns: number;
  model?: string;
  childSessionId: string;
  status: "running" | "completed" | "failed";
  usage: UsageStats;
  /** Last STREAM_ITEM_CAP display items (streamed; full trail in the result). */
  displayItems: DisplayItem[];
}

export interface ModelSpec {
  /** Provider id. When omitted, resolved from the model registry by modelId. */
  provider?: string;
  modelId: string;
}

/** Parse an agent `model` frontmatter value.
 *
 * Accepts either a bare model id (e.g. "claude-haiku-4-5", resolved against the
 * model registry at runtime) or "provider/modelId". Returns undefined for empty. */
export function parseModelSpec(spec: string | undefined): ModelSpec | undefined {
  if (!spec) return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return { modelId: trimmed };
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

const EMPTY_USAGE: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

interface AssistantMessageLike {
  content?: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
}

function lastAssistantText(message: AssistantMessageLike): string {
  for (const part of message.content ?? []) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text;
  }
  return "";
}

function extractDisplayItems(message: AssistantMessageLike): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      items.push({ type: "text", text: part.text });
    } else if (part.type === "toolCall" && typeof part.name === "string") {
      items.push({ type: "toolCall", name: part.name, args: part.arguments ?? {} });
    }
  }
  return items;
}

export function isFailedResult(result: WorkerResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

interface RunState {
  turns: number;
  model?: string;
  usage: UsageStats;
  displayItems: DisplayItem[];
  lastText: string;
}

interface PromptOutcome {
  output: string;
  errorMessage?: string;
  state: RunState;
}

function capturePrompt(
  session: AgentSessionWrapper,
  task: string,
  onProgress: ((state: RunState) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<PromptOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const state: RunState = { turns: 0, usage: { ...EMPTY_USAGE }, displayItems: [], lastText: "" };
    let off: () => void = () => {};

    const finish = (outcome: { output: string; errorMessage?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve({ output: outcome.output, errorMessage: outcome.errorMessage, state });
    };

    const timer = setTimeout(() => finish({ output: "", errorMessage: "subagent timed out" }), RUN_TIMEOUT_MS);
    timer.unref?.();

    if (signal?.aborted) {
      finish({ output: "", errorMessage: "aborted" });
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        void session.send({ type: "abort" }).catch(() => {});
        finish({ output: "", errorMessage: "aborted" });
      },
      { once: true },
    );

    off = session.onEvent((event: AgentEvent) => {
      if (event.type === "message_end") {
        const message = event.message as AssistantMessageLike | undefined;
        if (message) {
          if (event.message && (event.message as { role?: string }).role === "assistant") {
            state.turns++;
            state.usage.turns = state.turns;
            if (!state.model && message.model) state.model = message.model;
            const u = message.usage;
            if (u) {
              state.usage.input += u.input ?? 0;
              state.usage.output += u.output ?? 0;
              state.usage.cacheRead += u.cacheRead ?? 0;
              state.usage.cacheWrite += u.cacheWrite ?? 0;
              state.usage.cost += u.cost?.total ?? 0;
              state.usage.contextTokens = u.totalTokens ?? state.usage.contextTokens;
            }
            state.displayItems.push(...extractDisplayItems(message));
            state.lastText = lastAssistantText(message);
            onProgress?.(state);
          }
        }
      }
      if (event.type === "prompt_error") {
        finish({ output: "", errorMessage: (event.errorMessage as string | undefined) ?? "pi prompt failed" });
      }
      if (event.type === "prompt_done") {
        void session
          .send({ type: "get_last_assistant_text" })
          .then((value) => finish({ output: (value as { text?: string }).text ?? "" }))
          .catch(() => finish({ output: state.lastText }));
      }
    });

    void session
      .send({ type: "prompt", message: `Task: ${task}`, source: "rpc" })
      .catch((error: unknown) => finish({ output: "", errorMessage: error instanceof Error ? error.message : String(error) }));
  });
}

export interface RunWorkerOptions {
  agent: AgentConfig;
  task: string;
  cwd: string;
  /** Parent session file, used to nest the child in the sidebar. */
  parentSessionFile: string;
  /** Parent's current model, inherited when the agent defines no model. */
  parentModel?: ModelSpec;
  signal?: AbortSignal;
  onUpdate?: (partial: { text: string; details: WorkerDetails }) => void;
}

export async function runWorker(opts: RunWorkerOptions): Promise<WorkerResult> {
  const modelSpec = parseModelSpec(opts.agent.model) ?? opts.parentModel;
  const { session, realSessionId } = await startRpcSession(
    "",
    "",
    opts.cwd,
    opts.agent.tools,
    {
      parentSession: opts.parentSessionFile || undefined,
      appendSystemPrompt: opts.agent.systemPrompt || undefined,
      ...(modelSpec ? { model: modelSpec } : {}),
    },
  );
  // Mark this child so the session list hides it; it is still openable by id
  // from the parent's subagent result card (see ./registry.ts).
  markSubagentChild(realSessionId);

  const toDetails = (state: RunState, status: WorkerDetails["status"]): WorkerDetails => ({
    agent: opts.agent.name,
    task: opts.task,
    source: opts.agent.source,
    turns: state.turns,
    model: state.model,
    childSessionId: realSessionId,
    status,
    usage: { ...state.usage },
    displayItems: state.displayItems.slice(-STREAM_ITEM_CAP),
  });

  const emit = (state: RunState): void => {
    opts.onUpdate?.({
      text: state.lastText || "(running…)",
      details: toDetails(state, "running"),
    });
  };

  try {
    const outcome = await capturePrompt(session, opts.task, emit, opts.signal);
    const failed = Boolean(outcome.errorMessage);
    return {
      agent: opts.agent.name,
      task: opts.task,
      source: opts.agent.source,
      output: outcome.output || "(no output)",
      turns: outcome.state.turns,
      model: outcome.state.model,
      childSessionId: realSessionId,
      exitCode: failed ? 1 : 0,
      stopReason: failed ? "error" : "end",
      errorMessage: outcome.errorMessage,
      usage: outcome.state.usage,
      displayItems: outcome.state.displayItems,
    };
  } catch (error) {
    return {
      agent: opts.agent.name,
      task: opts.task,
      source: opts.agent.source,
      output: "",
      turns: 0,
      childSessionId: realSessionId,
      exitCode: 1,
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      usage: { ...EMPTY_USAGE },
      displayItems: [],
    };
  }
  // Note: the child session is intentionally left alive (in-process + persisted)
  // so it remains openable/viewable. The idle timer reaps the wrapper; the file
  // persists for later browsing.
}

async function mapWithConcurrency<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOut>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ParallelTask {
  agent: AgentConfig;
  task: string;
  cwd: string;
}

export interface ParallelContext {
  parentSessionFile: string;
  parentModel?: ModelSpec;
  signal?: AbortSignal;
}

/**
 * Run multiple child sessions concurrently with an aggregate streaming status.
 * Each task gets its own viewable child session.
 */
export async function runParallel(
  tasks: ParallelTask[],
  concurrency: number,
  context: ParallelContext,
  onUpdate: ((partial: { text: string; details: { mode: "parallel"; results: WorkerResult[] } }) => void) | undefined,
): Promise<WorkerResult[]> {
  const all: WorkerResult[] = tasks.map((t) => ({
    agent: t.agent.name,
    task: t.task,
    source: t.agent.source,
    output: "",
    turns: 0,
    childSessionId: "",
    exitCode: -1,
    usage: { ...EMPTY_USAGE },
    displayItems: [],
  }));

  const emit = (): void => {
    const done = all.filter((r) => r.exitCode !== -1).length;
    const running = all.length - done;
    onUpdate?.({
      text: `Parallel: ${done}/${all.length} done, ${running} running…`,
      details: { mode: "parallel", results: all.map((r) => ({ ...r })) },
    });
  };

  return mapWithConcurrency(tasks, concurrency, async (task, index) => {
    const result = await runWorker(
      {
        agent: task.agent,
        task: task.task,
        cwd: task.cwd,
        parentSessionFile: context.parentSessionFile,
        parentModel: context.parentModel,
        signal: context.signal,
        onUpdate: (partial) => {
          all[index] = {
            ...all[index],
            output: partial.text,
            turns: partial.details.turns,
            model: partial.details.model,
            childSessionId: partial.details.childSessionId,
            usage: partial.details.usage,
            displayItems: partial.details.displayItems,
          };
          emit();
        },
      },
    );
    all[index] = result;
    emit();
    return result;
  });
}
