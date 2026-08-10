import type { GateCommand, LoopDefinition, LoopRun, TriggerCommand, TriggerReceipt } from "./types.ts";

const baseUrl = () => (process.env.PI_LOOP_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");

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
  answerGate: (command: GateCommand) => request<{ run: LoopRun }>(
    `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/runs/${encodeURIComponent(command.runId)}/gate`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) },
  ),
  /** Ask the Loop Host whether it owns a given pi session id. Returns null
   *  when the host is unreachable OR does not own the session, so callers can
   *  fall back to the normal local .jsonl path without distinguishing the two. */
  probeSession: async (sessionId: string): Promise<LoopSessionMeta | null> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl()}/v1/sessions/${encodeURIComponent(sessionId)}`);
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
};
