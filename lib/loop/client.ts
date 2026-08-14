import type { GateAnswer, LoopDefinition, LoopRun, TriggerCommand, TriggerReceipt } from "./types.ts";
import type { ImporterRunSummary } from "../importers/runner.ts";

const baseUrl = () => (process.env.PI_LOOP_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");

/** Max wait for the Loop Host on graceful-degradation probes. The host is on
 *  localhost and answers in single-digit ms when healthy; if it cannot answer
 *  within this window it is effectively unavailable (event loop blocked by a
 *  runaway orchestrator, a long sync op, GC storm, etc.) and callers MUST fall
 *  through fast instead of hanging the web UI's session routes. Keep well under
 *  the 5s SSE connect timeout (CONNECT_TIMEOUT_MS in global-agent-events.ts):
 *  probe (2s) + cold startRpcSession (~1-2s) must fit before that window. */
const PROBE_TIMEOUT_MS = 2_000;

/** Metadata + live state for a session physically owned by the Loop Host.
 *  Pi Web probes this to decide whether to proxy the Loop Host's event stream
 *  instead of loading the .jsonl into its own process (which would race the
 *  Loop Host for the same file). */
export interface LoopSessionMeta {
  id: string;
  cwd: string;
  sessionFile: string;
  running: boolean;
  state?: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, init);
  } catch {
    throw new Error(`Loop Host is unavailable at ${baseUrl()}; start it with \`npm run loop\``);
  }
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Loop Host returned HTTP ${response.status}`);
  return value;
}

export const loopHostClient = {
  listLoops: (workspaceId: string) => request<{ loops: LoopDefinition[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/loops`,
  ),
  trigger: (command: TriggerCommand) => request<TriggerReceipt>("/v1/triggers", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
  }),
  getRun: (workspaceId: string, runId: string) => request<{ run: LoopRun }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
  ),
  answerGate: (command: GateAnswer) => request<{ run: LoopRun }>(
    `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/runs/${encodeURIComponent(command.runId)}/gate`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: command.message }) },
  ),
  abortRun: (workspaceId: string, runId: string) => request<{ run: LoopRun }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/abort`,
    { method: "POST" },
  ),
  /** Ask the Loop Host whether it owns a given pi session id. Returns null
   *  when the host is unreachable OR does not own the session, so callers can
   *  fall back to the normal local .jsonl path without distinguishing the two. */
  probeSession: async (sessionId: string): Promise<LoopSessionMeta | null> => {
    let response: Response;
    try {
      // A hung/sick host still accepts the socket but never responds. Without a
      // timeout this await blocks the caller's session route indefinitely — the
      // root cause of "Timed out connecting to the agent event stream": the SSE
      // `connected` frame is gated behind this probe, so it never fires within
      // the client's 5s window. The bounded timeout lets a healthy host answer
      // instantly while forcing a fast fall-through to the local .jsonl path
      // when the host is unresponsive. (The trade-off — treating a merely-busy
      // host as down and loading the .jsonl here — is the lesser evil: the only
      // race risk is for Loop orchestrator sessions, which a host that cannot
      // answer a probe in 2s is in no state to be driving anyway.)
      response = await fetch(`${baseUrl()}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    return await response.json().catch(() => null) as LoopSessionMeta | null;
  },
  /** Open the raw SSE response for a Loop-owned session so Pi Web can proxy
   *  (pipe) its body straight to the browser. */
  sessionEvents: (sessionId: string, signal?: AbortSignal) =>
    fetch(`${baseUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/events`, { signal }),
  /** Trigger a manual Importer sync on the Loop Host (a non-Loop system task).
   *  Returns null when the host is unreachable so the web route can fall back to
   *  an in-process run (a one-shot sync is not a timer — see instrumentation.ts). */
  syncImporters: async (workspaceId: string): Promise<ImporterRunSummary | null> => {
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl()}/v1/workspaces/${encodeURIComponent(workspaceId)}/importers/sync`,
        { method: "POST" },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const value = (await response.json().catch(() => ({}))) as { summary?: ImporterRunSummary };
    return value.summary ?? null;
  },
};
