import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchManualRound, RoundBusyError, stopRound } from "./rounds.ts";
import { acquireRoundLock, readRoundLock as readLock } from "../../packages/pi-loop/round-lock.ts";
import { readLastrun } from "../../packages/pi-loop/due.ts";

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
  assert.equal(readLock(DECL.dir), undefined); // 锁已释放——下轮可补
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
  assert.notEqual(readLock(DECL.dir), undefined); // 启动窗口分支不得释放——轮可能正在建
});

test("stopRound: stale 锁（死 pid 无 sessionId）→ 顺手清理 + not-running", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: 999999, host: "h", kind: "beat" });
  const result = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} });
  assert.equal(result, "not-running");
  assert.equal(readLock(DECL.dir), undefined); // stale 分支应释放
});

test("stopRound: 死 pid + sessionId 的手动轮锁（web 重启后）→ 不判 stale，走 destroy 停轮", async () => {
  makeLoopDir();
  const destroyed = [];
  const reaped = [];
  // web 手动轮锁形态：pid=web 进程（已死），轮会话 s-y 活在 daemon
  acquireRoundLock(DECL.dir, { pid: 999999, host: "h", kind: "daemon", sessionId: "s-y" });
  const result = await stopRound({ ...DECL }, {
    destroySession: async (sid) => { destroyed.push(sid); },
    reap: async (path) => { reaped.push(path); },
  });
  assert.equal(result, "stopped");            // 不再 not-running/误释放
  assert.deepEqual(destroyed, ["s-y"]);        // 停止按钮仍能摧毁 daemon 会话
  assert.deepEqual(reaped, [DECL.workspacePath]);
  assert.equal(readLock(DECL.dir), undefined); // 停止后锁释放
});

function makeDeps() {
  const calls = { created: [], commands: [], destroyed: [] };
  return {
    calls,
    deps: {
      createSession: async (input) => {
        calls.created.push(input);
        return { sessionId: "sess-1", cwd: input.cwd, sessionFile: "/x/sess-1.jsonl" };
      },
      sendCommand: async (sid, command) => {
        calls.commands.push({ sid, command });
      },
      destroySession: async (sid) => { calls.destroyed.push(sid); },
    },
  };
}

test("launchManualRound: 全序列——锁(daemon+sessionId) / .lastrun / 命名 / 含 sessionId 与优先行的合同", async () => {
  makeLoopDir();
  const { calls, deps } = makeDeps();
  const result = await launchManualRound({ ...DECL }, { itemKey: "REQ-0007" }, deps);
  assert.equal(result.sessionId, "sess-1");
  assert.deepEqual(calls.created, [{ cwd: DECL.workspacePath }]);
  const lock = readLock(DECL.dir);
  assert.equal(lock.kind, "daemon");
  assert.equal(lock.sessionId, "sess-1");
  assert.ok(readLastrun(DECL.dir)); // 手动轮也写 .lastrun（host §4 run 语义）
  const name = calls.commands[0].command;
  assert.equal(name.type, "set_session_name");
  assert.match(name.name, /^dev-loop · 手动 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const prompt = calls.commands[1].command;
  assert.equal(prompt.type, "prompt");
  assert.ok(prompt.message.includes("sess-1"));            // 合同 sessionId 行（D9 conversations 回填）
  assert.ok(prompt.message.includes("REQ-0007"));          // --item 优先行
  assert.ok(prompt.message.includes("/skill:dev-loop"));
  assert.equal(calls.destroyed.length, 0);
  // 锁保持持有（成功路径不释放——轮在跑）
  assert.ok(readLock(DECL.dir));
});

test("launchManualRound: 锁互斥 → RoundBusyError", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "other" });
  const { deps } = makeDeps();
  await assert.rejects(
    () => launchManualRound({ ...DECL }, {}, deps),
    RoundBusyError,
  );
});

test("launchManualRound: createSession 失败 → 释放锁 + destroy 尽力 + 抛原错误", async () => {
  makeLoopDir();
  const calls = { destroyed: [] };
  const deps = {
    createSession: async () => { throw new Error("daemon down"); },
    sendCommand: async () => {},
    destroySession: async (sid) => { calls.destroyed.push(sid); },
  };
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), /daemon down/);
  assert.equal(readLock(DECL.dir), undefined); // 锁已释放
  assert.deepEqual(calls.destroyed, []);       // 未建会话，无需 destroy
});

test("launchManualRound: prompt 发送失败 → destroy 半建会话 + 释放锁", async () => {
  makeLoopDir();
  const calls = { destroyed: [] };
  const deps = {
    createSession: async () => ({ sessionId: "sess-2" }),
    sendCommand: async () => { throw new Error("send failed"); },
    destroySession: async (sid) => { calls.destroyed.push(sid); },
  };
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), /send failed/);
  assert.deepEqual(calls.destroyed, ["sess-2"]);
  assert.equal(readLock(DECL.dir), undefined);
});

// ─── 幽灵锁活性接管（手动轮锁无人 await 轮结束，收尾后锁仍活）───

/** 把现有锁的 startedAt 改老（模拟过了宽限期的手动轮锁）。 */
function ageLock(dir, msAgo) {
  const lock = readLock(dir);
  writeFileSync(join(dir, ".round.lock"), JSON.stringify({ ...lock, startedAt: Date.now() - msAgo }, null, 2));
}

test("launchManualRound: 幽灵锁接管——锁活但 session 不在 running set → 释放重取，正常起轮", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "ghost-1" });
  ageLock(DECL.dir, 3 * 60_000); // 过宽限期（2min）
  const { calls, deps } = makeDeps();
  deps.runningSessionIds = async () => ["someone-else"];
  const result = await launchManualRound({ ...DECL }, {}, deps);
  assert.equal(result.sessionId, "sess-1");
  const lock = readLock(DECL.dir);
  assert.equal(lock.sessionId, "sess-1"); // 锁已易主——新轮是我们的
  assert.ok(readLastrun(DECL.dir));
});

test("launchManualRound: 锁活且 session 在 running set → RoundBusyError（真跑着，不接管）", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "s-live" });
  ageLock(DECL.dir, 3 * 60_000);
  const { deps } = makeDeps();
  deps.runningSessionIds = async () => ["s-live"];
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), RoundBusyError);
  assert.equal(readLock(DECL.dir).sessionId, "s-live"); // 锁不动
});

test("launchManualRound: 宽限期内（锁龄 < 2min）→ 不判幽灵，RoundBusyError", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "starting" });
  // 锁龄新（sessionId 回填后 prompt 到达 wrapper 前，会话尚未进 running set）
  const { deps } = makeDeps();
  deps.runningSessionIds = async () => [];
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), RoundBusyError);
  assert.equal(readLock(DECL.dir).sessionId, "starting");
});

test("launchManualRound: 未注入 runningSessionIds → 保守不接管，RoundBusyError", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "ghost-2" });
  ageLock(DECL.dir, 3 * 60_000);
  const { deps } = makeDeps(); // 无 runningSessionIds
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), RoundBusyError);
});

test("launchManualRound: 探测失败（daemon 不可达）→ 无法证明即不接管，RoundBusyError", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "ghost-3" });
  ageLock(DECL.dir, 3 * 60_000);
  const { deps } = makeDeps();
  deps.runningSessionIds = async () => { throw new Error("daemon unreachable"); };
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), RoundBusyError);
});

test("launchManualRound: beat 锁（无 sessionId）过宽限也不接管——pid/时间窗治理", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "beat" });
  ageLock(DECL.dir, 3 * 60_000); // beat 轮本来就全程无 sessionId
  const { deps } = makeDeps();
  deps.runningSessionIds = async () => [];
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), RoundBusyError);
  assert.ok(readLock(DECL.dir)); // beat 锁不被动
});

test("stopRound: 幽灵锁 → 清锁 + stopped，不 destroy", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "ghost-4" });
  ageLock(DECL.dir, 3 * 60_000);
  const destroyed = [];
  const result = await stopRound({ ...DECL }, {
    destroySession: async (sid) => { destroyed.push(sid); },
    reap: async () => {},
    runningSessionIds: async () => [],
  });
  assert.equal(result, "stopped");
  assert.equal(destroyed.length, 0); // 没杀任何进程
  assert.equal(readLock(DECL.dir), undefined); // 锁已清——立即可重跑
});

test("stopRound: 探测说在跑 → 走 destroy 原路径", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "s-live-2" });
  ageLock(DECL.dir, 3 * 60_000);
  const destroyed = [];
  const reaped = [];
  const result = await stopRound({ ...DECL }, {
    destroySession: async (sid) => { destroyed.push(sid); },
    reap: async (path) => { reaped.push(path); },
    runningSessionIds: async () => ["s-live-2"],
  });
  assert.equal(result, "stopped");
  assert.deepEqual(destroyed, ["s-live-2"]);
  assert.deepEqual(reaped, [DECL.workspacePath]);
  assert.equal(readLock(DECL.dir), undefined);
});
