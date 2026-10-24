/** Typed in-process host facade — the port of the daemon's /v1/sessions
 *  surface (lib/daemon/http-sessions.ts, deleted with the daemon) to direct
 *  function calls. Web routes consume ONLY this module: it owns the
 *  error→status mapping (SessionHostError.status) and the live-first,
 *  cold-start-from-.jsonl revive semantics. */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  abortSubagent,
  destroyRpcSessionsForCwd,
  getLiveRpcSessionInfos,
  getRpcSession,
  getRunningRpcSessionIds,
  getStalledSessionSnapshot,
  getSubagentRun,
  hasBusyRpcSessionForCwd,
  startRpcSession,
  steerSubagent,
  type LiveRpcSessionInfo,
  type StartSessionOptions,
} from "./registry.ts";
import type { StalledSessionInfo } from "./heartbeat.ts";
import { resolveSessionPath } from "../session-reader.ts";
import { generateSessionTitle } from "../session-title.ts";

export class SessionHostError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SessionHostError";
    this.status = status;
  }
}

export interface CreateSessionInput {
  cwd: string;
  provider?: string;
  modelId?: string;
  toolNames?: string[];
  thinkingLevel?: string;
  command?: { type: string; [key: string]: unknown };
  /** 追加进会话系统提示（透传 StartSessionOptions.appendSystemPrompt）——
   *  role session（delivery-runner/role-session.ts）的开场合同走这里。 */
  appendSystemPrompt?: string;
  /** 创建时显式模型（透传 StartSessionOptions.model），优先于已保存/默认模型。
   *  与顶层 provider/modelId 的 set_model 流并存——那是交互会话的模型选择器路径。 */
  model?: { provider?: string; modelId: string };
}

export interface CreateSessionResult {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  data: unknown;
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  if (!input.cwd || typeof input.cwd !== "string") throw new SessionHostError("cwd is required", 400);
  if (!existsSync(input.cwd)) throw new SessionHostError(`Directory does not exist: ${input.cwd}`, 400);
  // One-time key so startRpcSession's start-lock never coalesces two
  // concurrent creates onto one session (mirrors the old daemon route).
  const tempKey = `__new__${randomUUID()}`;
  // appendSystemPrompt / model 透传 StartSessionOptions（role session 建会话用）。
  const startOptions: StartSessionOptions | undefined =
    input.appendSystemPrompt || input.model
      ? {
          ...(input.appendSystemPrompt ? { appendSystemPrompt: input.appendSystemPrompt } : {}),
          ...(input.model ? { model: input.model } : {}),
        }
      : undefined;
  const { session, realSessionId } = await startRpcSession(tempKey, "", input.cwd, input.toolNames, startOptions);
  if (input.provider && input.modelId) {
    await session.send({ type: "set_model", provider: input.provider, modelId: input.modelId });
  }
  if (input.thinkingLevel) {
    await session.send({ type: "set_thinking_level", level: input.thinkingLevel });
  }
  const data = input.command ? await session.send(input.command) : null;
  return { sessionId: realSessionId, cwd: session.cwd, sessionFile: session.sessionFile, data };
}

export async function sendCommand(
  sessionId: string,
  command: { type: string; [key: string]: unknown },
): Promise<unknown> {
  // Live session first (interactive / subagent child / kit round), then
  // cold-start from the .jsonl on disk — the revive semantics every proxy
  // route had through the daemon.
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) return live.send(command);
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionHostError("Session not found", 404);
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  const { session } = await startRpcSession(sessionId, filePath, cwd);
  return session.send(command);
}

export interface LiveSessionMeta {
  id: string;
  cwd: string;
  sessionFile: string;
  running: boolean;
  state?: unknown;
}

export async function probeSession(sessionId: string): Promise<LiveSessionMeta | null> {
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) return null;
  let state: unknown;
  try { state = await session.send({ type: "get_state" }); }
  catch { state = undefined; /* session not ready yet */ }
  return {
    id: session.sessionId,
    cwd: session.cwd,
    sessionFile: session.sessionFile,
    running: session.isRunning(),
    state,
  };
}

/** Best-effort wrapper teardown before the web layer deletes/archives the
 *  session file: destroy the live wrapper so it stops appending to a file
 *  that is about to move/disappear. */
export function destroySession(sessionId: string): void {
  getRpcSession(sessionId)?.destroy();
}

export async function autoNameSession(sessionId: string): Promise<{ title: string; usage: unknown }> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionHostError("Session not found", 404);
  const live = getRpcSession(sessionId);
  const session = live?.isAlive()
    ? live
    : (await startRpcSession(sessionId, filePath, SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd())).session;
  await session.waitUntilReady?.();
  const result = await generateSessionTitle(session.inner as unknown as AgentSession);
  if (!session.isAlive()) {
    throw new SessionHostError("The session was closed while its title was being generated.", 409);
  }
  session.inner.setSessionName(result.title);
  return { title: result.title, usage: result.usage ?? null };
}

export function busyForCwd(cwd: string): boolean {
  return hasBusyRpcSessionForCwd(cwd);
}

export function reloadCwdSessions(cwd: string): number {
  return destroyRpcSessionsForCwd(cwd);
}

export function liveSessions(): LiveRpcSessionInfo[] {
  return getLiveRpcSessionInfos();
}

export function runningStatus(): { ids: string[]; stalled: StalledSessionInfo[] } {
  return { ids: getRunningRpcSessionIds(), stalled: getStalledSessionSnapshot() };
}

export async function getSubagentRunStatus(sessionId: string): Promise<unknown> {
  const run = await getSubagentRun(sessionId);
  if (!run) throw new SessionHostError("Subagent not found", 404);
  return run;
}

export async function controlSubagent(
  sessionId: string,
  action: "steer" | "abort",
  message?: string,
): Promise<{ run: unknown }> {
  if (action === "steer") {
    if (typeof message !== "string" || !message.trim()) {
      throw new SessionHostError("message required", 400);
    }
    await steerSubagent(sessionId, message);
  } else {
    await abortSubagent(sessionId);
  }
  return { run: await getSubagentRun(sessionId) };
}
