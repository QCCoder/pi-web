import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastrun, writeLastrun, shouldFire } from "./due.ts";

const DECL = (dir) => ({ workspacePath: "/ws", loopName: "l", dir, pattern: "l",
  cron: "*/30 * * * *", timezone: "UTC", level: "L1", maxMinutes: 30, body: "" });

test("无 .lastrun → 立即该跑（nextDue 从 epoch 推导早已过）", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:07:00Z")), true);
});

test(".lastrun 在本槽内 → 不该跑；过了下一槽 → 该跑", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  writeLastrun(d, new Date("2024-01-15T10:00:00Z"));
  assert.equal(readFileSync(join(d, ".lastrun"), "utf8").trim(), "2024-01-15T10:00:00.000Z");
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:15:00Z")), false); // :00 槽已跑，:30 未到
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:30:00Z")), true);
});

test("错过三个槽的 .lastrun → 该跑（anacron-lite：补一轮而非三轮，由 fire 层保证只跑一次）", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  writeLastrun(d, new Date("2024-01-15T09:00:00Z"));
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:45:00Z")), true);
});

test("readLastrun 缺省 undefined", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  assert.equal(readLastrun(d), undefined);
});
