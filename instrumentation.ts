export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Loop scheduling belongs to the independent `pi-loop` host. The web server
  // is only a management adapter and must never own unattended Loop timers.
}
