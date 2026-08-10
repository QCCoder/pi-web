import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentSessionWrapper } from "../rpc-manager.ts";
import { startRpcSession } from "../rpc-manager.ts";
import type {
  InferredLoopPlan,
  LoopDefinition,
  LoopRun,
  MonitorVerdict,
  RoundExecutionBackend,
} from "./types.ts";

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

function capturePrompt(session: AgentSessionWrapper, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Pi round timed out")), RUN_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

async function hasSubagentTool(session: AgentSessionWrapper): Promise<boolean> {
  try {
    const tools = await session.send({ type: "get_tools" }) as Array<{ name: string; active: boolean }>;
    return Array.isArray(tools) && tools.some((t) => t.name === "subagent" && t.active);
  } catch {
    return false;
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const hasBraces = text.includes("{") && text.includes("}");
  const candidate = fenced ?? (hasBraces ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : "");
  if (!candidate) {
    throw new Error(`Pi did not return JSON (empty or no JSON object). Preview: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Pi returned unparseable JSON: ${error instanceof Error ? error.message : String(error)}. Preview: ${candidate.slice(0, 200)}`);
  }
}

function normalizePlan(output: string, definition: LoopDefinition): InferredLoopPlan {
  const raw = extractJson(output) as Record<string, unknown>;
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((item, index) => {
      const step = item as Record<string, unknown>;
      return {
        id: typeof step.id === "string" ? step.id : `step-${index + 1}`,
        maker: typeof step.maker === "string" ? step.maker : "orchestrator",
        verifier: typeof step.verifier === "string" ? step.verifier : "evidence-check",
        ...(typeof step.gate === "string" && step.gate ? { gate: step.gate } : {}),
      };
    })
    : [];
  if (steps.length === 0) throw new Error("Pi inferred no executable steps");
  const canonical = JSON.stringify({ loopId: definition.id, steps, improve: raw.improve ?? "" });
  return {
    summary: typeof raw.summary === "string" ? raw.summary : definition.description,
    steps,
    improve: typeof raw.improve === "string" ? raw.improve : "Review RUNS.jsonl and propose an audited improvement.",
    fingerprint: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
  };
}

function verdictFrom(output: string): MonitorVerdict | undefined {
  const match = output.match(/LOOP_VERDICT\s*:\s*(changed|unchanged|unknown)/i);
  return match?.[1]?.toLowerCase() as MonitorVerdict | undefined;
}

function gateFrom(output: string): string | undefined {
  return output.match(/LOOP_GATE\s*:\s*(.+)/i)?.[1]?.trim();
}

/** Pi owns reasoning; this adapter only preserves the same main session across phases. */
export class PiRoundExecutionBackend implements RoundExecutionBackend {
  private readonly sessions = new Map<string, AgentSessionWrapper>();
  /** Reverse index: pi session id -> orchestrator wrapper. Lets the Loop Host
   *  serve a live session (probe + event stream) to Pi Web even though the
   *  session object lives in *this* process, not Pi Web's. */
  private readonly sessionBySid = new Map<string, AgentSessionWrapper>();

  async infer(definition: LoopDefinition, run: LoopRun, onSessionReady?: (sessionId: string) => void) {
    const instructions = await readFile(definition.instructionsPath, "utf8");
    const state = await readFile(definition.statePath, "utf8").catch(() => "# State\n\nNo prior state.");
    // Inject this loop's own `agents/` directory so the orchestrator's
    // `subagent` tool can discover scanner/analyst/checker by name. These are
    // a trusted, loop-scoped source (no project-agent confirmation gate).
    const agentsDir = join(definition.directory, "agents");
    const { session, realSessionId } = await startRpcSession(
      `__loop_host__${run.id}`,
      "",
      definition.workspacePath,
      undefined,
      { extraAgentDirs: existsSync(agentsDir) ? [agentsDir] : undefined },
    );
    this.sessions.set(run.id, session);
    this.sessionBySid.set(realSessionId, session);
    session.onDestroy(() => this.sessionBySid.delete(realSessionId));
    onSessionReady?.(realSessionId);
    const delegateViaSubagent = await hasSubagentTool(session);
    const roleLine = delegateViaSubagent
      ? "Each maker and verifier will later run as its own isolated subagent session, so infer roles that are independently delegatable."
      : "Maker and verifier roles will run inline in this same session; keep them conceptually separable.";
    const output = await capturePrompt(session, [
      "You are the persistent orchestrator conversation for one generic Loop round.",
      "Read the task contract below. Infer its maker/checker pipeline without doing the work yet.",
      "Return JSON only: {summary, steps:[{id,maker,verifier,gate?}], improve}.",
      "Every producing step needs a separate verifier. Include human gates only where the contract requires judgment.",
      roleLine,
      "",
      `# LOOP.md\n${instructions}`,
      `# STATE.md\n${state}`,
    ].join("\n"));
    return { sessionId: realSessionId, plan: normalizePlan(output, definition) };
  }

  async execute(definition: LoopDefinition, run: LoopRun, comment?: string) {
    const session = this.sessions.get(run.id);
    if (!session) throw new Error("orchestrator session is unavailable; start a fresh round");
    const delegateViaSubagent = await hasSubagentTool(session);
    const delegationLine = delegateViaSubagent
      ? "You have a `subagent` tool, and this loop's worker agents (defined under this loop's `agents/` directory) are registered and callable by name. Execute each producing (maker) step and each verifying (checker) step from LOOP.md by delegating to its named agent via `subagent({ agent, task, cwd })`, passing a fully self-contained task (the child has NOT seen this conversation). Each child runs in its own isolated, recorded, viewable session. Never let a maker verify its own output — the checker must always be a separate `subagent` call. Do NOT shell out to `pi`/`bash` to spawn workers; always use the `subagent` tool."
      : "Perform maker and checker roles yourself, but keep producer and verifier strictly separate; never let a maker verify its own output.";
    const output = await capturePrompt(session, [
      `The creator approved plan ${run.plan?.fingerprint ?? "(unknown)"}.`,
      comment ? `Creator comment: ${comment}` : "",
      "Execute the whole confirmed pipeline now.",
      "Keep this session as the orchestrator only — do coordination, synthesize verification, and produce the final verdict here.",
      delegationLine,
      "Record concrete evidence, update STATE.md only from verified results, append audit material under this loop directory,",
      "and end with LOOP_VERDICT: changed|unchanged|unknown when the task is a monitor.",
      "Before any declared human gate, stop and end with LOOP_GATE: <the exact decision needed>. Do not cross the gate.",
      "The improve step may propose changes, but L1/L2 must not silently rewrite LOOP.md or agent instructions.",
    ].filter(Boolean).join("\n"));
    this.sessions.delete(run.id);
    const gateRequest = gateFrom(output);
    return {
      output: output.slice(0, 32_000),
      verdict: verdictFrom(output),
      ...(gateRequest ? { gateRequest } : {}),
    };
  }

  async reject(run: LoopRun, comment?: string) {
    const session = this.sessions.get(run.id);
    if (session) {
      await capturePrompt(session, `The creator rejected this inferred plan.${comment ? ` Reason: ${comment}` : ""} Stop without changing task state.`)
        .catch(() => undefined);
      session.destroy();
    }
    this.sessions.delete(run.id);
  }

  /** Look up the orchestrator wrapper backing a Loop run by pi session id. */
  getBySessionId(sessionId: string): AgentSessionWrapper | undefined {
    const session = this.sessionBySid.get(sessionId);
    return session?.isAlive() ? session : undefined;
  }

  /** Snapshot metadata for a live Loop-owned session. Consumed by the host's
   *  session probe/SSE routes so Pi Web can open and stream a Loop session
   *  that physically lives in this process. */
  getLiveSessionMeta(sessionId: string): { id: string; cwd: string; sessionFile: string; running: boolean } | undefined {
    const session = this.sessionBySid.get(sessionId);
    if (!session?.isAlive()) return undefined;
    return { id: session.sessionId, cwd: session.cwd, sessionFile: session.sessionFile, running: session.isRunning() };
  }
}
