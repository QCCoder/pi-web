/**
 * Subagent definition discovery.
 *
 * Subagents are Markdown files with YAML frontmatter:
 *
 * ---
 * name: scout
 * description: Fast codebase recon
 * tools: read, grep, find, ls, bash   # optional, comma-separated
 * model: claude-haiku-4-5              # optional, falls back to default model
 * ---
 * System prompt body...
 *
 * Loaded from (project overrides user by name):
 *   - <workspace>/.pi/agents/*.md   (workspace-scoped, "project")
 *   - ~/.pi/agent/agents/*.md        (user-global, "user")
 *
 * If none are defined, a built-in default "general" agent is provided so the
 * subagent tool is usable out of the box.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
  name: string;
  description: string;
  /** Optional tool allow-list. Undefined = all available tools. */
  tools?: string[];
  /** Optional model id; falls back to the runtime default when unset. */
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

function loadDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = statSync(join(dir, entry.name)).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model || undefined,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }
  return agents;
}

const BUILTIN_GENERAL: AgentConfig = {
  name: "general",
  description: "General-purpose subagent with full tool access and an isolated context window.",
  systemPrompt:
    "You are an isolated worker subagent. Complete the delegated task autonomously using the available tools, then report concise, self-contained results. You have not seen the parent conversation, so do not refer to it.",
  source: "project",
  filePath: "<builtin>",
};

/**
 * Discover subagent definitions for a workspace. Project agents override
 * user agents with the same name. Returns a built-in default when none exist.
 */
export function discoverAgents(workspacePath: string): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  for (const agent of loadDir(join(getAgentDir(), "agents"), "user")) byName.set(agent.name, agent);
  for (const agent of loadDir(join(workspacePath, CONFIG_DIR_NAME, "agents"), "project")) {
    byName.set(agent.name, agent);
  }
  if (byName.size === 0) byName.set(BUILTIN_GENERAL.name, BUILTIN_GENERAL);
  return [...byName.values()];
}
