
/** Daemon base URL. PI_DAEMON_URL is the canonical name; PI_LOOP_URL is the
 *  legacy fallback kept so existing shells/systemd units keep working. */
const baseUrl = () =>
  (process.env.PI_DAEMON_URL ?? process.env.PI_LOOP_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");

/** Input for the session-daemon create route — mirrors /api/agent/new's body
 *  (cwd + optional pre-selection + optional first command). */
export interface CreateSessionInput {
  cwd: string;
  provider?: string;
  modelId?: string;
  toolNames?: string[];
  thinkingLevel?: string;
  command?: { type: string; [key: string]: unknown };
}

/** Max wait for the daemon on graceful-degradation probes. The daemon is on
 *  localhost and answers in single-digit ms when healthy; if it cannot answer
 *  within this window it is effectively unavailable (event loop blocked by a
 *  runaway session, a long sync op, GC storm, etc.) and callers MUST fall
 *  through fast instead of hanging the web UI's session routes. Keep well under
 *  the 5s SSE connect timeout (CONNECT_TIMEOUT_MS in global-agent-events.ts):
 *  probe (2s) + cold startRpcSession (~1-2s) must fit before that window. */
const PROBE_TIMEOUT_MS = 2_000;

/** Metadata + live state for a session physically owned by the daemon.
 *  Pi Web probes this to decide whether to proxy the daemon's event stream
 *  instead of loading the .jsonl into its own process (which would race the
 *  daemon for the same file). Local to this module — consumers go through
 *  `daemonClient.probeSession()`'s return type. */
interface DaemonSessionMeta {
  id: string;
  cwd?: string;
  sessionFile?: string;
  running: boolean;
  state?: unknown;
}

/** Error thrown for non-2xx daemon responses. Carries the daemon's HTTP
 *  status so web proxies can surface it faithfully (e.g. 404 session-not-found). */
export class DaemonHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DaemonHttpError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, init);
  } catch {
    throw new Error(`Session daemon is unavailable at ${baseUrl()}`);
  }
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new DaemonHttpError(value.error ?? `Session daemon returned HTTP ${response.status}`, response.status);
  return value;
}

/** HTTP client for the pi-daemon process (sessions). */
export const daemonClient = {
  /** Session-daemon surface (C2 Phase 1): create a new session in the daemon
   *  process. Response carries the real pi session id plus the session cwd so
   *  the web proxy can sync its file-access allow-list. */
  createSession: (input: CreateSessionInput) => request<{ success: boolean; sessionId: string; cwd: string; sessionFile?: string; data: unknown }>("/v1/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  /** Session-daemon surface: send any command to a session the daemon owns
   *  (or revives from disk). Mirrors POST /api/agent/[id]. */
  sendSessionCommand: (sessionId: string, command: { type: string; [key: string]: unknown }) =>
    request<{ success: boolean; data: unknown }>(`/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
    }),
  /** Session-daemon surface: the complete set of running session ids in the
   *  daemon process (interactive sessions + subagent children + kit heartbeat
   *  rounds — the registry is keyed by real session id). */
  runningSessionIds: () => request<{ ids: string[] }>("/v1/sessions/running"),
  /** Session-daemon surface: metas of every alive wrapper (for the web
   *  session-list route's live-session synthesis). */
  liveSessions: () => request<{ sessions: Array<{ id: string; cwd: string; sessionFile?: string }> }>(
    "/v1/sessions/live",
  ),
  /** Session-daemon surface: SSE of the running-id set (interactive + children
   *  + kit rounds — the complete answer), for the web route to proxy. */
  runningEvents: (signal?: AbortSignal) =>
    fetch(`${baseUrl()}/v1/sessions/running/events`, { signal }),
  /** Session-daemon surface: is any session in the daemon busy (starting or
   *  running) under this cwd? Replaces the web-side registry check. */
  busyForCwd: (cwd: string) => request<{ busy: boolean }>(
    `/v1/sessions/busy?cwd=${encodeURIComponent(cwd)}`,
  ),
  /** Session-daemon surface: destroy every wrapper under this cwd (project
   *  trust changed — next command cold-starts with fresh resources). */
  reloadCwdSessions: (cwd: string) => request<{ destroyed: number }>("/v1/sessions/reload-cwd", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
  }),
  /** Session-daemon surface: generate + apply an auto title to a session the
   *  daemon owns (or revives from disk). */
  autoNameSession: (sessionId: string) => request<{ title: string; usage: unknown }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/auto-name`,
    { method: "POST" },
  ),
  /** Session-daemon surface: best-effort destroy of a live wrapper. Called by
   *  the web layer before it deletes or archives the session file. */
  destroySession: (sessionId: string) => request<{ ok: boolean }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  ),
  /** Ask the daemon whether it owns a given pi session id. Returns null
   *  when the daemon is unreachable OR does not own the session, so callers can
   *  fall back to the normal local .jsonl path without distinguishing the two. */
  probeSession: async (sessionId: string): Promise<DaemonSessionMeta | null> => {
    let response: Response;
    try {
      // A hung/sick host still accepts the socket but never responds. Without a
      // timeout this await blocks the caller's session route indefinitely — the
      // root cause of "Timed out connecting to the agent event stream": the SSE
      // `connected` frame is gated behind this probe, so it never fires within
      // the client's 5s window. The bounded timeout lets a healthy host answer
      // instantly while forcing a fast fall-through to the local .jsonl path
      // when the host is unresponsive. (The trade-off — treating a merely-busy
      // host as down and loading the .jsonl here — is the lesser evil.)
      response = await fetch(`${baseUrl()}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    return await response.json().catch(() => null) as DaemonSessionMeta | null;
  },
  /** Open the raw SSE response for a session the daemon owns so Pi Web can
   *  proxy (pipe) its body straight to the browser. */
  sessionEvents: (sessionId: string, signal?: AbortSignal) =>
    fetch(`${baseUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/events`, { signal }),
};
