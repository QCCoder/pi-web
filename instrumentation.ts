export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Loop scheduling belongs to the independent `pi-loop` host. The web server
  // is only a management adapter and must never own unattended Loop timers.

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
