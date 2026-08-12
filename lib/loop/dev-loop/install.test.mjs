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
  // Judgment (三重判定 / kb_search) lives in the planner subagent, NOT in LOOP.md.
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
  // P1 §1 scope discipline invariants.
  assert.match(loop, /单工作项·单分支/);
  assert.match(loop, /禁止创建任何新工作项/);
  assert.match(loop, /全范围做完才验收/);
  assert.match(loop, /禁止在部分范围上 gate/);
  assert.match(loop, /纯技术工作/); // 超限判定：纯技术一律做完
  // P1 §4 gate rules.
  assert.match(loop, /一次性问全/);
  assert.match(loop, /gate 消息 terse/);

  // Agents shipped: planner + designer (judgment/design) + developer + tester.
  const planner = await readFile(join(directory, "agents", "planner.md"), "utf8");
  assert.match(planner, /name: planner/);
  assert.match(planner, /三重判定/);   // judgment lives here now
  assert.match(planner, /kb_search/);
  // P1: batch all clarifications; never self-create work items.
  assert.match(planner, /一次性列全/);
  assert.match(planner, /永不创建新工作项/);
  const designer = await readFile(join(directory, "agents", "designer.md"), "utf8");
  assert.match(designer, /name: designer/);
  const developer = await readFile(join(directory, "agents", "developer.md"), "utf8");
  assert.match(developer, /name: developer/);
  assert.match(developer, /永不提交到主干/);
  const tester = await readFile(join(directory, "agents", "tester.md"), "utf8");
  assert.match(tester, /name: tester/);
  assert.match(tester, /verdict: green/);

  // STATE.md with managed derived markers.
  const state = await readFile(join(directory, "STATE.md"), "utf8");
  assert.match(state, /<!-- dev-loop:derived:start -->/);
  assert.match(state, /<!-- dev-loop:derived:end -->/);

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
