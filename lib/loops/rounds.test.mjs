import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopRound } from "./rounds.ts";
import { acquireRoundLock } from "../../pi-loop/round-lock.ts";

const DECL = {
  workspacePath: "/ws", loopName: "dev-loop", dir: "", pattern: "dev-loop",
  cron: "*/30 9-22 * * 1-5", timezone: "Asia/Shanghai", level: "L2", maxMinutes: 45, body: "b",
};

function makeLoopDir() {
  const dir = mkdtempSync(join(tmpdir(), "rounds-"));
  DECL.dir = dir; // 测试内直接改对象（简单起见；或每次构造新 DECL）
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: */30 9-22 * * 1-5\n---\nbody");
  return dir;
}

test("stopRound: no lock → not-running", async () => {
  makeLoopDir();
  const result = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} });
  assert.equal(result, "not-running");
});

test("stopRound: daemon lock → destroy + reap + release", async () => {
  makeLoopDir();
  const destroyed = [];
  const reaped = [];
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "s-1" });
  const result = await stopRound({ ...DECL }, {
    destroySession: async (sid) => { destroyed.push(sid); },
    reap: async (path) => { reaped.push(path); },
  });
  assert.equal(result, "stopped");
  assert.deepEqual(destroyed, ["s-1"]);
  assert.deepEqual(reaped, [DECL.workspacePath]);
  const { readRoundLock } = await import("../../pi-loop/round-lock.ts");
  assert.equal(readRoundLock(DECL.dir), undefined); // 锁已释放——下轮可补
});

test("stopRound: beat lock → beat-held，不动进程不释放", async () => {
  makeLoopDir();
  const destroyed = [];
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "beat" });
  const result = await stopRound({ ...DECL }, { destroySession: async (sid) => { destroyed.push(sid); }, reap: async () => {} });
  assert.equal(result, "beat-held");
  assert.equal(destroyed.length, 0);
});

test("stopRound: daemon lock without sessionId → not-running（启动窗口）", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon" });
  const result = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} });
  assert.equal(result, "not-running");
});

test("stopRound: stale lock（死 pid）→ 顺手清理 + not-running", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: 999999, host: "h", kind: "daemon", sessionId: "s-x" });
  const result = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} });
  assert.equal(result, "not-running");
});
