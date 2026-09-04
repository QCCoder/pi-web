/**
 * Bounded SSE writer for the daemon's event streams.
 *
 * Node buffers `response.write()` data that the peer has not read, without
 * limit, in this process's heap. An SSE viewer whose connection went zombie
 * (browser/dev-server hot reload, network blackhole — `close` never fires)
 * therefore buffers EVERY subsequent event: bash tool partials re-send a full
 * ≤50KB snapshot at up to 10Hz, so one stalled viewer on an active session
 * retains ~1MB/s — GBs over an afternoon, which is exactly how the daemon
 * died of V8 heap exhaustion on 2026-08-30 (SIGABRT ~3h after start, hours
 * before any disk evidence: no tool output ever crossed its 50KB truncation,
 * so nothing but the socket queues was left to grow).
 *
 * A healthy consumer drains continuously and never accumulates anywhere near
 * the cap; crossing it means the peer is gone or wedged, and the only sane
 * move is to cut the subscriber loose (the browser reconnects on its next
 * poll/reload — same recovery as any dropped SSE connection).
 */

/** Pending-write bytes at which a viewer is declared stalled. Generous for a
 * healthy localhost/proxy consumer (whole event bursts are KBs), tiny for the
 * daemon heap it protects. */
export const SSE_STALL_BYTES_DEFAULT = 1_000_000;

/** Structural slice of ServerResponse the writer needs — keeps the seam
 *  fake-able for lib/daemon/sse-writer.test.mjs without spinning up http. */
export interface SseStreamResponse {
  write(chunk: string): boolean;
  /** Bytes written but not yet flushed to the socket (Node backpressure). */
  readonly writableLength: number;
}

export interface SseWriterOptions {
  stallBytes?: number;
}

export interface SseWriter {
  /** Frame `data` as one SSE event; no-op once stalled. */
  writeEvent(data: unknown): void;
  /** Write a raw SSE line (heartbeat comments); no-op once stalled. */
  writeRaw(text: string): void;
  readonly stalled: boolean;
}

/** Wrap an SSE response with a stall cap. `onStall` fires at most once, when
 *  the peer's undrained queue first reaches `stallBytes` — the caller tears
 *  the subscription down there (unsubscribe, clear heartbeat, destroy). */
export function createSseWriter(
  response: SseStreamResponse,
  onStall: () => void,
  options: SseWriterOptions = {},
): SseWriter {
  const stallBytes = options.stallBytes ?? SSE_STALL_BYTES_DEFAULT;
  let stalled = false;
  const checkStall = (): void => {
    if (!stalled && response.writableLength >= stallBytes) {
      stalled = true;
      onStall();
    }
  };
  return {
    writeEvent(data: unknown): void {
      if (stalled) return;
      response.write(`data: ${JSON.stringify(data)}\n\n`);
      checkStall();
    },
    writeRaw(text: string): void {
      if (stalled) return;
      response.write(text);
      checkStall();
    },
    get stalled(): boolean {
      return stalled;
    },
  };
}
