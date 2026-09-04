import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSseWriter, SSE_STALL_BYTES_DEFAULT } = await jiti.import("./sse-writer.ts");

/** Fake ServerResponse: `write` appends to an in-memory queue that only
 *  shrinks when the test explicitly drains it — writableLength mirrors Node's
 *  pending-write accounting that backpressure is built on. */
function fakeResponse({ drain = false } = {}) {
  return {
    chunks: [],
    destroyed: false,
    write(chunk) {
      this.chunks.push(chunk);
      if (drain) this.chunks.length = 0; // consumer keeps up
      return true;
    },
    get writableLength() {
      return this.chunks.reduce((n, c) => n + c.length, 0);
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test("writeEvent frames JSON events and never stalls while the consumer drains", () => {
  const response = fakeResponse({ drain: true });
  let stalls = 0;
  const writer = createSseWriter(response, () => stalls++);
  writer.writeEvent({ type: "connected" });
  writer.writeEvent({ type: "message_update", text: "hi" });
  assert.deepEqual(response.chunks, []);
  assert.equal(stalls, 0);
  assert.equal(writer.stalled, false);
});

test("a consumer that stops draining is cut off once buffered bytes exceed the cap", () => {
  const response = fakeResponse();
  let stalls = 0;
  const writer = createSseWriter(response, () => stalls++);
  writer.writeEvent({ type: "connected" }); // small — under the cap
  assert.equal(stalls, 0);
  // Bash tool partials re-send a full ≤50KB snapshot every 100ms; a connection
  // that never reads queues them all (the 2026-08-30 daemon OOM mechanism).
  const big = "x".repeat(50 * 1024);
  for (let i = 0; i < Math.ceil(SSE_STALL_BYTES_DEFAULT / big.length) + 1; i++) {
    writer.writeEvent({ type: "tool_execution_update", output: big });
  }
  assert.equal(stalls, 1);
  assert.equal(writer.stalled, true);
  const queued = response.chunks.length;
  // Post-stall writes are dropped — the zombie must not buffer anything more.
  writer.writeEvent({ type: "message_end" });
  assert.equal(response.chunks.length, queued);
});

test("writeRaw heartbeats are bounded by the same cap", () => {
  const response = fakeResponse();
  let stalls = 0;
  const writer = createSseWriter(response, () => stalls++);
  const big = "y".repeat(SSE_STALL_BYTES_DEFAULT + 1);
  writer.writeRaw(big);
  assert.equal(stalls, 1);
  writer.writeRaw(": \n\n");
  assert.equal(response.chunks.length, 1);
});

test("a burst below the cap does not stall, and a custom cap is honored", () => {
  const response = fakeResponse();
  let stalls = 0;
  const writer = createSseWriter(response, () => stalls++, { stallBytes: 100 });
  writer.writeRaw("a".repeat(99));
  assert.equal(stalls, 0);
  writer.writeRaw("b");
  assert.equal(stalls, 1);
});
