import type {
  WorkspaceCapability,
  WorkspaceGitSettings,
  WorkspaceManifest,
  WorkspaceRepository,
} from "./types.ts";

export const DEFAULT_GIT_SETTINGS: WorkspaceGitSettings = {
  branchRules: {
    requirement: "feature/{date}/{slug}",
    bug: "hotfix/{date}/{slug}",
  },
  createAfter: "plan_approved",
};

/** Capabilities that are always on for every workspace. They are hard-coded (not
 *  toggleable) — `normalizeInitCapabilities` force-includes them regardless of the
 *  caller's selection. (Workspace redesign decision 7 / §6.3.) */
export const MANDATORY_CAPABILITIES = ["sessions", "explorer"] as const;

/** The capabilities offered as toggleable checkboxes when creating a workspace.
 *  Per redesign §6.2 this intentionally excludes `subagent` and `workflows` —
 *  those exist as legal capabilities (and stay toggleable via PATCH), but are
 *  not surfaced in the init checklist. (The former `overview` capability is
 *  retired entirely — the overview dashboard is the unconditional landing view.) */
export const INIT_CAPABILITY_CHECKLIST: readonly WorkspaceCapability[] = [
  "repositories",
  "knowledge",
  "loop",
  "work-items",
];

/** Normalize a caller-provided capability selection for a brand-new workspace:
 *  validate each entry, drop duplicates, and force-include the mandatory set
 *  (`sessions`, `explorer`). The result is the exact `capabilities` stored on the
 *  manifest. */
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

export function renderWorkspaceRepositories(
  manifest: WorkspaceManifest,
  resolveRelativePath?: (repository: WorkspaceRepository) => string,
): string {
  // The repositories section lists CODE repos only (knowledge bundles have their
  // own `renderKnowledgeSection` segment). Path defaults to the flat
  // `repositories/<alias>` layout; `resolveRelativePath` lets callers (e.g.
  // `updateManagedRepositoryInstructions`) pass the actual on-disk path so each
  // repo shows its real location in AGENTS.md.
  const active = manifest.repositories.filter(
    (repository) => repository.kind === "code" && repository.status === "active",
  );
  const lines = active.length === 0
    ? ["- No active repositories are configured."]
    : active.map((repository) => {
        const rel = resolveRelativePath?.(repository) ?? `repositories/${repository.alias}`;
        return `- \`${repository.alias}\` (${repository.kind}, id: \`${repository.id}\`): \`${rel}\``;
      });
  return `<!-- workspace-managed:repositories:start -->
## Workspace repositories

${lines.join("\n")}
<!-- workspace-managed:repositories:end -->`;
}

/** Render the workspace-managed **knowledge** segment of AGENTS.md (redesign
 *  decisions 9, 10, 11, 13). Lists every *active knowledge* repository and
 *  **references** each bundle's `index.md` rather than inlining it — pi injects
 *  AGENTS.md verbatim with no `@`-include expansion, so large content must be
 *  referenced out and the model follows the reference to `read` it on demand.
 *
 *  Lives here (next to `renderWorkspaceRepositories`) so `renderWorkspaceAgents`
 *  below can call it without a service.ts → templates.ts cycle, and so
 *  `updateManagedRepositoryInstructions` in service.ts can import it the same way
 *  it already imports `renderWorkspaceRepositories`. The marker anchors follow the
 *  exact same `<!-- workspace-managed:knowledge:start/end -->` pattern. */
export function renderKnowledgeSection(
  manifest: WorkspaceManifest,
  resolveRelativePath?: (repository: WorkspaceRepository) => string,
): string {
  const active = manifest.repositories.filter(
    (repository) => repository.kind === "knowledge" && repository.status === "active",
  );
  const lines = active.length === 0
    ? ["- No knowledge bundles are configured. Initialize or clone one under the 知识库 view."]
    : active.map(
      (repository) => {
        const rel = resolveRelativePath?.(repository) ?? `knowledge/${repository.alias}`;
        return `- \`${repository.alias}\` (id: \`${repository.id}\`): OKF bundle — read its index at \`${rel}/index.md\` to traverse it (L0: \`read\`/\`ls\`/\`grep\`, no tool required).`;
      },
    );
  return `<!-- workspace-managed:knowledge:start -->
## Knowledge bundles (OKF v0.2)

Each knowledge bundle is an OKF directory tree of Markdown + YAML frontmatter. The
\`index.md\` of each bundle is the progressive-disclosure entry point — **read it on
demand**, do not load a whole bundle up front. L0 access (\`read\`/\`ls\`/\`grep\`) is
always available and needs no search tool.

${lines.join("\n")}
<!-- workspace-managed:knowledge:end -->`;
}

/** Capability-driven AGENTS.md generator (redesign decision 9). It depends only on
 *  the manifest's capabilities/git settings, not on a template id, so every
 *  workspace gets a tailored collaboration policy. The repositories block uses the
 *  `<!-- workspace-managed:repositories:start/end -->` markers, so
 *  `updateManagedRepositoryInstructions` keeps working unchanged. */
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
  if (capabilities.includes("knowledge")) {
    lines.push("");
    lines.push(renderKnowledgeSection(manifest));
  }
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

/** `.gitignore` written for git-using workspaces (a git repo is initialized when
 *  the `repositories` or `work-items` capability is on). Ignores rebuildable
 *  workspace state and the independently-managed nested repositories. */
export const SOFTWARE_DEVELOPMENT_GITIGNORE = `# Pi Workspace rebuildable state
/.pi/cache/
/.pi/*.sqlite

# Nested repositories are managed independently
/repositories/
`;
