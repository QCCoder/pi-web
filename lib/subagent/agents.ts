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
 * Security model (aligned with the official pi subagent example):
 *   - Default scope is "user": only `~/.pi/agent/agents/*.md` loads automatically.
 *   - Project-local agents (`<projectRoot>/.pi/agents/*.md`) are repo-controlled
 *     prompts that can instruct the model to read files / run bash, so they only
 *     load when the caller passes scope "project" or "both", and the tool is
 *     expected to confirm with the user first (see extension.ts).
 *
 * Discovery root: a single `<projectRoot>/.pi/agents` lookup — we do NOT walk up
 * the directory tree like the CLI example, because Pi Web's trust unit is the
 * workspace/project, not an arbitrary cwd. `projectRoot` is pre-resolved by the
 * caller (worktree → main repo) so all worktrees of one repo share agents.
 *
 * If none are defined, a built-in default "general" agent is provided so the
 * subagent tool is usable out of the box.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Which agent directories to load from. */
export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  /** Optional tool allow-list. Undefined = all available tools. */
  tools?: string[];
  /** Optional model id; falls back to the runtime default when unset. */
  model?: string;
  systemPrompt: string;
  source: "user" | "project" | "loop";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  /** Absolute path to the project agents dir, when one exists. */
  projectAgentsDir: string | null;
}

function loadDir(dir: string, source: "user" | "project" | "loop"): AgentConfig[] {
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
 * Discover subagent definitions.
 *
 * @param projectRoot Resolved project root (worktree → main repo). Project agents
 *   are read from `<projectRoot>/.pi/agents`.
 * @param scope Which sources to load. Default-relevant: "user" loads only
 *   `~/.pi/agent/agents`; "project"/"both" additionally load project-local agents
 *   (repo-controlled — confirm before use).
 */
export function discoverAgents(
  projectRoot: string,
  scope: AgentScope,
  /** Extra trusted agent directories (e.g. a Loop's own `agents/`), injected by
   *  the caller. Loaded as a "loop" source with the highest precedence, and not
   *  subject to the project-agent confirmation gate. */
  extraAgentDirs?: string[],
): AgentDiscoveryResult {
  const userDir = join(getAgentDir(), "agents");
  const projectAgentsDir = join(projectRoot, CONFIG_DIR_NAME, "agents");

  const userAgents = scope === "project" ? [] : loadDir(userDir, "user");
  const projectAgents = scope === "user" || !existsSync(projectAgentsDir) ? [] : loadDir(projectAgentsDir, "project");
  const loopAgents = (extraAgentDirs ?? []).flatMap((dir) => loadDir(dir, "loop"));

  const byName = new Map<string, AgentConfig>();
  // Precedence (low → high): user, project, loop (injected). The loop's own
  // agents win on name collisions because they are the most specific.
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);
  for (const agent of loopAgents) byName.set(agent.name, agent);

  if (byName.size === 0) byName.set(BUILTIN_GENERAL.name, BUILTIN_GENERAL);

  return {
    agents: [...byName.values()],
    projectAgentsDir: existsSync(projectAgentsDir) ? projectAgentsDir : null,
  };
}

/** Format the available-agent list for "unknown agent" error messages. */
export function formatAgentList(agents: AgentConfig[], maxItems = 12): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed.map((a) => `- "${a.name}" (${a.source}): ${a.description}`).join("\n"),
    remaining,
  };
}
