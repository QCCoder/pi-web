import test from "node:test";
import assert from "node:assert/strict";
import { waitForTurnSettle } from "./turn-settle.ts";

/** 最小 wrapper fake：只暴露 waitForTurnSettle 订阅的三个口子。 */
function fakeWrapper() {
  const listeners = new Set();
  const destroyListeners = new Set();
  return {
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onDestroy: (cb) => { destroyListeners.add(cb); return () => destroyListeners.delete(cb); },
    emitEvent: (event) => { for (const cb of [...listeners]) cb(event); },
    emitDestroy: () => { for (const cb of [...destroyListeners]) cb(); },
  };
}

test("prompt_done → resolve", async () => {
  const wrapper = fakeWrapper();
  const pending = waitForTurnSettle(wrapper, 60_000);
  wrapper.emitEvent({ type: "prompt_done" });
  await pending;
});

test("prompt_error → reject 原始错误；settle 后订阅注销，迟到事件不再触发", async () => {
  const wrapper = fakeWrapper();
  const pending = waitForTurnSettle(wrapper, 60_000);
  wrapper.emitEvent({ type: "prompt_error", errorMessage: "boom" });
  await assert.rejects(pending, /boom/);
  wrapper.emitEvent({ type: "prompt_done" }); // 迟到事件无害
});

test("destroy → 立即 reject（不干等天花板）", async () => {
  const wrapper = fakeWrapper();
  const pending = waitForTurnSettle(wrapper, 60_000);
  wrapper.emitDestroy();
  await assert.rejects(pending, /session destroyed/);
});

test("天花板超时 → reject（unref 定时器，闹钟撑住事件循环）", async () => {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(waitForTurnSettle(fakeWrapper(), 30), /timed out/);
  } finally {
    clearInterval(keepAlive);
  }
});
