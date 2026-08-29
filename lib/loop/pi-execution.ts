import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentSessionWrapper } from "../daemon/rpc-manager.ts";
import { startRpcSession } from "../daemon/rpc-manager.ts";
import { creationTimeoutSignal } from "../abort-race";
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
/** Upper bound on orchestrator-session CREATION. The 30-min round timeout only
 *  arms AFTER the session exists, so a creation hang used to pin the run in
 *  "running" forever with nothing to abort — the wrapper did not exist yet. */
const SESSION_START_TIMEOUT_MS = 5 * 60 * 1000;
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
    "- 本轮完成时输出 `LOOP_VERDICT: <结论>`（或直接自然结束）；若 LOOP.md 要求播种，最后一行精确输出 `LOOP_SEED: <KEY>`。",
    "- 本 loop 的子代理（若有）已在其 agents/ 目录注册，按 LOOP.md 指引用 subagent 调用。",
    "",
    "# LOOP.md",
    instructions,
  ].join("\n");
}

/** Pi owns reasoning; this adapter runs ONE short selection round per run.
 *  v3: the orchestrator session is destroyed on the round's result — there is
 *  no cross-gate retention (execution happens in normal seeded sessions; see
 *  seed.ts and docs/dev-loop-v3-design.md). */
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
    const { signal: startSignal, dispose: disposeStartTimer } = creationTimeoutSignal(
      SESSION_START_TIMEOUT_MS,
      "orchestrator session creation timed out",
    );
    let session: AgentSessionWrapper;
    let realSessionId: string;
    try {
      ({ session, realSessionId } = await startRpcSession(
        `__loop_host__${run.id}`,
        "",
        definition.workspacePath,
        undefined,
        { extraAgentDirs, signal: startSignal },
      ));
    } catch (error) {
      // Creation failed/timed out/aborted: there is no session to destroy, but
      // the workspace scope recorded above must still be dropped (same cleanup
      // as a failed round).
      await this.cleanupRunProcesses(run.id);
      throw error;
    } finally {
      disposeStartTimer();
    }
    this.register(run.id, realSessionId, session);
    onSessionReady?.(realSessionId);

    try {
      const output = await capturePrompt(session, buildFirstPrompt(run, realSessionId, instructions), onProgress);
      // v3: a selection round may end with `LOOP_SEED: <KEY>` — deterministically
      // seed the execution session (normal session + loop skill + guard +
      // bookkeeping) here in the engine, then hand the result back so the runtime
      // can record `seededSessionId` on the terminal snapshot. Seed failures are
      // logged, never thrown: the selection round itself succeeded, and the
      // output still shows the marker for a human to see.
      const seed = await this.seedFromSelection(run, definition, output);
      return await this.finishRound(run.id, output, seed?.seed, seed?.refused);
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

  async abortRound(run: LoopRun): Promise<void> {
    const session = this.sessions.get(run.id);
    if (session) session.destroy();
    // Map cleanup happens in the onDestroy callback registered by `register`,
    // but clean up eagerly too in case the callback is deferred.
    this.sessions.delete(run.id);
    // Reap the round's orphaned bash/mvn/npm subtrees (see cleanupRunProcesses).
    await this.cleanupRunProcesses(run.id);
  }

  /** Parse the assistant output for a verdict, destroy the orchestrator session
   *  (the round is terminal by construction), and attach the seed result. */
  private async finishRound(
    runId: string,
    output: string,
    seed?: { key: string; sessionId: string },
    seedRefused?: string,
  ): Promise<RoundResult> {
    this.sessions.get(runId)?.destroy();
    // No reaping needed (the round's bash finished naturally) — just drop the
    // workspace scope.
    this.runWorkspaces.delete(runId);
    const result: RoundResult = { output: output.slice(0, 32_000) };
    const verdict = verdictFrom(output);
    if (verdict) result.verdict = verdict;
    if (seed) result.seed = seed;
    if (seedRefused) result.seedRefused = seedRefused;
    return result;
  }

  /** Seed an execution session when the selection round emitted
   *  `LOOP_SEED: <KEY>`. Best-effort: errors are logged and return undefined
   *  (the run still succeeds — its job was selection); a guard refusal returns
   *  `refused` so the runtime records it on the run snapshot (design §5). */
  private async seedFromSelection(
    run: LoopRun,
    definition: LoopDefinition,
    output: string,
  ): Promise<{ seed?: { key: string; sessionId: string }; refused?: string } | undefined> {
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
        return { refused: result.reason };
      }
      return { seed: { key, sessionId: result.sessionId } };
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
}
