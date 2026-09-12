import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStatus } from "./status.ts";

test("running 用 sessionId 感知 stale 公式：死 pid + sessionId → running；死 pid 无 sessionId → 不 running", () => {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  const c = join(root, ".pi", "loops", "c"); mkdirSync(c, { recursive: true });
  writeFileSync(join(c, "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nc");
  // web 手动轮锁形态：pid=web 进程（已死）+ 已绑定 sessionId（轮活在 daemon）
  writeFileSync(join(c, ".round.lock"), JSON.stringify({ pid: 999999, host: "h", kind: "daemon", sessionId: "s-1", startedAt: Date.now() }));
  const d = join(root, ".pi", "loops", "d"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nd");
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: 999999, host: "h", kind: "beat", startedAt: Date.now() }));
  const entries = collectStatus(root);
  assert.equal(entries.find((e) => e.name === "c")?.running, true);  // 锁未超窗——轮仍算在跑
  assert.equal(entries.find((e) => e.name === "d")?.running, false); // 无 sessionId：pid 死即 stale
});

test("paused 可见并标记；running 由活锁判定；nextDue 由 .lastrun 推导", () => {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  const a = join(root, ".pi", "loops", "a"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\n---\nb");
  writeFileSync(join(a, ".lastrun"), "2024-01-15T10:00:00.000Z");
  const b = join(root, ".pi", "loops", "b"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nb");
  writeFileSync(join(b, "PAUSED"), "");
  writeFileSync(join(b, ".round.lock"), JSON.stringify({ pid: process.pid, host: "h", kind: "daemon", startedAt: Date.now() }));
  const entries = collectStatus(root);
  const ea = entries.find((e) => e.name === "a");
  const eb = entries.find((e) => e.name === "b");
  assert.equal(ea.paused, false);
  assert.equal(ea.running, false);
  assert.equal(ea.nextDue, "2024-01-15T10:30:00.000Z");
  assert.equal(eb.paused, true);
  assert.equal(eb.running, true); // 自己 pid 的活锁
});
