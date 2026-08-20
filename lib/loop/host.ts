import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { DefaultLoopRuntime } from "./runtime.ts";
import { PiRoundExecutionBackend } from "./pi-execution.ts";
import { LoopHostScheduler } from "./scheduler.ts";
import { PiWorkspaceResolver } from "./workspace-resolver.ts";
import { LoopConflictError, LoopNotFoundError, LoopValidationError } from "./store.ts";
import { ImporterScheduler } from "../importers/scheduler.ts";
import { syncImporterForWorkspace } from "../importers/runner.ts";
import { findWorkItemByConversation } from "../work-items/service.ts";
import { seedExecutionSession } from "./seed.ts";
import { getRpcSession, getRunningRpcSessionIds, getLiveRpcSessionInfos, hasBusyRpcSessionForCwd, startRpcSession, subscribeRunningSessions, destroyRpcSessionsForCwd, type AgentSessionWrapper } from "../rpc-manager.ts";
import { resolveSessionPath } from "../session-reader.ts";
import { generateSessionTitle } from "../session-title.ts";
import type { LoopRunMeta, TriggerCommand } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 30142;

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** Stream a Loop-owned orchestrator session's agent events to an HTTP
 *  client (Pi Web proxies this to the browser so a Loop session that lives in
 *  this process can be watched live). Mirrors the SSE shape Pi Web emits.
 *  The stream also ends when the session is destroyed (round terminal /
 *  timeout / abort) — otherwise the browser-side pinned runtime would keep
 *  `agentRunning` true forever with no `agent_end` ever arriving. */
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

function errorStatus(error: unknown): number {
  if (error instanceof LoopNotFoundError) return 404;
  if (error instanceof LoopValidationError) return 400;
  if (error instanceof LoopConflictError) return 409;
  return 500;
}

/** SSE stream of the set of currently-running session ids in this process.
 *  Mirrors the shape Pi Web's /api/agent/running/events emits, so the web
 *  route can proxy it verbatim. Because the registry is keyed by real session
 *  id and holds interactive sessions, subagent children AND loop
 *  orchestrators alike, this single stream is the complete running answer —
 *  the web-side pin/reprobe/badge-merge dance existed only because its local
 *  set could never contain daemon-owned sessions. */
function serveRunningSse(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const write = (data: unknown) => {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  // Subscribe BEFORE the initial snapshot so no transition can slip between.
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

export function createLoopHost() {
  const workspaces = new PiWorkspaceResolver();
  // Name an orchestrator session after the requirement its run picked: the
  // orchestrator links itself to a work item by appending its session id to the
  // item's `conversations` (per the dev-loop LOOP.md), so we resolve the title
  // from that linkage. Returns undefined for runs that picked nothing (idle /
  // park-all) -> those keep their default title.
  const execution = new PiRoundExecutionBackend(async (workspacePath, sessionId) => {
    const item = await findWorkItemByConversation(workspacePath, sessionId);
    return item ? `(Loop) ${item.title}` : undefined;
  });
  /** Any live pi session in THIS host process: Loop orchestrators first
   *  (authoritative, indexed by real session id), then the ordinary rpc
   *  registry — which is where the subagent children an orchestrator spawns
   *  live (worker.ts starts them via startRpcSession). Exposing both lets Pi
   *  Web probe + SSE-proxy a RUNNING subagent child exactly like its
   *  orchestrator; without this the child probe 404s and Pi Web would load the
   *  .jsonl itself — a second writer racing the live child. */
  const findLiveSession = (sid: string): AgentSessionWrapper | undefined => {
    const orchestrator = execution.getBySessionId(sid);
    if (orchestrator) return orchestrator;
    const child = getRpcSession(sid);
    return child?.isAlive() ? child : undefined;
  };
  const liveMeta = (session: AgentSessionWrapper) => ({
    id: session.sessionId,
    cwd: session.cwd,
    sessionFile: session.sessionFile,
    running: session.isRunning(),
  });
  const runtime = new DefaultLoopRuntime(workspaces, execution);
  const scheduler = new LoopHostScheduler(runtime, workspaces);
  const importerScheduler = new ImporterScheduler();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, service: "pi-loop" });
      }
      const loops = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/loops$/);
      if (request.method === "GET" && loops) {
        return json(response, 200, { loops: await runtime.listLoops(decodeURIComponent(loops[1])) });
      }
      // ---- Session-daemon surface (C2 Phase 1) -------------------------------
      // The host is being promoted to THE single session-owning process. These
      // routes mirror Pi Web's /api/agent routes so the web layer can become a
      // pure proxy (Phase 2) and drop its own session registry (Phase 3).
      // NOTE: must be matched BEFORE the /v1/sessions/:id probe regex — "running"
      // would otherwise be treated as a session id.
      if (request.method === "GET" && url.pathname === "/v1/sessions/running") {
        // Registry is keyed by real session id and contains interactive
        // sessions, subagent children AND loop orchestrators alike — so this
        // single set is the complete "what is running" answer for the whole
        // process (the web-side loop-badge merge hack becomes unnecessary).
        return json(response, 200, { ids: getRunningRpcSessionIds() });
      }
      const runningSse = url.pathname === "/v1/sessions/running/events";
      if (request.method === "GET" && runningSse) {
        serveRunningSse(request, response);
        return;
      }
      const liveSessions = url.pathname === "/v1/sessions/live";
      if (request.method === "GET" && liveSessions) {
        // Metas of every alive wrapper (interactive + children + orchestrators):
        // lets the web session-list route synthesize brand-new sessions whose
        // .jsonl has not been flushed/scanned yet, same as its old local-registry
        // merge did.
        return json(response, 200, { sessions: getLiveRpcSessionInfos() });
      }
      const busyByCwd = url.pathname === "/v1/sessions/busy";
      if (request.method === "GET" && busyByCwd) {
        const cwd = url.searchParams.get("cwd");
        if (!cwd) return json(response, 400, { error: "cwd query parameter is required" });
        return json(response, 200, { busy: hasBusyRpcSessionForCwd(cwd) });
      }
      const reloadCwd = url.pathname === "/v1/sessions/reload-cwd";
      if (request.method === "POST" && reloadCwd) {
        const input = await body(request) as { cwd?: string };
        if (!input.cwd || typeof input.cwd !== "string") {
          return json(response, 400, { error: "cwd is required" });
        }
        // Trust change: destroy every wrapper under this cwd so the next
        // command cold-starts with fresh resource loading (extensions/skills).
        return json(response, 200, { destroyed: destroyRpcSessionsForCwd(input.cwd) });
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const input = await body(request) as {
          cwd?: string;
          provider?: string;
          modelId?: string;
          toolNames?: string[];
          thinkingLevel?: string;
          extraAgentDirs?: string[];
          command?: { type: string; [key: string]: unknown };
        };
        if (!input.cwd || typeof input.cwd !== "string") {
          return json(response, 400, { error: "cwd is required" });
        }
        if (!existsSync(input.cwd)) {
          return json(response, 400, { error: `Directory does not exist: ${input.cwd}` });
        }
        // One-time key so startRpcSession's start-lock never coalesces two
        // concurrent creates onto one session (mirrors /api/agent/new).
        const tempKey = `__new__${randomUUID()}`;
        const { session, realSessionId } = await startRpcSession(tempKey, "", input.cwd, input.toolNames, {
          extraAgentDirs: input.extraAgentDirs,
        });
        if (input.provider && input.modelId) {
          await session.send({ type: "set_model", provider: input.provider, modelId: input.modelId });
        }
        if (input.thinkingLevel) {
          await session.send({ type: "set_thinking_level", level: input.thinkingLevel });
        }
        const data = input.command ? await session.send(input.command) : null;
        // sessionFile lets the web process seed its id→path cache: the .jsonl is
        // created lazily (first append), so a disk scan right after creation
        // would miss the file and 404 — with the path seeded, GET /api/sessions/:id
        // resolves without a scan and can answer "empty but valid" until the
        // first append lands.
        return json(response, 200, { success: true, sessionId: realSessionId, cwd: session.cwd, sessionFile: session.sessionFile, data });
      }
      const sessionCommand = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/commands$/);
      if (request.method === "POST" && sessionCommand) {
        const sid = decodeURIComponent(sessionCommand[1]);
        const command = await body(request) as { type?: string };
        if (typeof command?.type !== "string") {
          return json(response, 400, { error: "command.type is required" });
        }
        // Loop orchestrators are driven exclusively through gate answers —
        // reject direct commands exactly like the web route does today.
        if (execution.getBySessionId(sid)) {
          return json(response, 409, {
            error: "This session is owned by the Loop Host. Interact via the Loop run gate, not direct messages.",
          });
        }
        // Live session (interactive / subagent child) first, then cold-start
        // from the .jsonl on disk — the same revive semantics /api/agent/[id]
        // POST implements in the web process.
        const live = findLiveSession(sid);
        if (live) {
          return json(response, 200, { success: true, data: await live.send(command) });
        }
        const filePath = await resolveSessionPath(sid);
        if (!filePath) return json(response, 404, { error: "Session not found" });
        const header = SessionManager.open(filePath).getHeader();
        const cwd = header?.cwd ?? process.cwd();
        const { session } = await startRpcSession(sid, filePath, cwd);
        return json(response, 200, { success: true, data: await session.send(command) });
      }
      // ---- End session-daemon surface ---------------------------------------
      if (request.method === "POST" && url.pathname === "/v1/triggers") {
        return json(response, 202, await runtime.trigger(await body(request) as TriggerCommand));
      }
      // Session probe: Pi Web asks "do you own this session?" before falling
      // back to loading the .jsonl itself. Returns metadata + live state.
      // Covers orchestrators AND their running subagent children (both live in
      // this process).
      const sessionProbe = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionProbe) {
        const sid = decodeURIComponent(sessionProbe[1]);
        const session = findLiveSession(sid);
        // Orchestrator run meta (any state, incl. gate-paused) rides along on the
        // probe so the web state route can surface a gate answer where the user
        // already is — the chat tab of the orchestrator session.
        let loop: LoopRunMeta | undefined;
        try { loop = await runtime.findBySessionId(sid); } catch { /* best effort */ }
        if (!session) {
          // Cold orchestrator (host restarted while a gate is paused — the
          // wrapper expired; the run is recoverable on the next gate answer).
          // Answer the probe anyway so the web layer pins the session and shows
          // the gate bar instead of enabling a composer that would 409 (or
          // worse, bypass answerGate into an untracked prompt).
          if (loop && (loop.run.status === "waiting_for_gate" || loop.run.status === "running")) {
            return json(response, 200, { id: sid, running: false, state: undefined, loop });
          }
          return json(response, 404, { error: "session not live in loop host" });
        }
        let state: unknown;
        try { state = await session.send({ type: "get_state" }); }
        catch { state = undefined; /* session not ready yet */ }
        return json(response, 200, { ...liveMeta(session), state, ...(loop ? { loop } : {}) });
      }
      // Session event stream: Pi Web proxies this SSE so the browser can watch
      // a Loop orchestrator — or its running subagent child — live, exactly
      // like a local session.
      const sessionEvents = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      if (request.method === "GET" && sessionEvents) {
        const sid = decodeURIComponent(sessionEvents[1]);
        let session = findLiveSession(sid);
        if (!session) {
          // Cold-start: an idle session being VIEWED gets a wrapper here too
          // (same semantics the web events route had) so the browser gets its
          // `connected` frame + later events. The idle timer reaps it.
          const filePath = await resolveSessionPath(sid);
          if (!filePath) return json(response, 404, { error: "session not found" });
          const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
          try {
            ({ session } = await startRpcSession(sid, filePath, cwd));
          } catch (error) {
            return json(response, 500, { error: `Failed to start session: ${String(error)}` });
          }
        }
        serveSessionSse(request, response, session);
        return;
      }
      const autoName = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/auto-name$/);
      if (request.method === "POST" && autoName) {
        const sid = decodeURIComponent(autoName[1]);
        if (execution.getBySessionId(sid)) {
          return json(response, 409, { error: "Loop orchestrator sessions are named by the loop" });
        }
        const filePath = await resolveSessionPath(sid);
        if (!filePath) return json(response, 404, { error: "Session not found" });
        const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
        const live = findLiveSession(sid);
        const { session } = live
          ? { session: live }
          : await startRpcSession(sid, filePath, cwd);
        await session.waitUntilReady?.();
        const result = await generateSessionTitle(session.inner as unknown as AgentSession);
        if (!session.isAlive()) {
          return json(response, 409, { error: "The session was closed while its title was being generated." });
        }
        session.inner.setSessionName(result.title);
        return json(response, 200, { title: result.title, usage: result.usage ?? null });
      }
      // Best-effort wrapper teardown before the web layer deletes/archives the
      // session file: destroy the live wrapper so it stops appending to a file
      // that is about to move/disappear. Loop orchestrators are skipped — their
      // lifecycle belongs to the loop engine (a mid-run file loss is handled by
      // the orphan-gate reaper, not by destroying the round).
      // NOTE: must run BEFORE the GET probe below — same path pattern.
      if (request.method === "DELETE") {
        const sessionTeardown = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
        if (sessionTeardown) {
          const sid = decodeURIComponent(sessionTeardown[1]);
          if (!execution.getBySessionId(sid)) {
            getRpcSession(sid)?.destroy();
          }
          return json(response, 200, { ok: true });
        }
      }
      const run = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)$/);
      if (request.method === "GET" && run) {
        return json(response, 200, {
          run: await runtime.getRun(decodeURIComponent(run[1]), decodeURIComponent(run[2])),
        });
      }
      const gate = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/gate$/);
      if (request.method === "POST" && gate) {
        const input = await body(request) as { message?: string };
        return json(response, 200, {
          run: await runtime.answerGate({
            message: typeof input.message === "string" ? input.message : "",
            workspaceId: decodeURIComponent(gate[1]),
            runId: decodeURIComponent(gate[2]),
          }),
        });
      }
      // Independent abort: destroy the orchestrator session and mark the run
      // failed. Works whether the run is running or paused at a gate.
      const abort = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/abort$/);
      if (request.method === "POST" && abort) {
        return json(response, 200, {
          run: await runtime.abortRun(decodeURIComponent(abort[1]), decodeURIComponent(abort[2])),
        });
      }
      // Importer manual/webhook sync — a non-Loop system task. Runs the same
      // runner the ImporterScheduler cron uses, just on demand.
      const importerSync = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/importers\/sync$/);
      if (request.method === "POST" && importerSync) {
        const summary = await syncImporterForWorkspace(decodeURIComponent(importerSync[1]));
        return json(response, 200, { summary });
      }
      // v3 seeding: the work-item "按合同执行" button. Same deterministic
      // seeder the engine uses after a selection round (guard + skill prompt +
      // bookkeeping), exposed so the human entry path is byte-identical to the
      // cron path. skillId defaults to the workspace's first enabled loop id
      // (convention: loop id === skill name).
      const seedRoute = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/seed$/);
      if (request.method === "POST" && seedRoute) {
        const workspaceId = decodeURIComponent(seedRoute[1]);
        const input = await body(request) as { key?: string; mode?: string; skillId?: string };
        if (!input.key || !/^(?:REQ|BUG)-\d+$/i.test(input.key)) {
          return json(response, 400, { error: "key must look like REQ-0001 or BUG-0001" });
        }
        if (input.mode !== undefined && input.mode !== "execute" && input.mode !== "adopt") {
          return json(response, 400, { error: "mode must be execute or adopt" });
        }
        const workspace = await workspaces.get(workspaceId);
        let skillId = input.skillId;
        if (!skillId) {
          const loops = await runtime.listLoops(workspaceId);
          const enabled = loops.find((loop) => loop.enabled);
          if (!enabled) return json(response, 409, { error: "workspace has no enabled loop to seed from" });
          skillId = enabled.id;
        }
        const result = await seedExecutionSession({
          workspaceId,
          workspacePath: workspace.path,
          skillId,
          key: input.key.toUpperCase(),
          mode: input.mode,
        });
        return json(response, 200, { seed: result });
      }
      return json(response, 404, { error: "route not found" });
    } catch (error) {
      console.error("[pi-loop] request failed:", error);
      return json(response, errorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { server, scheduler, runtime, importerScheduler };
}

export async function startLoopHost(options: { host?: string; port?: number } = {}): Promise<void> {
  const host = options.host ?? process.env.PI_LOOP_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.PI_LOOP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PI_LOOP_PORT must be a valid port");
  const app = createLoopHost();
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, host, () => resolve());
  });
  app.scheduler.start();
  app.importerScheduler.start();
  // Reap ghost gates: runs paused at a gate whose orchestrator `.jsonl` was
  // archived/removed (e.g. an idle-timed-out session whose file later got
  // archived) can never be resumed. Mark them failed so the UI stops offering a
  // dead gate. Runs whose file is still live are left for transparent rehydrate.
  try {
    const reaped = await app.runtime.reapOrphanedGates();
    if (reaped > 0) console.log(`[pi-loop] reaped ${reaped} orphaned gate run(s)`);
  } catch (error) {
    console.error("[pi-loop] orphan-gate reap failed:", error);
  }
  console.log(`[pi-loop] listening on http://${host}:${port}`);
  const stop = () => {
    app.scheduler.stop();
    app.importerScheduler.stop();
    app.server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
