import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRoundLock, releaseRoundLock, readRoundLock, updateRoundLock, writeRoundLock, isProcessAlive } from "./round-lock.ts";

const dir = () => { const d = mkdtempSync(join(tmpdir(), "lock-")); return d; };
const holder = { pid: process.pid, host: "t", kind: "beat" };

test("acquire 成功 → 再 acquire 失败 → release 后可再 acquire", () => {
  const d = dir();
  assert.equal(acquireRoundLock(d, holder), true);
  assert.equal(acquireRoundLock(d, { ...holder, pid: 424242 }), false);
  assert.equal(readRoundLock(d)?.pid, process.pid);
  releaseRoundLock(d);
  assert.equal(acquireRoundLock(d, { ...holder, pid: 424242 }), true);
});

test("stale 锁（死 pid）被抢占", () => {
  const d = dir();
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: 999999, host: "x", kind: "beat", startedAt: Date.now() }));
  assert.equal(acquireRoundLock(d, holder), true);
  assert.equal(readRoundLock(d)?.pid, process.pid);
});

test("stale 锁（超窗）被抢占，未超窗不抢", () => {
  const d = dir();
  const old = Date.now() - 60_000;
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: process.pid, host: "x", kind: "daemon", startedAt: old }));
  assert.equal(acquireRoundLock(d, holder, { maxStaleMs: 1_000 }), true);       // 超窗
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: process.pid, host: "x", kind: "daemon", startedAt: old }));
  assert.equal(acquireRoundLock(d, holder, { maxStaleMs: 120_000 }), false);    // 未超窗且 pid 活
});

test("updateRoundLock 回填 sessionId", () => {
  const d = dir();
  acquireRoundLock(d, { ...holder, kind: "daemon" });
  updateRoundLock(d, { sessionId: "sess-1" });
  assert.equal(readRoundLock(d)?.sessionId, "sess-1");
});

test("writeRoundLock 换 holder（pid/host/kind）但保留已有 startedAt", () => {
  const d = dir();
  acquireRoundLock(d, holder);
  const startedAt = readRoundLock(d)?.startedAt;
  assert.ok(typeof startedAt === "number");
  writeRoundLock(d, { pid: 424242, host: "other-host", kind: "daemon" });
  const after = readRoundLock(d);
  assert.equal(after?.pid, 424242);          // holder 已换
  assert.equal(after?.host, "other-host");
  assert.equal(after?.kind, "daemon");
  assert.equal(after?.startedAt, startedAt);  // 起始时间不动 —— fire.ts 先 acquire 的宿主锁换手成子 pid 锁时不重置轮龄
});

test("isProcessAlive：自己活、999999 死", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999), false);
});
