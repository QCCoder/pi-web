export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Background jobs (loop kit heartbeats) and every live session
  // belong to the independent pi-daemon process. The web server is only a
  // management adapter and must never own unattended timers.

  // Ensure the session daemon (bin/pi-daemon.js, THE single session owner)
  // is running: attach when healthy, spawn a detached
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

  // 初始化时补建默认「默认」工作区（随手问答/搜索的轻量落点；幂等 + 墓碑，
  // 用户删过就不再复活——见 lib/workspaces/service.ts 的 ensureDefaultWorkspace）。
  // fire-and-forget，永不阻塞启动。
  void import("@/lib/workspaces/service")
    .then((mod) => mod.ensureDefaultWorkspace())
    .catch((err) => {
      console.error(
        "[workspaces] ensure default workspace failed:",
        err instanceof Error ? err.message : err,
      );
    });
}
