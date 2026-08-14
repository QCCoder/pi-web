import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentSessionWrapper } from "../rpc-manager.ts";
import { startRpcSession } from "../rpc-manager.ts";
import type {
  LoopDefinition,
  LoopRun,
  RoundExecutionBackend,
  RoundResult,
} from "./types.ts";
import { reapOrphanedRoundProcesses } from "./process-cleanup.ts";

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** Run one prompt on the orchestrator session and resolve with the assistant's
 *  final text. Rejects on prompt error or a 30min timeout. */
function capturePrompt(session: AgentSessionWrapper, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Pi round timed out")), RUN_TIMEOUT_MS);
    timer.unref?.();
    // abort -> session.destroy() fires onDestroy before any prompt_done/error
    // event would, so an in-flight capturePrompt rejects immediately instead of
    // hanging until the 30min timeout. Unsubscribed symmetrically in finish().
    const off = session.onDestroy(() => finish(new Error("session destroyed")));
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off?.();
      unsubscribe?.();
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const unsubscribe = session.onEvent((event: AgentEvent) => {
      if (event.type === "prompt_error") {
        finish(new Error((event.errorMessage as string | undefined) ?? "Pi prompt failed"));
      }
      if (event.type === "prompt_done") {
        void session.send({ type: "get_last_assistant_text" })
          .then((value) => finish(undefined, (value as { text?: string }).text ?? ""))
          .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      }
    });
    void session.send({ type: "prompt", message: prompt }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** `LOOP_VERDICT:` carries an arbitrary free-text conclusion (no longer a fixed
 *  changed|unchanged|unknown enum). Returns the trimmed text after the marker. */
function verdictFrom(output: string): string | undefined {
  const match = output.match(/LOOP_VERDICT\s*:\s*(.+)/i);
  return match?.[1]?.trim() || undefined;
}

/** `LOOP_GATE:` carries the free-text decision the orchestrator wants a human
 *  to make. Returns the trimmed payload, or undefined when the orchestrator did
 *  not pause. */
function gateFrom(output: string): string | undefined {
  return output.match(/LOOP_GATE\s*:\s*(.+)/i)?.[1]?.trim() || undefined;
}

/** The domain-agnostic first prompt handed to every Loop orchestrator. Embeds
 *  the run id and the orchestrator's own session id so the loop can cite them
 *  (LEARN records, work-item conversations). Mentions NO project facts — all of
 *  those live in the loop's own LOOP.md (design step 14, verbatim). */
function buildFirstPrompt(run: LoopRun, realSessionId: string, instructions: string, state: string): string {
  return [
    "你是这一 generic Loop 的常驻 orchestrator 会话。完整按下面的 LOOP.md 执行本轮。",
    `- 本轮 run id：${run.id}（写 LEARN / 产物时引用它）。`,
    `- 你的会话 id（sessionId）：${realSessionId}（如需关联到工作项的 conversations 字段，用这个值）。`,
    "- 你的 cwd 就是工作区根目录；LOOP.md 里提到的仓库相对路径都相对这里解析。",
    "- 需要人判断时，输出一行 `LOOP_GATE: <需要人决定的事>` 然后停下，不要自己越过。",
    "- 本轮完成时输出 `LOOP_VERDICT: <结论>`（或直接自然结束）。",
    "- 本 loop 的子代理已在其 agents/ 目录注册，按 LOOP.md 指引用 subagent 调用。",
    "",
    "# LOOP.md",
    instructions,
    ...(state ? ["# STATE.md", state] : []),
  ].join("\n");
}

/** Pi owns reasoning; this adapter only preserves the same orchestrator session
 *  across gates. A session is kept alive between `startRound` and a later
 *  `resumeRound` until it reaches a terminal result (no `gateRequest`) or is
 *  aborted — at which point it is destroyed. This fixes the old bug where
 *  `execute` deleted the session unconditionally, breaking gate2 resume. */
export class PiRoundExecutionBackend implements RoundExecutionBackend {
  /** run.id -> orchestrator wrapper. */
  private readonly sessions = new Map<string, AgentSessionWrapper>();
  /** Reverse index: pi session id -> orchestrator wrapper. Lets the Loop Host
   *  serve a live session (probe + event stream) to Pi Web even though the
   *  session object lives in *this* process, not Pi Web's. */
  private readonly sessionBySid = new Map<string, AgentSessionWrapper>();
  /** run.id -> workspacePath. Used to scope orphan-process cleanup (npm/mvn
   *  subtrees that outlive a destroyed session) on abort/timeout. Set in
   *  startRound, retained across a gate pause, cleared on terminal finish or
   *  cleanup. */
  private readonly runWorkspaces = new Map<string, string>();

  async startRound(
    definition: LoopDefinition,
    run: LoopRun,
    onSessionReady?: (sessionId: string) => void,
  ): Promise<RoundResult> {
    // Record the workspace up-front so an abort that arrives while the
    // orchestrator session is still starting can still scope process cleanup.
    this.runWorkspaces.set(run.id, definition.workspacePath);
    const instructions = await readFile(definition.instructionsPath, "utf8");
    const state = await readFile(definition.statePath, "utf8").catch(() => "");
    // Inject this loop's own `agents/` directory so the orchestrator's
    // `subagent` tool can discover this loop's worker agents by name. These are
    // a trusted, loop-scoped source (no project-agent confirmation gate).
    const agentsDir = join(definition.directory, "agents");
    const { session, realSessionId } = await startRpcSession(
      `__loop_host__${run.id}`,
      "",
      definition.workspacePath,
      undefined,
      { extraAgentDirs: existsSync(agentsDir) ? [agentsDir] : undefined },
    );
    this.register(run.id, realSessionId, session);
    onSessionReady?.(realSessionId);

    try {
      const output = await capturePrompt(session, buildFirstPrompt(run, realSessionId, instructions, state));
      return await this.finishRound(run.id, output);
    } catch (error) {
      // Abort or 30min timeout: the bash subprocesses the round spawned (an
      // `npm install` / `mvn` delegated to a subagent) are NOT killed by
      // session.destroy() — reap them so they don't orphan into launchd still
      // holding node_modules handles. Then tear the session down (a timeout
      // leaves it alive; an abort already destroyed it).
      await this.cleanupRunProcesses(run.id);
      this.sessions.get(run.id)?.destroy();
      throw error;
    }
  }

  async resumeRound(run: LoopRun, message: string): Promise<RoundResult> {
    const session = this.sessions.get(run.id);
    if (!session) throw new Error("orchestrator session is unavailable; start a fresh round");
    // The free-text gate answer is used verbatim as the next prompt — the loop's
    // LOOP.md defines what each answer means.
    try {
      const output = await capturePrompt(session, message);
      return await this.finishRound(run.id, output);
    } catch (error) {
      await this.cleanupRunProcesses(run.id);
      this.sessions.get(run.id)?.destroy();
      throw error;
    }
  }

  async abortRound(run: LoopRun): Promise<void> {
    const session = this.sessions.get(run.id);
    if (session) session.destroy();
    // Map cleanup happens in the onDestroy callback registered by `register`,
    // but clean up eagerly too in case the callback is deferred.
    this.sessions.delete(run.id);
    // Reap the round's orphaned bash/mvn/npm subtrees (see cleanupRunProcesses).
    await this.cleanupRunProcesses(run.id);
  }

  /** Parse the assistant output for a gate/verdict, and destroy the orchestrator
   *  session when the result is terminal (no `gateRequest`). A gate result keeps
   *  the session alive for a later `resumeRound`. */
  private async finishRound(runId: string, output: string): Promise<RoundResult> {
    const gateRequest = gateFrom(output);
    if (!gateRequest) {
      const session = this.sessions.get(runId);
      session?.destroy();
      // Terminal: no reaping needed (the round's bash finished naturally) —
      // just drop the workspace scope. A gate result keeps it so a later
      // abort/timeout can still scope orphan cleanup.
      this.runWorkspaces.delete(runId);
    }
    const result: RoundResult = { output: output.slice(0, 32_000) };
    const verdict = verdictFrom(output);
    if (verdict) result.verdict = verdict;
    if (gateRequest) result.gateRequest = gateRequest;
    return result;
  }

  /** Reap OS processes orphaned by a round — npm/mvn subtrees that the bash
   *  tool spawned and that `session.destroy()` does not kill (the loop host
   *  never receives the process-level signal pi relies on to sweep them).
   *  Idempotent and never throws: cleanup must not break the abort/timeout
   *  flow. Scoped to the run's workspace so concurrent rounds elsewhere are
   *  untouched. */
  private async cleanupRunProcesses(runId: string): Promise<void> {
    const workspacePath = this.runWorkspaces.get(runId);
    this.runWorkspaces.delete(runId);
    if (!workspacePath) return;
    try {
      const result = await reapOrphanedRoundProcesses(workspacePath);
      if (result.targetRoots.length > 0) {
        console.warn(
          `[pi-loop] reaped ${result.killedPids.length} orphaned process(es) ` +
          `(roots: ${result.targetRoots.join(",")}) for run ${runId} in ${workspacePath}`,
        );
      }
    } catch (error) {
      console.error(`[pi-loop] process cleanup failed for run ${runId}:`, error);
    }
  }

  /** Register an orchestrator session in both indexes, with onDestroy cleanup of
   *  both. Centralized so `abortRound` and terminal `finishRound` share behavior. */
  private register(runId: string, realSessionId: string, session: AgentSessionWrapper): void {
    this.sessions.set(runId, session);
    this.sessionBySid.set(realSessionId, session);
    session.onDestroy(() => {
      this.sessionBySid.delete(realSessionId);
      this.sessions.delete(runId);
    });
  }

  /** Look up the orchestrator wrapper backing a Loop run by pi session id. */
  getBySessionId(sessionId: string): AgentSessionWrapper | undefined {
    const session = this.sessionBySid.get(sessionId);
    return session?.isAlive() ? session : undefined;
  }

  /** Snapshot metadata for a live Loop-owned session. Consumed by the host's
   *  session probe/SSE routes so Pi Web can open and stream a Loop session
   *  that physically lives in this process. Returns undefined once the run is
   *  terminal (the session has been destroyed). */
  getLiveSessionMeta(sessionId: string): { id: string; cwd: string; sessionFile: string; running: boolean } | undefined {
    const session = this.sessionBySid.get(sessionId);
    if (!session?.isAlive()) return undefined;
    return { id: session.sessionId, cwd: session.cwd, sessionFile: session.sessionFile, running: session.isRunning() };
  }
}
