import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const sse = await jiti.import("./sse.ts");
const registry = await jiti.import("./registry.ts");

async function collect(stream, n) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (let i = 0; i < n; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  // Release the lock so later getReader() calls in the test can re-read.
  reader.releaseLock();
  return out;
}

test("session stream emits connected frame then events, closes on destroy", async () => {
  const inner = {
    sessionId: "s1", sessionFile: "/tmp/s1.jsonl", isBashRunning: false,
    isStreaming: false, isCompacting: false, extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" }, agent: { state: {} },
    subscribe(listener) { this._l = listener; return () => {}; }, dispose() {},
  };
  const w = new registry.AgentSessionWrapper(inner);
  // start() wires the wrapper's relay onto inner.subscribe (production always
  // starts wrappers via startRpcSession) — without it inner._l is undefined.
  w.start();
  const ac = new AbortController();
  const res = sse.serveSessionEventStream(w, ac.signal);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const first = await collect(res.body, 1);
  assert.match(first, /data: \{"type":"connected","sessionId":"s1"\}/);
  inner._l({ type: "message_chunk", text: "hi" });
  const second = await collect(res.body, 1);
  assert.match(second, /message_chunk/);
  w.destroy();  // onDestroy → 流关闭
  const { done } = await res.body.getReader().read().catch(() => ({ done: true }));
  assert.ok(done === true || done === undefined);
});

test("stalled viewer is cut off at the byte cap instead of buffering forever", async () => {
  // 不消费的流：写字节直到超限后 writeEvent 变 no-op 且标记 stalled。
  // 用可注入小上限的内部 writer 直接验证（导出 createWebSseWriter）。
  const { createWebSseWriter } = sse;
  let closed = false;
  const controller = { enqueue: () => {}, close: () => { closed = true; } };
  const writer = createWebSseWriter(controller, 100, () => { closed = true; });
  for (let i = 0; i < 50; i++) writer.writeEvent({ pad: "x".repeat(30) });
  assert.equal(writer.stalled, true);
  assert.equal(closed, true);
});
