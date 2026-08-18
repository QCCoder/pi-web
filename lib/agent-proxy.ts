import { ensureSessionDaemonStarted } from "./session-daemon/sidecar.ts";
import { loopHostClient } from "./loop/client.ts";

export { loopHostClient };

/** Map a session-daemon error to an HTTP status for proxy routes.
 *  DaemonHttpError carries the daemon's status (404 session-not-found, 409
 *  orchestrator-owned); transport failures map to 503 so the client can
 *  distinguish "daemon down" from "session gone". */
export function daemonErrorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return 503;
}

/** Proxy-route helper: make sure the session daemon is up (attach to a healthy
 *  one, spawn the sidecar otherwise — fast when healthy: one /health probe)
 *  before handing the caller the client. Imported by every /api/agent and
 *  session-lifecycle proxy route so a crashed daemon is revived on the next
 *  request instead of leaving the web UI dead until a manual restart. */
export async function daemonProxy(): Promise<typeof loopHostClient> {
  await ensureSessionDaemonStarted();
  return loopHostClient;
}
