import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStatus } from "./status.ts";

test("paused 可见并标记；running 由活锁判定；nextDue 由 .lastrun 推导", () => {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  const a = join(root, "loops", "a"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\n---\nb");
  writeFileSync(join(a, ".lastrun"), "2024-01-15T10:00:00.000Z");
  const b = join(root, "loops", "b"); mkdirSync(b, { recursive: true });
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
