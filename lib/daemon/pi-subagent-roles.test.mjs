import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// The community package's role discovery (A3 criterion ①). The dist entry is
// plain ESM, so a native import works from node:test.
import { loadRoles } from "@henryqw/pi-subagent";

function roleFile(name, body = `You are ${name}.`) {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} role for tests`,
    "tools: [read, ls]",
    "extensions: []",
    "skills: []",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

test("loadRoles discovers a role from a custom agentDir and project dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-roles-"));
  try {
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
    await mkdir(join(projectDir, ".pi", "agents", "pi-subagent"), { recursive: true });
    await writeFile(join(agentDir, "config", "pi-subagent", "custom-role.md"), roleFile("custom-role"));
    await writeFile(join(projectDir, ".pi", "agents", "pi-subagent", "project-role.md"), roleFile("project-role"));

    const roles = loadRoles(agentDir, { projectDir, trusted: true });
    const names = roles.map((r) => r.name);

    // Built-ins + project + user roles all present.
    assert.ok(names.includes("implementer"), "built-in implementer role loads");
    assert.ok(names.includes("reviewer"), "built-in reviewer role loads");
    assert.ok(names.includes("project-role"), "project-local role from <project>/.pi/agents/pi-subagent loads");
    assert.ok(names.includes("custom-role"), "user role from <agentDir>/config/pi-subagent loads");

    // The custom role parses into the package's Role shape.
    const custom = roles.find((r) => r.name === "custom-role");
    assert.equal(custom.tools.join(","), "read,ls");
    assert.equal(custom.systemPrompt.trim(), "You are custom-role.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("precedence is built-in < project < user (same name wins upward)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-prec-"));
  try {
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
    await mkdir(join(projectDir, ".pi", "agents", "pi-subagent"), { recursive: true });
    // Same name at every level: built-in implementer, project override, user override.
    await writeFile(join(projectDir, ".pi", "agents", "pi-subagent", "implementer.md"), roleFile("implementer", "PROJECT implementer body"));
    await writeFile(join(agentDir, "config", "pi-subagent", "implementer.md"), roleFile("implementer", "USER implementer body"));

    const withProject = loadRoles(agentDir, { projectDir, trusted: true });
    assert.equal(
      withProject.find((r) => r.name === "implementer").systemPrompt.trim(),
      "USER implementer body",
      "user role overrides project role",
    );

    // Without the user override, the project role must beat the built-in.
    await rm(join(agentDir, "config", "pi-subagent", "implementer.md"), { force: true });
    const projectOnly = loadRoles(agentDir, { projectDir, trusted: true });
    assert.equal(
      projectOnly.find((r) => r.name === "implementer").systemPrompt.trim(),
      "PROJECT implementer body",
      "project role overrides built-in",
    );

    // Untrusted projects contribute no roles (trust gate): the built-in
    // implementer body remains instead of the project override.
    const untrusted = loadRoles(agentDir, { projectDir, trusted: false });
    assert.notEqual(
      untrusted.find((r) => r.name === "implementer").systemPrompt.trim(),
      "PROJECT implementer body",
      "untrusted project role is not loaded (built-in body remains)",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("role files missing mandatory frontmatter arrays are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-bad-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
    // Legacy pi-web agent format (no tools/extensions/skills arrays) must fail
    // loudly — this is why workspace roles need the migration documented in
    // AGENTS.md (lib/subagent → @henryqw/pi-subagent switch).
    await writeFile(
      join(agentDir, "config", "pi-subagent", "legacy.md"),
      ["---", "name: legacy", "description: old pi-web agent", "---", "", "body", ""].join("\n"),
    );
    assert.throws(() => loadRoles(agentDir), /legacy\.md: tools is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
