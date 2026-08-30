import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchManualRound, RoundBusyError, stopRound } from "./rounds.ts";
import { acquireRoundLock, readRoundLock as readLock } from "../../pi-loop/round-lock.ts";
import { readLastrun } from "../../pi-loop/due.ts";

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
