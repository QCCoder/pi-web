import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLoopDeclaration, discoverKitLoops, isWorkspaceHalted, localTimezone } from "./protocol.ts";

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

test("frontmatter name wins over directory name; pattern defaults to loopName (README contract)", () => {
  const decl = parseLoopDeclaration("---\ncron: \"* * * * *\"\nname: custom\n---\nbody", "/ws/loops/x", "/ws");
  assert.equal(decl.loopName, "custom");
  assert.equal(decl.pattern, "custom");
  assert.equal(decl.dir, "/ws/loops/x"); // dir 仍是物理位置，不受 name 影响
  // 空/非字符串 name → 缺省取目录名
  const empty = parseLoopDeclaration("---\ncron: \"* * * * *\"\nname: \"\"\n---\nbody", "/ws/loops/x", "/ws");
  assert.equal(empty.loopName, "x");
  assert.equal(empty.pattern, "x");
  // name + 显式 pattern 并存 → pattern 显式值胜
  const both = parseLoopDeclaration("---\ncron: \"* * * * *\"\nname: custom\npattern: other\n---\nbody", "/ws/loops/x", "/ws");
  assert.equal(both.loopName, "custom");
  assert.equal(both.pattern, "other");
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
    // 无 name 的 LOOP.md：loopName 缺省取目录名（F5 契约），正好覆盖回退路径
    const NAMELESS = LOOP_MD.replace(/\nname: smoke\n/, "\n");
    mkdirSync(join(ws, "loops", "a"), { recursive: true });
    writeFileSync(join(ws, "loops", "a", "LOOP.md"), NAMELESS);
    mkdirSync(join(ws, "loops", "paused"), { recursive: true });
    writeFileSync(join(ws, "loops", "paused", "LOOP.md"), NAMELESS);
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

test("discoverKitLoops includePaused 返回暂停 loop 并标记 paused", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-"));
  mkdirSync(join(root, "loops", "a"), { recursive: true });
  writeFileSync(join(root, "loops", "a", "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nbody");
  mkdirSync(join(root, "loops", "b"), { recursive: true });
  writeFileSync(join(root, "loops", "b", "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nbody");
  writeFileSync(join(root, "loops", "b", "PAUSED"), "");
  assert.equal(discoverKitLoops(root).length, 1);            // 默认：暂停即不存在（D11 门控语义）
  const all = discoverKitLoops(root, { includePaused: true });
  assert.equal(all.length, 2);
  assert.equal(all.find((d) => d.loopName === "b")?.paused, true);
  assert.equal(all.find((d) => d.loopName === "a")?.paused ?? false, false);
});
