import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentSessionWrapper } from "../rpc-manager.ts";
import { startRpcSession } from "../rpc-manager.ts";
import { resolveSessionPath } from "../session-reader.ts";
import type {
  LoopDefinition,
  LoopRun,
  RoundExecutionBackend,
  RoundProgress,
  RoundResult,
} from "./types.ts";
import { reapOrphanedRoundProcesses } from "./process-cleanup.ts";
import { parseLoopSeed, seedExecutionSession } from "./seed.ts";

const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Mid-round heartbeats are throttled so a long (subagent-heavy) round does
 *  not bloat RUNS.jsonl while still proving the orchestrator is alive. */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Best-effort, UI-facing description of an orchestrator agent event. The
 *  AgentEvent shape is intentionally loose (`{ type: string; ... }`), so this
 *  only trusts fields it can confirm; it never throws. */
function progressDetail(event: AgentEvent): string {
  const toolName =
    (typeof event.toolName === "string" && event.toolName) ||
    (typeof event.name === "string" && event.name) ||
    undefined;
  if (toolName === "subagent") {
    const args = event.arguments as { agent?: string } | undefined;
    const agent = typeof args?.agent === "string" ? args.agent : undefined;
    return agent ? `subagent: ${agent}` : "subagent";
  }
  if (toolName) return `tool: ${toolName}`;
  return event.type;
}

/** Run one prompt on the orchestrator session and resolve with the assistant's
 *  final text. Rejects on prompt error or a 30min timeout. `onProgress` (if any)
 *  receives a throttled mid-round heartbeat so the run card reflects activity. */
function capturePrompt(
  session: AgentSessionWrapper,
  prompt: string,
  onProgress?: (info: RoundProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastEmit = 0;
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
      // Heartbeat: a long round (subagent trace, slow model) can sit in
      // `running` for many minutes without a status transition. Surface
      // activity so the run card doesn't look frozen. Throttled so a busy
      // round does not bloat RUNS.jsonl; the first event always emits.
      if (onProgress && !settled) {
        const now = Date.now();
        if (now - lastEmit >= HEARTBEAT_INTERVAL_MS) {
          lastEmit = now;
          onProgress({ detail: progressDetail(event) });
        }
      }
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
function buildFirstPrompt(run: LoopRun, realSessionId: string, instructions: string): string {
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
  /** run.id -> extraAgentDirs for this loop. Retained across a gate pause so a
   *  rehydrated orchestrator (after idle-timeout/host-restart) re-registers the
   *  same loop-scoped worker agents; cleared alongside `runWorkspaces`. */
  private readonly runAgentDirs = new Map<string, string[] | undefined>();
  /** Optional seam the host uses to rename an orchestrator session after the
   *  round settles (e.g. name it after the requirement a dev-loop run picked,
   *  so Loop sessions no longer all share an identical title). The engine stays
   *  domain-agnostic: it just calls this with the workspace path + session id
   *  and applies the returned name when the session is still unnamed. */
  private readonly sessionNamer?: (workspacePath: string, sessionId: string) => Promise<string | undefined>;

  constructor(sessionNamer?: (workspacePath: string, sessionId: string) => Promise<string | undefined>) {
    this.sessionNamer = sessionNamer;
  }

  async startRound(
    definition: LoopDefinition,
    run: LoopRun,
    onSessionReady?: (sessionId: string) => void,
    onProgress?: (info: RoundProgress) => void,
  ): Promise<RoundResult> {
    // Record the workspace up-front so an abort that arrives while the
    // orchestrator session is still starting can still scope process cleanup.
    this.runWorkspaces.set(run.id, definition.workspacePath);
    const instructions = await readFile(definition.instructionsPath, "utf8");
    // Inject this loop's own `agents/` directory so the orchestrator's
    // `subagent` tool can discover this loop's worker agents by name. These are
    // a trusted, loop-scoped source (no project-agent confirmation gate).
    const agentsDir = join(definition.directory, "agents");
    const extraAgentDirs = existsSync(agentsDir) ? [agentsDir] : undefined;
    this.runAgentDirs.set(run.id, extraAgentDirs);
    const { session, realSessionId } = await startRpcSession(
      `__loop_host__${run.id}`,
      "",
      definition.workspacePath,
      undefined,
      { extraAgentDirs },
    );
    this.register(run.id, realSessionId, session);
    onSessionReady?.(realSessionId);

    try {
      const output = await capturePrompt(session, buildFirstPrompt(run, realSessionId, instructions), onProgress);
      // The first round is where a dev-loop orchestrator picks its work item and
      // links itself to it. Name the session after that requirement so Loop runs
      // don't all share the same generic title. No-op when no item was selected.
      await this.applySessionName(session, definition.workspacePath, realSessionId);
      // v3: a selection round may end with `LOOP_SEED: <KEY>` — deterministically
      // seed the execution session (normal session + loop skill + guard +
      // bookkeeping) here in the engine, then hand the result back so the runtime
      // can record `seededSessionId` on the terminal snapshot. Seed failures are
      // logged, never thrown: the selection round itself succeeded, and the
      // output still shows the marker for a human to see.
      const seed = await this.seedFromSelection(run, definition, output);
      return await this.finishRound(run.id, output, seed);
    } catch (error) {
      // Abort or 30min timeout: the bash subprocesses the round spawned (an
      // `npm install` / `mvn` delegated to a subagent) are NOT killed by
      // session.destroy() — reap them so they don't orphan into launchd still
      // holding node_modules handles. Then tear the session down (destroy()
      // itself aborts the in-flight prompt — both the abort and timeout paths
      // must actually stop the round, or the orchestrator keeps running as an
      // invisible zombie: still writing the .jsonl and spawning subagents while
      // every surface says it is gone).
      await this.cleanupRunProcesses(run.id);
      this.sessions.get(run.id)?.destroy();
      throw error;
    }
  }

  async resumeRound(
    run: LoopRun,
    message: string,
    onProgress?: (info: RoundProgress) => void,
  ): Promise<RoundResult> {
    let session = this.sessions.get(run.id);
    if (!session) {
      // The in-memory orchestrator wrapper expired (idle timeout) or the host
      // restarted while the run was paused at a gate. The conversation is
      // file-backed: rehydrate it from its .jsonl so the gate answer continues
      // transparently. Only an archived/missing file is unrecoverable.
      session = await this.rehydrateSession(run);
    }
    // The free-text gate answer is used verbatim as the next prompt — the loop's
    // LOOP.md defines what each answer means.
    try {
      const output = await capturePrompt(session, message, onProgress);
      return await this.finishRound(run.id, output);
    } catch (error) {
      await this.cleanupRunProcesses(run.id);
      this.sessions.get(run.id)?.destroy();
      throw error;
    }
  }

  /** Re-open a paused orchestrator session from its `.jsonl` after the
   *  in-memory wrapper expired (10-min idle timeout) or the host restarted.
   *  pi sessions are file-backed, so the gate answer continues seamlessly.
   *  Throws when the file is archived or missing — the only unrecoverable case. */
  private async rehydrateSession(run: LoopRun): Promise<AgentSessionWrapper> {
    if (!run.sessionId) {
      throw new Error("orchestrator session expired: run has no sessionId to rehydrate");
    }
    const sessionFile = await resolveSessionPath(run.sessionId);
    if (!sessionFile) {
      throw new Error(
        "orchestrator session expired: the paused gate can no longer be resumed " +
        "(session was archived or removed). Abort the run and re-trigger.",
      );
    }
    const workspacePath = this.runWorkspaces.get(run.id);
    if (!workspacePath) {
      throw new Error("orchestrator session expired: workspace scope lost for run");
    }
    const { session, realSessionId } = await startRpcSession(
      run.sessionId,
      sessionFile,
      workspacePath,
      undefined,
      { extraAgentDirs: this.runAgentDirs.get(run.id) },
    );
    this.register(run.id, realSessionId, session);
    return session;
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
  private async finishRound(runId: string, output: string, seed?: { key: string; sessionId: string }): Promise<RoundResult> {
    const gateRequest = gateFrom(output);
    if (!gateRequest) {
      const session = this.sessions.get(runId);
      session?.destroy();
      // Terminal: no reaping needed (the round's bash finished naturally) —
      // just drop the workspace scope. A gate result keeps it so a later
      // abort/timeout can still scope orphan cleanup.
      this.runWorkspaces.delete(runId);
      this.runAgentDirs.delete(runId);
    }
    const result: RoundResult = { output: output.slice(0, 32_000) };
    const verdict = verdictFrom(output);
    if (verdict) result.verdict = verdict;
    if (gateRequest) result.gateRequest = gateRequest;
    if (seed) result.seed = seed;
    return result;
  }

  /** Seed an execution session when the selection round emitted
   *  `LOOP_SEED: <KEY>`. Best-effort: guard refusals and errors are logged and
   *  return undefined (the run still succeeds — its job was selection). */
  private async seedFromSelection(
    run: LoopRun,
    definition: LoopDefinition,
    output: string,
  ): Promise<{ key: string; sessionId: string } | undefined> {
    const key = parseLoopSeed(output);
    if (!key) return undefined;
    try {
      const result = await seedExecutionSession({
        workspaceId: run.workspaceId,
        workspacePath: definition.workspacePath,
        skillId: definition.id,
        key,
      });
      if (!result.seeded || !result.sessionId) {
        console.warn(`[pi-loop] seed for ${key} refused: ${result.reason}`);
        return undefined;
      }
      return { key, sessionId: result.sessionId };
    } catch (error) {
      console.error(`[pi-loop] seed for ${key} failed:`, error);
      return undefined;
    }
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
    this.runAgentDirs.delete(runId);
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

  /** Ask the host-provided namer for a title and apply it to a still-unnamed
   *  orchestrator session. Never clobbers an existing name (set by a user or a
   *  prior round) and never throws — naming is cosmetic and must not break the
   *  round flow. */
  private async applySessionName(
    session: AgentSessionWrapper,
    workspacePath: string,
    sessionId: string,
  ): Promise<void> {
    if (!this.sessionNamer) return;
    try {
      if (session.inner.sessionManager.getSessionName()) return;
      const name = await this.sessionNamer(workspacePath, sessionId);
      if (name) session.inner.setSessionName(name);
    } catch (error) {
      console.error("[pi-loop] session naming failed:", error);
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
}
