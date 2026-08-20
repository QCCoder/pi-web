import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { createLoopDefinition } = await createJiti(import.meta.url).import("./authoring.ts");

const validInput = {
  id: "daily-review",
  name: "每日检查",
  description: "检查状态",
  manualTrigger: true,
  cronEnabled: true,
  cronExpression: "0 9 * * 1-5",
  timezone: "Asia/Shanghai",
  goal: "检查项目状态。",
  executionRules: "收集状态并生成报告。",
  verificationRules: "核对证据和结论。",
  gateRules: "外发前需要确认。",
  improveRules: "记录误报并提出建议。",
};

test("creates the complete portable Loop directory and rejects duplicates", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-loop-authoring-"));
  const workspace = { id: "ws", name: "Workspace", path };
  const definition = await createLoopDefinition(workspace, validInput);
  assert.equal(definition.id, "daily-review");
  assert.equal(definition.triggers.length, 2);
  const directory = join(path, "loops", "daily-review");
  assert.match(await readFile(join(directory, "loop.yaml"), "utf8"), /expression: 0 9 \* \* 1-5/);
  assert.match(await readFile(join(directory, "LOOP.md"), "utf8"), /Maker：收集状态并生成报告/);
  // No STATE.md is created.
  await assert.rejects(() => readFile(join(directory, "STATE.md"), "utf8"));
  assert.equal((await stat(join(directory, "agents"))).isDirectory(), true);
  assert.equal((await stat(join(directory, "audit"))).isDirectory(), true);
  await assert.rejects(() => createLoopDefinition(workspace, validInput), /already exists/);
});

test("requires at least one trigger and validates timezone", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-loop-authoring-invalid-"));
  const workspace = { id: "ws", name: "Workspace", path };
  await assert.rejects(
    () => createLoopDefinition(workspace, { ...validInput, id: "no-trigger", manualTrigger: false, cronEnabled: false }),
    /at least one trigger/,
  );
  await assert.rejects(
    () => createLoopDefinition(workspace, { ...validInput, id: "bad-timezone", timezone: "Mars/Olympus" }),
    /invalid timezone/,
  );
});
