import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { serveSessionSse } = await jiti.import("./http-sessions.ts");

/** Minimal fake wrapper: captures the event callback so the test can drive
 *  agent events into the stream, and records unsubscribe/destroy teardown. */
function fakeSession() {
  const session = {
    sessionId: "sess-1",
    unsubscribed: false,
    onEvent(cb) {
      session._emit = cb;
      return () => {
        session.unsubscribed = true;
      };
    },
    onDestroy() {
      return () => {};
    },
  };
  return session;
}

function fakeRequest() {
  const handlers = new Map();
  return {
    on(event, cb) {
      handlers.set(event, cb);
    },
    close() {
      handlers.get("close")?.();
    },
  };
}

function fakeResponse({ drain = false } = {}) {
  return {
    headers: null,
    chunks: [],
    lastChunk: "",
    destroyed: false,
    writeHead(status, headers) {
      this.headers = { status, ...headers };
    },
    write(chunk) {
      this.chunks.push(chunk);
      this.lastChunk = chunk;
      if (drain) this.chunks.length = 0;
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

test("serveSessionSse streams events to a draining viewer and tears down on close", async () => {
  const session = fakeSession();
  const request = fakeRequest();
  const response = fakeResponse({ drain: true });
  serveSessionSse(request, response, session);

  assert.equal(response.headers.status, 200);
  // drain mode empties the queue but must still have FRAMED the event.
  assert.match(response.lastChunk, /connected/);
  session._emit({ type: "message_end" });
  assert.equal(response.writableLength, 0);
  assert.equal(session.unsubscribed, false);
  assert.equal(response.destroyed, false);

  request.close();
  assert.equal(session.unsubscribed, true);
  assert.equal(response.destroyed, true);
});

test("serveSessionSse drops a subscriber whose connection stops draining (regression: 2026-08-30 daemon OOM)", async () => {
  const session = fakeSession();
  const request = fakeRequest();
  // A zombie TCP connection: every write queues, nothing ever drains.
  const response = fakeResponse();
  serveSessionSse(request, response, session);

  // Tool partials re-send a full ≤50KB snapshot at up to 10Hz — ~1MB/s of
  // broadcast that an unread socket buffers in the daemon heap until the
  // ~4GB default heap limit aborts the process. The stream must cut the
  // subscriber off at the cap instead.
  const big = "x".repeat(50 * 1024);
  let guard = 0;
  while (!response.destroyed && guard++ < 100) {
    session._emit({ type: "tool_execution_update", output: big });
  }
  assert.ok(response.destroyed, "stalled subscriber was not cut off");
  assert.equal(session.unsubscribed, true, "event subscription leaked past the stall");
  const queued = response.chunks.length;
  session._emit({ type: "message_end" });
  assert.equal(response.chunks.length, queued, "events kept buffering after the stall");
});
