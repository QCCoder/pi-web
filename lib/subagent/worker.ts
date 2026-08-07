/**
 * Spawn real, in-process child AgentSessions for the subagent tool.
 *
 * Each worker is a genuine first-class session — same creation path as any
 * Pi Web session — linked to its parent via `parentSession`. That makes it:
 *   - listed in the sidebar as a child of the parent session,
 *   - openable as a chat tab with LIVE streaming (it is in the in-process
 *     registry, so opening it reconnects to the running session),
 *   - fully inspectable afterwards (persisted to its own .jsonl).
 *
 * Internal steps are NOT copied into the parent; only streamed status + the
 * final result text return here. The full subagent conversation lives in its
 * own viewable session.
 */
import type { AgentConfig } from "./agents.ts";
import type { AgentEvent, AgentSessionWrapper } from "../rpc-manager.ts";
import { startRpcSession } from "../rpc-manager.ts";

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

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
}

export interface WorkerDetails {
  agent: string;
  task: string;
  source: string;
  turns: number;
  model?: string;
  childSessionId: string;
}

export interface ModelSpec {
  provider: string;
  modelId: string;
}

/** Parse an agent `model` frontmatter value of the form "provider/modelId". */
export function parseModelSpec(spec: string | undefined): ModelSpec | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

function lastAssistantText(message: { content?: Array<{ type: string; text?: string }> }): string {
  for (const part of message.content ?? []) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text;
  }
  return "";
}

export function isFailedResult(result: WorkerResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

interface PromptOutcome {
  output: string;
  errorMessage?: string;
  turns: number;
  model?: string;
}

function capturePrompt(
  session: AgentSessionWrapper,
  task: string,
  onUpdate: ((text: string, turns: number, model: string | undefined) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<PromptOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let turns = 0;
    let model: string | undefined;
    let off: () => void = () => {};

    const finish = (outcome: PromptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ output: "", errorMessage: "subagent timed out", turns, model }), RUN_TIMEOUT_MS);
    timer.unref?.();

    if (signal?.aborted) {
      finish({ output: "", errorMessage: "aborted", turns, model });
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        void session.send({ type: "abort" }).catch(() => {});
        finish({ output: "", errorMessage: "aborted", turns, model });
      },
      { once: true },
    );

    off = session.onEvent((event: AgentEvent) => {
      if (event.type === "message_end") {
        const message = event.message as { role?: string; content?: Array<{ type: string; text?: string }>; model?: string } | undefined;
        if (message?.role === "assistant") {
          turns++;
          if (!model && message.model) model = message.model;
          onUpdate?.(lastAssistantText(message), turns, model);
        }
      }
      if (event.type === "prompt_error") {
        finish({ output: "", errorMessage: (event.errorMessage as string | undefined) ?? "pi prompt failed", turns, model });
      }
      if (event.type === "prompt_done") {
        void session
          .send({ type: "get_last_assistant_text" })
          .then((value) => finish({ output: (value as { text?: string }).text ?? "", turns, model }))
          .catch(() => finish({ output: "", turns, model }));
      }
    });

    void session
      .send({ type: "prompt", message: `Task: ${task}`, source: "rpc" })
      .catch((error: unknown) => finish({ output: "", errorMessage: error instanceof Error ? error.message : String(error), turns, model }));
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

  const emit = (text: string, turns: number, model: string | undefined): void => {
    opts.onUpdate?.({
      text: text || "(running…)",
      details: {
        agent: opts.agent.name,
        task: opts.task,
        source: opts.agent.source,
        turns,
        model,
        childSessionId: realSessionId,
      },
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
      turns: outcome.turns,
      model: outcome.model,
      childSessionId: realSessionId,
      exitCode: failed ? 1 : 0,
      stopReason: failed ? "error" : "end",
      errorMessage: outcome.errorMessage,
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
