import type { AgentEvent, AgentSessionWrapper } from "../rpc-manager.ts";
import { startRpcSession } from "../rpc-manager.ts";
import { FeishuClient } from "../feishu/client.ts";
import { readFeishuConfig } from "../feishu/config.ts";
import { appendRun, readWatchlist } from "./store.ts";
import { createUlid } from "../workspaces/id.ts";
import type { WorkspaceManifest } from "../workspaces/types.ts";
import type { LoopJob, LoopPushResult, LoopRun, LoopRunStatus, LoopRunTrigger } from "./types.ts";

/** Hard cap on a single automation run; protects the scheduler from a stuck agent. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Truncate stored output so run history stays small. */
const MAX_OUTPUT_CHARS = 8000;
/** Feishu text messages have a ~30k char limit. */
const FEISHU_TEXT_MAX = 30000;

function buildPrompt(job: LoopJob, manifest: WorkspaceManifest, watchlist: string): string {
  const lines: string[] = [];
  lines.push(`你正在工作区「${manifest.name}」里执行一个定时自动化任务。`);
  lines.push("");
  lines.push("# 任务");
  lines.push(job.prompt.trim());
  if (watchlist.trim()) {
    lines.push("");
    lines.push(`# 自选清单（automations/${job.watchlist || "watchlist"}.md）`);
    lines.push("```");
    lines.push(watchlist.trim());
    lines.push("```");
  }
  lines.push("");
  lines.push("# 产出要求");
  lines.push("- 取数、分析、总结，给出一份结构清晰、可直接阅读的 Markdown。");
  lines.push("- 把最终总结作为你的最后一条回复；系统会把这条回复推送到飞书。");
  lines.push("- 不要自己调用任何飞书推送工具（feishu_send_message / feishu_send_card）。");
  return lines.join("\n");
}

/**
 * Send the prompt to the automation session and resolve with the captured
 * assistant text. Listens for the wrapper's terminal events (prompt_done on
 * success, prompt_error on failure) rather than polling. A hard timeout
 * destroys a stuck session so the scheduler is never blocked indefinitely.
 */
function capturePromptOutput(
  session: AgentSessionWrapper,
  prompt: string,
): Promise<{ output: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
    let unsub: (() => void) | null = null;

    const finish = (result: { output: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      if (timeout.id) clearTimeout(timeout.id);
      unsub?.();
      resolve(result);
    };

    const listener = (event: AgentEvent): void => {
      if (event.type === "prompt_error") {
        finish({ output: "", error: (event.errorMessage as string | undefined) ?? "prompt error" });
      } else if (event.type === "prompt_done") {
        void session
          .send({ type: "get_last_assistant_text" })
          .then((res) => finish({ output: (res as { text?: string }).text ?? "" }))
          .catch(() => finish({ output: "", error: "failed to read assistant output" }));
      }
    };

    unsub = session.onEvent(listener);
    timeout.id = setTimeout(() => {
      finish({ output: "", error: "automation run timed out" });
      try {
        session.destroy();
      } catch {
        // Ignore — the session may already be gone.
      }
    }, RUN_TIMEOUT_MS);

    session.send({ type: "prompt", message: prompt }).catch((err: unknown) => {
      finish({ output: "", error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function pushOutput(
  workspaceId: string,
  job: LoopJob,
  output: string,
): Promise<LoopPushResult> {
  try {
    const config = await readFeishuConfig(workspaceId);
    if (!config) {
      return { ok: false, error: "Feishu 未配置（缺少 appId/appSecret 或 receiveId）" };
    }
    const receiveId = (job.pushTarget || config.receiveId).trim();
    if (!receiveId) return { ok: false, error: "未设置推送目标 receiveId" };
    const client = new FeishuClient(config);
    const result = job.produceFormat === "text"
      ? await client.sendText(receiveId, output.slice(0, FEISHU_TEXT_MAX))
      : await client.sendCard(receiveId, {
        title: job.description || job.name,
        markdown: output,
      });
    if (!result.ok) return { ok: false, error: result.error ?? "Feishu send failed" };
    return { ok: true, ...(result.messageId ? { messageId: result.messageId } : {}) };
  } catch (pushError) {
    return { ok: false, error: pushError instanceof Error ? pushError.message : String(pushError) };
  }
}

/**
 * Execute one Loop job end to end: open an isolated automation session through
 * the rpc-manager (the single session owner — never a separate process), run
 * the prompt, capture the assistant output, push it via feishu-transport, and
 * append a run record. Automation sessions are independent of chat sessions.
 */
export async function runLoopJob(
  workspacePath: string,
  manifest: WorkspaceManifest,
  job: LoopJob,
  triggeredBy: LoopRunTrigger,
): Promise<LoopRun> {
  const startedAt = new Date().toISOString();
  const runId = createUlid();

  let status: LoopRunStatus = "success";
  let error: string | undefined;
  let sessionId = "";
  let output = "";

  try {
    const watchlist = await readWatchlist(workspacePath, job.watchlist);
    const prompt = buildPrompt(job, manifest, watchlist);
    // One-time key so startRpcSession never coalesces this with another session.
    const { session, realSessionId } = await startRpcSession(`__loop__${runId}`, "", workspacePath, undefined);
    sessionId = realSessionId;
    const captured = await capturePromptOutput(session, prompt);
    output = captured.output;
    if (captured.error) {
      status = "error";
      error = captured.error;
    }
  } catch (runError) {
    status = "error";
    error = runError instanceof Error ? runError.message : String(runError);
  }

  let push: LoopPushResult | undefined;
  if (status === "success" && output.trim()) {
    push = await pushOutput(manifest.id, job, output);
  }

  const run: LoopRun = {
    id: runId,
    jobName: job.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    sessionId,
    output: output.slice(0, MAX_OUTPUT_CHARS),
    triggeredBy,
    ...(push ? { push } : {}),
    ...(error ? { error } : {}),
  };
  try {
    await appendRun(workspacePath, job.name, run);
  } catch (appendError) {
    // A failed history append must not mask the run result; log and continue.
    console.error(
      `[loop] failed to append run for ${job.name}:`,
      appendError instanceof Error ? appendError.message : appendError,
    );
  }
  return run;
}
