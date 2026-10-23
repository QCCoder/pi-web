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

test("stalled viewer is cut off at the undrained-backlog cap instead of buffering forever", async () => {
  // 积压（undrained backlog）超限后 writeEvent 变 no-op 且标记 stalled。
  // 用可注入 desiredSize 的内部 writer 直接验证（导出 createWebSseWriter）：
  // fake controller 的 desiredSize = 预算 − 未排水积压（enqueue 增、drain 减），
  // 即平台 ByteLengthQueuingStrategy 的排水感知语义。
  const { createWebSseWriter } = sse;
  const budget = 100;
  const makeController = () => {
    let backlog = 0; // undrained bytes
    return {
      enqueue() { backlog += 20; },
      drain() { backlog = 0; },
      get desiredSize() { return budget - backlog; },
    };
  };

  // 停止排水的观众：积压跨过预算 → stalled，onStall 恰好一次，之后写为 no-op。
  let stallCalls = 0;
  const stalledCtrl = makeController();
  const writer = createWebSseWriter(stalledCtrl, () => { stallCalls++; });
  for (let i = 0; i < 50; i++) writer.writeEvent({ pad: "x".repeat(30) });
  assert.equal(writer.stalled, true);
  assert.equal(stallCalls, 1);

  // 健康观众：每次写入后排水 → desiredSize 回升 → 累计写入远超预算也不断流
  // （回归：旧实现按累计字节计数，会误伤持续排水的观众）。
  const healthyCtrl = makeController();
  const healthy = createWebSseWriter(healthyCtrl, () => { stallCalls++; });
  for (let i = 0; i < 200; i++) {
    healthy.writeEvent({ pad: "x".repeat(30) });
    healthyCtrl.drain();
  }
  assert.equal(healthy.stalled, false);
  assert.equal(stallCalls, 1); // 仍只有第一个观众触发过
});
