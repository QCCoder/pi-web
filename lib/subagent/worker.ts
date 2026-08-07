/**
 * Spawn real, isolated `pi` subprocess workers for the subagent tool.
 *
 * Each worker is a genuine independent agent: its own process, its own context
 * window, its own model/tools. The parent only sees streamed status and the
 * worker's final result text — internal steps stay isolated by design.
 */
import { spawn } from "node:child_process";
import type { AgentConfig } from "./agents.ts";
import { resolvePiInvocation } from "./cli.ts";

export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
}

export interface WorkerResult {
  agent: string;
  task: string;
  source: string;
  /** Final assistant text produced by the worker. */
  output: string;
  turns: number;
  model?: string;
  usage: WorkerUsage;
  exitCode: number;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface WorkerDetails {
  agent: string;
  task: string;
  source: string;
  turns: number;
  model?: string;
  items: DisplayItem[];
}

type AnyMessage = {
  role?: string;
  content?: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

interface JsonEvent {
  type: string;
  message?: AnyMessage;
}

function finalText(messages: AnyMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content ?? []) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text;
    }
  }
  return "";
}

function displayItems(messages: AnyMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        items.push({ type: "text", text: part.text });
      } else if (part.type === "toolCall" && part.name) {
        items.push({ type: "toolCall", name: part.name, args: part.arguments ?? {} });
      }
    }
  }
  return items;
}

export function isFailedResult(result: WorkerResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export interface RunWorkerOptions {
  agent: AgentConfig;
  task: string;
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (partial: { text: string; details: WorkerDetails }) => void;
}

export async function runWorker(opts: RunWorkerOptions): Promise<WorkerResult> {
  const invocation = resolvePiInvocation(opts.cwd);
  const args = [...invocation.prefix, "--mode", "json", "-p", "--no-session"];
  if (opts.agent.model) args.push("--model", opts.agent.model);
  if (opts.agent.tools?.length) args.push("--tools", opts.agent.tools.join(","));
  if (opts.agent.systemPrompt) args.push("--append-system-prompt", opts.agent.systemPrompt);
  args.push(`Task: ${opts.task}`);

  const messages: AnyMessage[] = [];
  const result: WorkerResult = {
    agent: opts.agent.name,
    task: opts.task,
    source: opts.agent.source,
    output: "",
    turns: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
    exitCode: 0,
    stderr: "",
  };

  const emit = () => {
    opts.onUpdate?.({
      text: finalText(messages) || "(running…)",
      details: {
        agent: opts.agent.name,
        task: opts.task,
        source: opts.agent.source,
        turns: result.turns,
        model: result.model,
        items: displayItems(messages),
      },
    });
  };

  let aborted = false;
  const exitCode = await new Promise<number>((resolveExit) => {
    const proc = spawn(invocation.command, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        return;
      }
      if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
        messages.push(event.message);
        if (event.message.role === "assistant") {
          result.turns++;
          const usage = event.message.usage;
          if (usage) {
            result.usage.input += usage.input || 0;
            result.usage.output += usage.output || 0;
            result.usage.cacheRead += usage.cacheRead || 0;
            result.usage.cacheWrite += usage.cacheWrite || 0;
            result.usage.cost += usage.cost?.total || 0;
            result.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!result.model && event.message.model) result.model = event.message.model;
          if (event.message.stopReason) result.stopReason = event.message.stopReason;
          if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
        }
        emit();
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      resolveExit(code ?? 0);
    });
    proc.on("error", () => resolveExit(1));

    if (opts.signal) {
      const kill = (): void => {
        aborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
  });

  result.exitCode = exitCode;
  result.output = finalText(messages);
  if (aborted) throw new Error("subagent was aborted");
  return result;
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

/**
 * Run multiple workers concurrently with an aggregate streaming status.
 * `onUpdate` receives a one-line progress summary plus per-task details.
 */
export async function runParallel(
  tasks: ParallelTask[],
  concurrency: number,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { text: string; details: { mode: "parallel"; results: WorkerResult[] } }) => void) | undefined,
): Promise<WorkerResult[]> {
  const all: WorkerResult[] = tasks.map((t) => ({
    agent: t.agent.name,
    task: t.task,
    source: t.agent.source,
    output: "",
    turns: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
    exitCode: -1,
    stderr: "",
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
    const result = await runWorker({
      agent: task.agent,
      task: task.task,
      cwd: task.cwd,
      signal,
      onUpdate: (partial) => {
        all[index] = {
          ...all[index],
          output: partial.text,
          turns: partial.details.turns,
          model: partial.details.model,
        };
        emit();
      },
    });
    all[index] = result;
    emit();
    return result;
  });
}
