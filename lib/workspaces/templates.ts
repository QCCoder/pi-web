import type {
  BuiltinWorkspaceTemplateId,
  WorkspaceCapability,
  WorkspaceGitSettings,
  WorkspaceManifest,
  WorkspaceTemplateId,
  WorkspaceTemplateInfo,
} from "./types.ts";

export const SOFTWARE_DEVELOPMENT_SKILLS = [
  "grilling",
  "domain-modeling",
  "codebase-design",
  "tdd",
] as const;

export const BUILT_IN_WORKSPACE_TEMPLATES: readonly WorkspaceTemplateInfo[] = [
  {
    id: "empty",
    name: "Empty",
    description: "Only create the Workspace manifest and leave the directory structure open.",
    version: 1,
    capabilities: ["sessions", "explorer"],
    source: "built-in",
    skills: [],
    editable: false,
  },
  {
    id: "software-development",
    name: "Software Development",
    description: "Requirements, bugs, designs, plans, typed repositories, and collaboration rules.",
    version: 1,
    capabilities: ["sessions", "work-items", "repositories", "explorer", "overview"],
    source: "built-in",
    skills: [...SOFTWARE_DEVELOPMENT_SKILLS],
    editable: false,
  },
];

export const DEFAULT_GIT_SETTINGS: WorkspaceGitSettings = {
  branchRules: {
    requirement: "feature/{date}/{slug}",
    bug: "hotfix/{date}/{slug}",
  },
  createAfter: "plan_approved",
};

export const SOFTWARE_DEVELOPMENT_DIRECTORIES = [
  "requirements",
  "bugs",
  "designs",
  "plans",
  "repositories/code",
  "repositories/knowledge",
] as const;

/** Capabilities that are always on for every workspace. They are hard-coded (not
 *  toggleable) — `normalizeInitCapabilities` force-includes them regardless of the
 *  caller's selection. (Workspace redesign decision 7 / §6.3.) */
export const MANDATORY_CAPABILITIES = ["sessions", "explorer"] as const;

/** The capabilities offered as toggleable checkboxes when creating a workspace.
 *  Per redesign §6.2 this intentionally excludes `overview`, `feishu-transport`,
 *  `feishu-channel`, `subagent`, and `workflows` — those exist as legal capabilities
 *  (and stay toggleable via PATCH), but are not surfaced in the init checklist. */
export const INIT_CAPABILITY_CHECKLIST: readonly WorkspaceCapability[] = [
  "repositories",
  "knowledge",
  "loop",
  "work-items",
];

/** Normalize a caller-provided capability selection for a brand-new workspace:
 *  validate each entry, drop duplicates, and force-include the mandatory set
 *  (`sessions`, `explorer`). The result is the exact `capabilities` stored on the
 *  manifest — it never relies on template fallback. */
export function normalizeInitCapabilities(
  selected: readonly WorkspaceCapability[],
): WorkspaceCapability[] {
  const seen = new Set<WorkspaceCapability>();
  const result: WorkspaceCapability[] = [];
  const push = (capability: WorkspaceCapability) => {
    if (seen.has(capability)) return;
    seen.add(capability);
    result.push(capability);
  };
  for (const capability of MANDATORY_CAPABILITIES) push(capability);
  for (const capability of selected) push(capability);
  return result;
}

export function isBuiltinWorkspaceTemplateId(value: unknown): value is BuiltinWorkspaceTemplateId {
  return value === "empty" || value === "software-development";
}

export function getWorkspaceTemplate(id: BuiltinWorkspaceTemplateId): WorkspaceTemplateInfo {
  return BUILT_IN_WORKSPACE_TEMPLATES.find((template) => template.id === id)!;
}

export function defaultSkillsForTemplate(id: WorkspaceTemplateId): string[] {
  return id === "software-development" ? [...SOFTWARE_DEVELOPMENT_SKILLS] : [];
}

export function defaultGitForTemplate(id: WorkspaceTemplateId): WorkspaceGitSettings | undefined {
  return id === "software-development"
    ? structuredClone(DEFAULT_GIT_SETTINGS)
    : undefined;
}

export function renderWorkspaceRepositories(manifest: WorkspaceManifest): string {
  const active = manifest.repositories.filter((repository) => repository.status === "active");
  const lines = active.length === 0
    ? ["- No active repositories are configured."]
    : active.map((repository) =>
        `- \`${repository.alias}\` (${repository.kind}, id: \`${repository.id}\`): \`repositories/${repository.kind}/${repository.alias}\``
      );
  return `<!-- workspace-managed:repositories:start -->
## Workspace repositories

${lines.join("\n")}
<!-- workspace-managed:repositories:end -->`;
}

export function renderSoftwareDevelopmentAgents(manifest: WorkspaceManifest): string {
  const requirementBranch = manifest.git?.branchRules.requirement ?? DEFAULT_GIT_SETTINGS.branchRules.requirement;
  const bugBranch = manifest.git?.branchRules.bug ?? DEFAULT_GIT_SETTINGS.branchRules.bug;
  return `# ${manifest.name} Collaboration Policy

This Workspace uses Pi Agent for requirements, bug diagnosis, design, implementation, and verification. Keep authoritative artifacts in the Workspace files and link meaningful outcomes to their Work Item.

## Collaboration flow

1. Clarify the Requirement or Bug and preserve the user's Original Description.
2. Produce analysis and acceptance criteria, then wait for user approval.
3. Produce the design and implementation plan, then wait for user approval.
4. Implement, test, review, and record meaningful milestones.
5. Do not claim completion until verification evidence is available.

<!-- workspace-managed:git:start -->
## Git collaboration

- Requirement branches use \`${requirementBranch}\`.
- Bug branches use \`${bugBranch}\`.
- Create implementation branches only after the plan is approved.
- Never delete or force-push a remote branch without explicit user approval.
<!-- workspace-managed:git:end -->

${renderWorkspaceRepositories(manifest)}

## Work Item records

- Use the Pi Workspace Work Item tools for structured metadata and milestones.
- Do not rewrite \`events.jsonl\`; it is append-only.
- Do not overwrite the Original Description with later analysis.
- Keep low-level tool calls in the Conversation and record only meaningful milestones on the Work Item.
`;
}

/** Capability-driven AGENTS.md generator (redesign decision 9). Unlike
 *  `renderSoftwareDevelopmentAgents` it depends only on the manifest's
 *  capabilities/git settings, not on a template id, so new (template-free)
 *  workspaces get a tailored collaboration policy. The repositories block uses the
 *  same `<!-- workspace-managed:repositories:start/end -->` markers as the legacy
 *  generator, so `updateManagedRepositoryInstructions` keeps working unchanged. */
export function renderWorkspaceAgents(
  manifest: WorkspaceManifest,
  capabilities: readonly WorkspaceCapability[],
): string {
  const hasWorkItems = capabilities.includes("work-items");
  const lines: string[] = [];
  lines.push(`# ${manifest.name} Collaboration Policy`);
  lines.push("");
  lines.push("This Workspace uses Pi Agent. Keep authoritative artifacts in Workspace files and link meaningful outcomes to their Work Item.");
  lines.push("");
  if (hasWorkItems) {
    lines.push("## Collaboration flow");
    lines.push("");
    lines.push("1. Clarify the Requirement or Bug and preserve the user's Original Description.");
    lines.push("2. Produce analysis and acceptance criteria, then wait for user approval.");
    lines.push("3. Produce the design and implementation plan, then wait for user approval.");
    lines.push("4. Implement, test, review, and record meaningful milestones.");
    lines.push("5. Do not claim completion until verification evidence is available.");
    lines.push("");
  }
  if (manifest.git) {
    const requirementBranch = manifest.git.branchRules.requirement;
    const bugBranch = manifest.git.branchRules.bug;
    lines.push("<!-- workspace-managed:git:start -->");
    lines.push("## Git collaboration");
    lines.push("");
    lines.push(`- Requirement branches use \`${requirementBranch}\`.`);
    lines.push(`- Bug branches use \`${bugBranch}\`.`);
    lines.push("- Create implementation branches only after the plan is approved.");
    lines.push("- Never delete or force-push a remote branch without explicit user approval.");
    lines.push("<!-- workspace-managed:git:end -->");
    lines.push("");
  }
  lines.push(renderWorkspaceRepositories(manifest));
  if (hasWorkItems) {
    lines.push("");
    lines.push("## Work Item records");
    lines.push("");
    lines.push("- Use the Pi Workspace Work Item tools for structured metadata and milestones.");
    lines.push("- Do not rewrite `events.jsonl`; it is append-only.");
    lines.push("- Do not overwrite the Original Description with later analysis.");
    lines.push("- Keep low-level tool calls in the Conversation and record only meaningful milestones on the Work Item.");
  }
  return `${lines.join("\n")}\n`;
}

export const SOFTWARE_DEVELOPMENT_GITIGNORE = `# Pi Workspace rebuildable state
/.pi/cache/
/.pi/*.sqlite

# Nested repositories are managed independently
/repositories/
`;
