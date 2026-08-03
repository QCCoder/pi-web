export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Start the Loop scheduler on boot (it runs inside this server process, the
  // single session owner). Skip during `next build`; catch-up handles any runs
  // missed while the server was down. Wrapped so a scheduler failure can never
  // block server startup.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    try {
      const { ensureLoopSchedulerStarted } = await import("@/lib/loop/scheduler");
      ensureLoopSchedulerStarted();
    } catch (error) {
      console.error(
        "[loop] failed to start scheduler:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Start feishu-channel long-connections for workspaces that have the
  // capability + credentials. Fire-and-forget so server boot is not blocked by
  // disk I/O or the WS dial; channels connect in the background. Dynamic import
  // keeps this (and its global WebSocket usage) out of the edge/browser bundle.
  if (process.env.PI_FEISHU_CHANNEL_DISABLED !== "1") {
    void import("@/lib/feishu-channel/manager")
      .then((mod) => mod.ensureAllFeishuChannelsStarted())
      .catch((err) => {
        console.error(
          "[feishu-channel] failed to start at boot:",
          err instanceof Error ? err.message : err,
        );
      });
  }
}
