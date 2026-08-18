export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Loop scheduling belongs to the independent `pi-loop` host. The web server
  // is only a management adapter and must never own unattended Loop timers.

  // Ensure the session daemon (the pi-loop host process, being promoted to THE
  // single session owner) is running: attach when healthy, spawn a detached
  // sidecar otherwise. Probe-first keeps daemon timers decoupled from web
  // restarts. Fire-and-forget so server boot is never blocked by it.
  if (process.env.PI_SESSION_DAEMON_DISABLED !== "1") {
    void import("@/lib/session-daemon/sidecar")
      .then((mod) => mod.ensureSessionDaemonStarted())
      .catch((err) => {
        console.error(
          "[session-daemon] sidecar start failed:",
          err instanceof Error ? err.message : err,
        );
      });
  }
}
