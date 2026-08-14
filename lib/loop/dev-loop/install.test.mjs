import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createDevLoopDefinition, ensureDevLoopDefinition, DEV_LOOP_ID } = await jiti.import("./install.ts");
const { readLoopDefinition } = await jiti.import("../store.ts");

function ws(path) {
  return { id: "ws", name: "Demo", path };
}

test("DEV_LOOP_ID is the canonical dev-loop id", () => {
  assert.equal(DEV_LOOP_ID, "dev-loop");
});

test("createDevLoopDefinition ships a generic, autonomy-free definition the engine can read", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-devloop-"));
  const definition = await createDevLoopDefinition(ws(path));
  assert.equal(definition.id, "dev-loop");
  // The new engine is autonomy-free: the parsed definition carries no autonomy.
  assert.equal(definition.autonomy, undefined);
  assert.equal(definition.triggers.length, 2);

  const directory = join(path, "loops", "dev-loop");

  // loop.yaml: no autonomy key, weekday work-hours every 30min cron.
  const yaml = await readFile(join(directory, "loop.yaml"), "utf8");
  assert.match(yaml, /expression: "\*\/30 9-22 \* \* 1-5"/);
  assert.doesNotMatch(yaml, /autonomy/);

  // LOOP.md: thin dispatcher (judgment moved into subagents), project-fact-free.
  const loop = await readFile(join(directory, "LOOP.md"), "utf8");
  assert.match(loop, /loop\.started/);
  assert.match(loop, /conversations/);
  assert.match(loop, /runId/);
  // Judgment (三重判定 / kb_search) lives in the selector subagent, NOT in LOOP.md.
  // (kb_search for orient is selector's job; the orchestrator only schedules.)
  assert.doesNotMatch(loop, /三重判定/);
  assert.doesNotMatch(loop, /kb_search/);
  // L0 invariants present and project-fact-free.
  assert.match(loop, /永不自动合并主干/);
  // Flat path guidance (workspaceRepositoryPath rule) — no nested layouts.
  assert.match(loop, /repositories\/<alias>/);
  assert.doesNotMatch(loop, /BUG-0008/);
  assert.doesNotMatch(loop, /repositories\/code\//);
  assert.doesNotMatch(loop, /repositories\/knowledge\//);
  // No hardcoded cxin facts leaked into the shipped template.
  assert.doesNotMatch(loop, /cargoware/);
  assert.doesNotMatch(loop, /cargo-knowledge/);
  // Scope discipline invariants.
  assert.match(loop, /单工作项·单分支/);
  assert.match(loop, /禁止创建任何新工作项/);
  assert.match(loop, /全范围做完才验收/);
  assert.match(loop, /禁止在部分范围上 gate/);
  assert.match(loop, /纯技术工作/); // 超限判定：纯技术一律做完
  // Gate rules.
  assert.match(loop, /一次性问全/);
  assert.match(loop, /gate 消息 terse/);
  // New: ceremony tier is selector's output; anti-rationalization table present.
  assert.match(loop, /ceremony/);
  assert.match(loop, /反自欺/);

  // Agents shipped: selector + architect (judgment/trace+plan) + developer + tester.
  const selector = await readFile(join(directory, "agents", "selector.md"), "utf8");
  assert.match(selector, /name: selector/);
  assert.match(selector, /三重判定/);   // judgment lives here
  assert.match(selector, /kb_search/);
  assert.match(selector, /数据流快筛/);  // ceremony decision
  assert.match(selector, /ceremony/);
  // batch all clarifications; never self-create work items.
  assert.match(selector, /一次性列全/);
  assert.match(selector, /永不创建新工作项/);

  const architect = await readFile(join(directory, "agents", "architect.md"), "utf8");
  assert.match(architect, /name: architect/);
  // Full-chain trace + counter-evidence before any scope conclusion.
  assert.match(architect, /全链路追踪/);
  assert.match(architect, /反证/);
  assert.match(architect, /全链路清单/);
  // Architect owns the detailed dev + test plan (merged PLAN+DESIGN).
  assert.match(architect, /dev 计划/);
  assert.match(architect, /测试计划/);
  // Wiring coverage is architect's responsibility now (tester is pure executor).
  assert.match(architect, /接线覆盖/);

  const developer = await readFile(join(directory, "agents", "developer.md"), "utf8");
  assert.match(developer, /name: developer/);
  assert.match(developer, /永不提交到主干/);
  assert.match(developer, /非自己产生的改动/);   // worktree isolation: dirty → report
  assert.match(developer, /复现.*失败测试/);      // rework reproduce-first
  assert.match(developer, /受影响的测试/);        // incremental build
  // Bounded fix loop (max 5 rounds, escalate model at R4-5).
  assert.match(developer, /有界修复循环/);
  assert.match(developer, /5 轮/);
  assert.doesNotMatch(developer, /gate7/);  // no stale gate7 reference

  const tester = await readFile(join(directory, "agents", "tester.md"), "utf8");
  assert.match(tester, /name: tester/);
  assert.match(tester, /verdict: green/);
  // Tester is a pure executor: runs architect's plan, does NOT self-create coverage.
  assert.match(tester, /纯执行/);
  assert.match(tester, /不自创覆盖/);

  // LEARN.md: the inline learn-step spec (generalizability test + KB notes).
  const learnSpec = await readFile(join(directory, "LEARN.md"), "utf8");
  assert.match(learnSpec, /泛化测试/);
  assert.match(learnSpec, /learnings/);
  assert.match(learnSpec, /author: loop/);
  assert.match(learnSpec, /autoManaged: true/);
  assert.match(learnSpec, /永不编辑已有笔记/);  // anti-pollution

  // No STATE.md (the calibration machinery was removed; learn lives in KB).
  await assert.rejects(() => readFile(join(directory, "STATE.md"), "utf8"));

  // LEARN.jsonl seeded empty; audit/ present.
  assert.equal(await readFile(join(directory, "LEARN.jsonl"), "utf8"), "");
  assert.equal((await stat(join(directory, "audit"))).isDirectory(), true);

  // The generic engine reads it back.
  const read = await readLoopDefinition(ws(path), "dev-loop");
  assert.equal(read.id, "dev-loop");
  assert.equal(read.autonomy, undefined);
});

test("createDevLoopDefinition rejects duplicates", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-devloop-dup-"));
  await createDevLoopDefinition(ws(path));
  await assert.rejects(() => createDevLoopDefinition(ws(path)), /already exists/);
});

test("ensureDevLoopDefinition is idempotent (create then return existing)", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-devloop-ensure-"));
  const first = await ensureDevLoopDefinition(ws(path));
  assert.equal(first.created, true);
  assert.equal(first.definition.id, "dev-loop");
  const second = await ensureDevLoopDefinition(ws(path));
  assert.equal(second.created, false);
  assert.equal(second.definition.id, "dev-loop");
});
