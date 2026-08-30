import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync as exists } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLastrun } from "./due.ts";
import { runDueRound, runNow } from "./fire.ts";

const readLastrunIso = (d) => readFileSync(join(d, ".lastrun"), "utf8").trim();

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "fire-"));
  const dir = join(root, "loops", "l");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\nmax_minutes: 5\n---\nb");
  return { root, dir, decl: { workspacePath: root, loopName: "l", dir, pattern: "l", cron: "*/30 * * * *", timezone: "UTC", level: "L1", maxMinutes: 5, body: "b" } };
};
const holder = { pid: process.pid, host: "t", kind: "beat" };

test("未到期 → skipped，runner 不跑、.lastrun 不写", async () => {
  const { dir, decl } = setup();
  writeLastrun(dir, new Date("2024-01-15T10:00:00Z"));
  let ran = 0;
  const result = await runDueRound(decl, holder, async () => { ran++; }, { now: () => new Date("2024-01-15T10:15:00Z") });
  assert.equal(result, "skipped");
  assert.equal(ran, 0);
});

test("到期 → fired，runner 跑、.lastrun 前进、锁释放", async () => {
  const { dir, decl } = setup();
  writeLastrun(dir, new Date("2024-01-15T10:00:00Z"));
  const result = await runDueRound(decl, holder, async () => {}, { now: () => new Date("2024-01-15T10:31:00Z") });
  assert.equal(result, "fired");
  assert.equal(readLastrunIso(dir), "2024-01-15T10:31:00.000Z");
  assert.equal(exists(join(dir, ".round.lock")), false);
});

test("runner 抛错 → 错误向上传播，锁仍释放", async () => {
  const { dir, decl } = setup();
  await assert.rejects(runDueRound(decl, holder, async () => { throw new Error("boom"); }, { now: () => new Date("2024-01-15T10:31:00Z") }));
  assert.equal(exists(join(dir, ".round.lock")), false);
});

test("锁被他宿主持有 → busy", async () => {
  const { dir, decl } = setup();
  writeFileSync(join(dir, ".round.lock"), JSON.stringify({ pid: process.pid, host: "other", kind: "daemon", startedAt: Date.now() }));
  const result = await runDueRound(decl, holder, async () => {}, { now: () => new Date("2024-01-15T10:31:00Z") });
  assert.equal(result, "busy");
});

test("runNow 无视 due，同样写 .lastrun + 释放锁", async () => {
  const { dir, decl } = setup();
  writeLastrun(dir, new Date("2024-01-15T10:00:00Z"));
  const result = await runNow(decl, holder, async () => {});
  assert.equal(result, "fired");
  assert.equal(readLastrunIso(dir) > "2024-01-15T10:00", true); // 真实 now 前进
});
