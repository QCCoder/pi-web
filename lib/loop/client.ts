import type { GateCommand, LoopDefinition, LoopRun, TriggerCommand, TriggerReceipt } from "./types.ts";

const baseUrl = () => (process.env.PI_LOOP_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");

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
};
