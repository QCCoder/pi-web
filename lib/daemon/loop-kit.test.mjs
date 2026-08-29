import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLoopDeclaration, discoverKitLoops, isWorkspaceHalted, localTimezone } from "./loop-kit.ts";

const LOOP_MD = `---
name: smoke
cron: "0 8 * * 1-5"
level: L2
max_minutes: 45
---

# 本轮合同指针
1. 读宪法文件
`;

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "kit-ws-"));
}

test("parseLoopDeclaration full frontmatter", () => {
  const dir = "/ws/loops/smoke";
  const decl = parseLoopDeclaration(LOOP_MD, dir, "/ws");
  assert.equal(decl.loopName, "smoke");
  assert.equal(decl.pattern, "smoke"); // pattern 缺省取 name
  assert.equal(decl.cron, "0 8 * * 1-5");
  assert.equal(decl.level, "L2");
  assert.equal(decl.maxMinutes, 45);
  assert.equal(decl.workspacePath, "/ws");
  assert.equal(decl.dir, dir);
  assert.ok(decl.body.includes("本轮合同指针"));
});

test("defaults: level L1, max_minutes 30, timezone = local, explicit pattern wins", () => {
  const decl = parseLoopDeclaration("---\ncron: \"* * * * *\"\npattern: dev-loop\n---\nbody", "/ws/loops/x", "/ws");
  assert.equal(decl.level, "L1");
  assert.equal(decl.maxMinutes, 30);
  assert.equal(decl.pattern, "dev-loop");
  assert.equal(decl.timezone, localTimezone());
});

test("missing cron or bad yaml -> undefined", () => {
  assert.equal(parseLoopDeclaration("---\nname: x\n---\n", "/ws/loops/x", "/ws"), undefined);
  assert.equal(parseLoopDeclaration("no frontmatter at all", "/ws/loops/x", "/ws"), undefined);
  assert.equal(parseLoopDeclaration("---\n: :\n---\n", "/ws/loops/x", "/ws"), undefined);
});

test("invalid level falls back to L1", () => {
  const decl = parseLoopDeclaration("---\ncron: \"* * * * *\"\nlevel: L9\n---\n", "/ws/loops/x", "/ws");
  assert.equal(decl.level, "L1");
});

test("discoverKitLoops: finds, skips PAUSED, skips broken", () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws, "loops", "a"), { recursive: true });
    writeFileSync(join(ws, "loops", "a", "LOOP.md"), LOOP_MD);
    mkdirSync(join(ws, "loops", "paused"), { recursive: true });
    writeFileSync(join(ws, "loops", "paused", "LOOP.md"), LOOP_MD);
    writeFileSync(join(ws, "loops", "paused", "PAUSED"), "");
    mkdirSync(join(ws, "loops", "broken"), { recursive: true });
    writeFileSync(join(ws, "loops", "broken", "LOOP.md"), "garbage");
    const found = discoverKitLoops(ws);
    assert.deepEqual(found.map((d) => d.loopName), ["a"]);
    // NOTE (task-3 deviation): brief said assert.equal(..., []) — under
    // node:assert/strict that is strictStrictEqual and two array instances are
    // never Object.is-equal, so the line could never pass. deepEqual preserves
    // the intent (empty array for a missing loops/ dir).
    assert.deepEqual(discoverKitLoops(join(ws, "no-such")), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("isWorkspaceHalted", () => {
  const ws = makeWorkspace();
  try {
    assert.equal(isWorkspaceHalted(ws), false);
    writeFileSync(join(ws, "loop-pause-all"), "");
    assert.equal(isWorkspaceHalted(ws), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
