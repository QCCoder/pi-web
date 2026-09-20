import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.match(startupSource, /buildWorkspaceExtensions\(/);
  assert.match(startupSource, /extensionFactories:/);
  assert.match(startupSource, /skillsOverride:/);
  assert.match(startupSource, /selectedWorkspaceSkills\.has\(skill\.name\)/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("agent run completion drives the Web Push notifier, skipping subagent children", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(source.indexOf("export async function startRpcSession"));

  // Completion push wiring (upstream #496): the wrapper's completion listener
  // must feed notifySessionComplete and never throw into the session flow.
  assert.match(startSource, /notifySessionComplete\(completedSessionId\)\.catch\(/);
  assert.match(startSource, /isSubagentChildSession\(/);

  const lifecycleSource = source.slice(
    source.indexOf("  start(): void {"),
    source.indexOf("  setForceEmptySystemPrompt("),
  );
  // Gate the push to runs that actually started, and consume it on settle.
  assert.match(lifecycleSource, /event\.type === "agent_start"\) this\.agentRunNeedsCompletion = true/);
  assert.match(lifecycleSource, /event\.type === "agent_settled"\) this\.notifyAgentRunCompleteIfIdle\(\)/);
  // The prompt promise settles after agent_settled arrives — the idle check
  // must run again there or the push is swallowed by a stale isRunning().
  assert.match(source, /this\.promptRunning = false;[\s\S]*?this\.notifyAgentRunCompleteIfIdle\(\);/);
});
