import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { discoverAgents } = await jiti.import("./agents.ts");

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

async function makeAgentFile(dir, name, fields) {
  await mkdir(dir, { recursive: true });
  const frontmatter = Object.entries({
    name,
    description: fields.description ?? `${name} agent`,
    ...(fields.tools ? { tools: fields.tools } : {}),
    ...(fields.model ? { model: fields.model } : {}),
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${fields.body ?? ""}\n`, "utf8");
}

test("returns the built-in general agent when no agents are defined", async () => {
  await mkdtemp(join(tmpdir(), "pi-sub-empty-"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-sub-ws-"));
  const agentHome = await mkdtemp(join(tmpdir(), "pi-sub-home-"));
  await withEnv({ [ENV_AGENT_DIR]: agentHome }, async () => {
    const agents = discoverAgents(workspace);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "general");
    assert.equal(agents[0].source, "project");
    assert.ok(agents[0].systemPrompt.length > 0);
  });
  await rm(workspace, { recursive: true, force: true });
  await rm(agentHome, { recursive: true, force: true });
});

test("discovers project agents and parses frontmatter + body", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-sub-ws-"));
  const agentHome = await mkdtemp(join(tmpdir(), "pi-sub-home-"));
  await makeAgentFile(join(workspace, ".pi", "agents"), "researcher", {
    description: "Deep research specialist",
    tools: "read, grep, find",
    body: "You are a researcher. Be thorough.",
  });

  await withEnv({ [ENV_AGENT_DIR]: agentHome }, async () => {
    const agents = discoverAgents(workspace);
    const researcher = agents.find((a) => a.name === "researcher");
    assert.ok(researcher, "researcher agent should be discovered");
    assert.equal(researcher.source, "project");
    assert.equal(researcher.description, "Deep research specialist");
    assert.deepEqual(researcher.tools, ["read", "grep", "find"]);
    assert.equal(researcher.systemPrompt, "You are a researcher. Be thorough.");
    assert.equal(researcher.model, undefined);
  });

  await rm(workspace, { recursive: true, force: true });
  await rm(agentHome, { recursive: true, force: true });
});

test("project agents override user agents with the same name", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-sub-ws-"));
  const agentHome = await mkdtemp(join(tmpdir(), "pi-sub-home-"));
  await makeAgentFile(join(agentHome, "agents"), "shared", {
    description: "user-level shared",
    body: "from user",
  });
  await makeAgentFile(join(workspace, ".pi", "agents"), "shared", {
    description: "project-level shared",
    body: "from project",
  });

  await withEnv({ [ENV_AGENT_DIR]: agentHome }, async () => {
    const agents = discoverAgents(workspace);
    const shared = agents.find((a) => a.name === "shared");
    assert.ok(shared);
    assert.equal(shared.source, "project");
    assert.equal(shared.description, "project-level shared");
    assert.equal(shared.systemPrompt, "from project");
    assert.equal(agents.filter((a) => a.name === "shared").length, 1, "no duplicate");
  });

  await rm(workspace, { recursive: true, force: true });
  await rm(agentHome, { recursive: true, force: true });
});
