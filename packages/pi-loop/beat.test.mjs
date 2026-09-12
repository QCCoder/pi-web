import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beatRoot, beatRoundRunner, stopRound } from "./beat.ts";

function fakePi(dir, body) {
  const bin = join(dir, "fake-pi.sh");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}
function setup(root = mkdtempSync(join(tmpdir(), "beat-"))) {
  const dir = join(root, ".pi", "loops", "l");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\nmax_minutes: 1\n---\nb");
  return { root, dir };
}

test("beatRoot 到期起轮：.lastrun 写入、锁释放、fake pi 收到合同", async () => {
  const { root, dir } = setup();
  // fake pi 的 argv: $1=--name $2=<名> $3=-p $4=--approve $5=<合同> — 把合同落盘供断言
  process.env.PI_BIN = fakePi(root, `echo "$5" > "${join(root, "prompt.txt")}"`);
  const result = await beatRoot(root);
  assert.deepEqual(result.fired, ["l"]);
  assert.ok(existsSync(join(dir, ".lastrun")));
  assert.ok(!existsSync(join(dir, ".round.lock")));
  const prompt = readFileSync(join(root, "prompt.txt"), "utf8");
  assert.ok(prompt.includes("一次性心跳轮"));
  delete process.env.PI_BIN;
});

test("beatRoot 未到期 → skipped，不起进程", async () => {
  const { root, dir } = setup();
  writeFileSync(join(dir, ".lastrun"), new Date().toISOString()); // 刚跑过，*/30 未到
  process.env.PI_BIN = fakePi(root, `echo bad > ${join(root, "should-not-exist")}`);
  const result = await beatRoot(root);
  assert.deepEqual(result.skipped, ["l"]);
  assert.ok(!existsSync(join(root, "should-not-exist")));
  delete process.env.PI_BIN;
});

test("双 loop 独立性：一次 beat 各自起轮，.lastrun/锁 per-loop 互不干扰", async () => {
  const root = mkdtempSync(join(tmpdir(), "beat-dual-"));
  try {
    for (const name of ["a", "b"]) {
      const dir = join(root, ".pi", "loops", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "LOOP.md"), "---\ncron: \"* * * * *\"\ntimezone: UTC\nmax_minutes: 5\n---\nb");
    }
    process.env.PI_BIN = fakePi(root, "exit 0");
    const result = await beatRoot(root);
    assert.deepEqual([...result.fired].sort(), ["a", "b"]); // 两个 loop 都 fire（readdir 序不保证，排序后比对）
    assert.deepEqual(result.failed, []);
    for (const name of ["a", "b"]) {
      const dir = join(root, ".pi", "loops", name);
      assert.ok(existsSync(join(dir, ".lastrun")), `${name} 有自己的 .lastrun`);
      assert.ok(!existsSync(join(dir, ".round.lock")), `${name} 锁已释放`);
    }
    delete process.env.PI_BIN;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopRound 杀掉 beat 持有的睡眠轮", async () => {
  const { root, dir } = setup();
  process.env.PI_BIN = fakePi(root, "sleep 60");
  const round = beatRoundRunner({ workspacePath: root, loopName: "l", dir, pattern: "l", cron: "* * * * *", timezone: "UTC", level: "L1", maxMinutes: 5, body: "b" });
  await new Promise((r) => setTimeout(r, 300)); // 等锁落盘
  const outcome = await stopRound(root, "l");
  assert.equal(outcome.ok, true);
  await assert.rejects(round); // 被杀 → exit 非 0 → runner reject，且不悬挂
  delete process.env.PI_BIN;
});

test("stopRound 对 daemon 持有的锁给出指引", async () => {
  const { root, dir } = setup();
  writeFileSync(join(dir, ".round.lock"), JSON.stringify({ pid: process.pid, host: "h", kind: "daemon", sessionId: "s1", startedAt: Date.now() }));
  const outcome = await stopRound(root, "l");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /pi-web/);
});
