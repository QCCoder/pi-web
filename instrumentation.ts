export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // The Next.js Node.js server is the single session owner now: boot the
  // in-process host (migration guard + loop heartbeats + shutdown hooks).
  // Fire-and-forget so server boot is never blocked.
  const { ensureHostBooted } = await import("@/lib/session-host/background");
  ensureHostBooted();

  // 初始化时补建默认「默认」工作区（幂等 + 墓碑，见 lib/workspaces/service.ts）。
  void import("@/lib/workspaces/service")
    .then((mod) => mod.ensureDefaultWorkspace())
    .catch((err) => {
      console.error("[workspaces] ensure default workspace failed:", err instanceof Error ? err.message : err);
    });
}
