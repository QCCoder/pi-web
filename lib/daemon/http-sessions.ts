import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  destroyRpcSessionsForCwd,
  getLiveRpcSessionInfos,
  getRpcSession,
  getRunningRpcSessionIds,
  getStalledSessionSnapshot,
  hasBusyRpcSessionForCwd,
  startRpcSession,
  subscribeRunningSessions,
  type AgentSessionWrapper,
} from "./rpc-manager.ts";
import { resolveSessionPath } from "../session-reader.ts";
import { generateSessionTitle } from "../session-title.ts";
import { type DaemonRouteHandler, readJsonBody, sendJson } from "./http.ts";

/** The session-daemon surface: /v1/sessions/** — the daemon's core identity
 *  (C2). Every live session in this process is reachable here: interactive
 *  sessions, subagent children and kit heartbeat rounds alike (the registry is
 *  keyed by real session id). Pi Web proxies these routes verbatim.
 *
 *  Everything is live-first, cold-start-from-.jsonl revive semantics. */

/** Stream a live session's agent events to an HTTP client (Pi Web proxies
 *  this to the browser so any daemon-owned session can be watched live).
 *  Mirrors the SSE shape Pi Web emits. The stream also ends when the session
 *  is destroyed (kit round timeout / abort) — otherwise the browser-side
 *  pinned runtime would keep `agentRunning` true forever with no `agent_end`
 *  ever arriving. */
function serveSessionSse(request: IncomingMessage, response: ServerResponse, session: AgentSessionWrapper): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const write = (data: unknown) => {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  write({ type: "connected", sessionId: session.sessionId });
  const unsubscribe = session.onEvent((event) => write(event));
  const heartbeat = setInterval(() => {
    try { response.write(": \n\n"); } catch { /* response already closed */ }
  }, 30_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    offDestroy();
    try { response.end(); } catch { /* already ended */ }
  };
  const offDestroy = session.onDestroy(cleanup);
  request.on("close", cleanup);
  request.on("error", cleanup);
}

/** SSE stream of the set of currently-running session ids in this process.
 *  Because the registry holds interactive sessions, subagent children and kit
 *  heartbeat rounds alike (keyed by real session id), this single stream is
 *  the complete running answer — the web route proxies it verbatim for its
 *  badges. Subscribes BEFORE the initial snapshot so no transition can slip
 *  between the two. */
function serveRunningSse(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const write = (data: unknown) => {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const unsubscribe = subscribeRunningSessions((ids) => {
    try { write({ type: "running", runningSessionIds: ids }); } catch { /* closed */ }
  });
  write({ type: "running", runningSessionIds: getRunningRpcSessionIds() });
  const heartbeat = setInterval(() => {
    try { response.write(": \n\n"); } catch { /* closed */ }
  }, 30_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { response.end(); } catch { /* already ended */ }
  };
  request.on("close", cleanup);
  request.on("error", cleanup);
}

export function createSessionsRoutes(): DaemonRouteHandler {
  /** Any live pi session in this daemon: the ordinary rpc registry — where
   *  interactive sessions, subagent children AND the rounds a loop kit spawner
   *  starts all live (keyed by real session id). Exposing it lets Pi Web probe
   *  + SSE-proxy a RUNNING subagent child exactly like its parent; without
   *  this the child probe 404s and Pi Web would load the .jsonl itself — a
   *  second writer racing the live child. */
  const findLiveSession = (sid: string): AgentSessionWrapper | undefined => {
    const child = getRpcSession(sid);
    return child?.isAlive() ? child : undefined;
  };
  const liveMeta = (session: AgentSessionWrapper) => ({
    id: session.sessionId,
    cwd: session.cwd,
    sessionFile: session.sessionFile,
    running: session.isRunning(),
  });

  return async (request, response, url) => {
    // NOTE: the collection routes must be matched BEFORE the /:id probe
    // regex — "running" / "live" / "busy" would otherwise be treated as a
    // session id.
    if (request.method === "GET" && url.pathname === "/v1/sessions/running") {
      // `stalled` is additive heartbeat data (sessions running but silent
      // past STALL_WARN_MS — see lib/daemon/session-heartbeat.ts); consumers
      // that only read `ids` are unaffected.
      sendJson(response, 200, { ids: getRunningRpcSessionIds(), stalled: getStalledSessionSnapshot() });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions/running/events") {
      serveRunningSse(request, response);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions/live") {
      // Metas of every alive wrapper (interactive + children + kit rounds):
      // lets the web session-list route synthesize brand-new sessions whose
      // .jsonl has not been flushed/scanned yet.
      sendJson(response, 200, { sessions: getLiveRpcSessionInfos() });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions/busy") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        sendJson(response, 400, { error: "cwd query parameter is required" });
        return true;
      }
      sendJson(response, 200, { busy: hasBusyRpcSessionForCwd(cwd) });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions/reload-cwd") {
      const input = await readJsonBody(request) as { cwd?: string };
      if (!input.cwd || typeof input.cwd !== "string") {
        sendJson(response, 400, { error: "cwd is required" });
        return true;
      }
      // Trust change: destroy every wrapper under this cwd so the next
      // command cold-starts with fresh resource loading (extensions/skills).
      sendJson(response, 200, { destroyed: destroyRpcSessionsForCwd(input.cwd) });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const input = await readJsonBody(request) as {
        cwd?: string;
        provider?: string;
        modelId?: string;
        toolNames?: string[];
        thinkingLevel?: string;
        command?: { type: string; [key: string]: unknown };
      };
      if (!input.cwd || typeof input.cwd !== "string") {
        sendJson(response, 400, { error: "cwd is required" });
        return true;
      }
      if (!existsSync(input.cwd)) {
        sendJson(response, 400, { error: `Directory does not exist: ${input.cwd}` });
        return true;
      }
      // One-time key so startRpcSession's start-lock never coalesces two
      // concurrent creates onto one session (mirrors /api/agent/new).
      const tempKey = `__new__${randomUUID()}`;
      const { session, realSessionId } = await startRpcSession(tempKey, "", input.cwd, input.toolNames);
      if (input.provider && input.modelId) {
        await session.send({ type: "set_model", provider: input.provider, modelId: input.modelId });
      }
      if (input.thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: input.thinkingLevel });
      }
      const data = input.command ? await session.send(input.command) : null;
      // sessionFile lets the web process seed its id→path cache: the .jsonl
      // is created lazily (first append), so a disk scan right after creation
      // would miss the file and 404 — with the path seeded, GET /api/sessions/:id
      // resolves without a scan and can answer "empty but valid" until the
      // first append lands.
      sendJson(response, 200, { success: true, sessionId: realSessionId, cwd: session.cwd, sessionFile: session.sessionFile, data });
      return true;
    }
    const sessionCommand = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/commands$/);
    if (request.method === "POST" && sessionCommand) {
      const sid = decodeURIComponent(sessionCommand[1]);
      const command = await readJsonBody(request) as { type?: string };
      if (typeof command?.type !== "string") {
        sendJson(response, 400, { error: "command.type is required" });
        return true;
      }
      // Live session (interactive / subagent child / kit round) first, then
      // cold-start from the .jsonl on disk — the same revive semantics
      // /api/agent/[id] POST implements in the web process.
      const live = findLiveSession(sid);
      if (live) {
        sendJson(response, 200, { success: true, data: await live.send(command) });
        return true;
      }
      const filePath = await resolveSessionPath(sid);
      if (!filePath) {
        sendJson(response, 404, { error: "Session not found" });
        return true;
      }
      const header = SessionManager.open(filePath).getHeader();
      const cwd = header?.cwd ?? process.cwd();
      const { session } = await startRpcSession(sid, filePath, cwd);
      sendJson(response, 200, { success: true, data: await session.send(command) });
      return true;
    }
    // Session probe: Pi Web asks "does the daemon own this session?" before
    // falling back to loading the .jsonl itself. Returns metadata + live
    // state. Covers every live session in this process, including running
    // subagent children. (GET must be checked before DELETE — same path
    // pattern.)
    const sessionProbe = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionProbe) {
      const sid = decodeURIComponent(sessionProbe[1]);
      const session = findLiveSession(sid);
      if (!session) {
        sendJson(response, 404, { error: "session not live in daemon" });
        return true;
      }
      let state: unknown;
      try { state = await session.send({ type: "get_state" }); }
      catch { state = undefined; /* session not ready yet */ }
      sendJson(response, 200, { ...liveMeta(session), state });
      return true;
    }
    const sessionEvents = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (request.method === "GET" && sessionEvents) {
      const sid = decodeURIComponent(sessionEvents[1]);
      let session = findLiveSession(sid);
      if (!session) {
        // Cold-start: an idle session being VIEWED gets a wrapper here too
        // (same semantics the web events route had) so the browser gets its
        // `connected` frame + later events. The idle timer reaps it.
        const filePath = await resolveSessionPath(sid);
        if (!filePath) {
          sendJson(response, 404, { error: "session not found" });
          return true;
        }
        const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
        try {
          ({ session } = await startRpcSession(sid, filePath, cwd));
        } catch (error) {
          sendJson(response, 500, { error: `Failed to start session: ${String(error)}` });
          return true;
        }
      }
      serveSessionSse(request, response, session);
      return true;
    }
    const autoName = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/auto-name$/);
    if (request.method === "POST" && autoName) {
      const sid = decodeURIComponent(autoName[1]);
      const filePath = await resolveSessionPath(sid);
      if (!filePath) {
        sendJson(response, 404, { error: "Session not found" });
        return true;
      }
      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
      const live = findLiveSession(sid);
      const { session } = live
        ? { session: live }
        : await startRpcSession(sid, filePath, cwd);
      await session.waitUntilReady?.();
      const result = await generateSessionTitle(session.inner as unknown as AgentSession);
      if (!session.isAlive()) {
        sendJson(response, 409, { error: "The session was closed while its title was being generated." });
        return true;
      }
      session.inner.setSessionName(result.title);
      sendJson(response, 200, { title: result.title, usage: result.usage ?? null });
      return true;
    }
    // Best-effort wrapper teardown before the web layer deletes/archives the
    // session file: destroy the live wrapper so it stops appending to a file
    // that is about to move/disappear.
    if (request.method === "DELETE") {
      const sessionTeardown = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionTeardown) {
        const sid = decodeURIComponent(sessionTeardown[1]);
        getRpcSession(sid)?.destroy();
        sendJson(response, 200, { ok: true });
        return true;
      }
    }
    return false;
  };
}
