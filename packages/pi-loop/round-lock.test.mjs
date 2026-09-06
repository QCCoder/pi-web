import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRoundLock, releaseRoundLock, readRoundLock, updateRoundLock, writeRoundLock, isProcessAlive, isRoundLockStale } from "./round-lock.ts";

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

test("isRoundLockStale 三态（唯一权威公式）：死 pid 仅在无 sessionId 时 stale；带 sessionId 只看时间窗", () => {
  const fresh = Date.now();
  // ① 死 pid + sessionId（web 手动轮锁，轮会话活在 daemon）→ 不 stale（时间窗治理）
  assert.equal(isRoundLockStale({ pid: 999999, host: "x", kind: "daemon", sessionId: "s-1", startedAt: fresh }, 60_000), false);
  // ② 死 pid 无 sessionId（启动窗口/beat 轮）→ pid 死即 stale（持有进程死=轮死）
  assert.equal(isRoundLockStale({ pid: 999999, host: "x", kind: "beat", startedAt: fresh }, 60_000), true);
  // ③ 活 pid 超窗 → stale（带不带 sessionId 都一样，时间窗是常归治理）
  assert.equal(isRoundLockStale({ pid: process.pid, host: "x", kind: "daemon", sessionId: "s-1", startedAt: fresh - 120_000 }, 60_000), true);
  assert.equal(isRoundLockStale({ pid: process.pid, host: "x", kind: "beat", startedAt: fresh - 120_000 }, 60_000), true);
  // 活 pid + 未超窗 → 不 stale（基线）
  assert.equal(isRoundLockStale({ pid: process.pid, host: "x", kind: "daemon", startedAt: fresh }, 60_000), false);
});

test("死 pid + sessionId 的锁不被抢占（web 重启后心跳不双发）；去掉 sessionId 则可抢占", () => {
  const d = dir();
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: 999999, host: "x", kind: "daemon", sessionId: "s-1", startedAt: Date.now() }));
  assert.equal(acquireRoundLock(d, holder, { maxStaleMs: 60_000 }), false); // 带 sessionId：pid 死也不抢
  assert.equal(readRoundLock(d)?.pid, 999999);                              // 原锁不动
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: 999999, host: "x", kind: "daemon", startedAt: Date.now() }));
  assert.equal(acquireRoundLock(d, holder, { maxStaleMs: 60_000 }), true);  // 无 sessionId：pid 死即 stale，抢占
  assert.equal(readRoundLock(d)?.pid, process.pid);
});

test("isProcessAlive：自己活、999999 死", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999), false);
});
