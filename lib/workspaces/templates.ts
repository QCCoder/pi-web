import type {
  WorkspaceGitSettings,
  WorkspaceManifest,
  WorkspaceTemplateId,
  WorkspaceTemplateInfo,
} from "./types.ts";

export const BUILT_IN_WORKSPACE_TEMPLATES: readonly WorkspaceTemplateInfo[] = [
  {
    id: "empty",
    name: "Empty",
    description: "Only create the Workspace manifest and leave the directory structure open.",
    version: 1,
    capabilities: ["sessions", "explorer"],
  },
  {
    id: "software-development",
    name: "Software Development",
    description: "Requirements, bugs, designs, plans, typed repositories, and collaboration rules.",
    version: 1,
    capabilities: ["sessions", "work-items", "repositories", "explorer", "overview"],
  },
];

export const SOFTWARE_DEVELOPMENT_SKILLS = [
  "grilling",
  "domain-modeling",
  "codebase-design",
  "tdd",
] as const;

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

export function isWorkspaceTemplateId(value: unknown): value is WorkspaceTemplateId {
  return value === "empty" || value === "software-development";
}

export function getWorkspaceTemplate(id: WorkspaceTemplateId): WorkspaceTemplateInfo {
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

export const SOFTWARE_DEVELOPMENT_GITIGNORE = `# Pi Workspace rebuildable state
/.pi/cache/
/.pi/*.sqlite

# Nested repositories are managed independently
/repositories/
`;
