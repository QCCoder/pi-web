import type { SessionInfo } from "./types";
import type { WorkspaceSummary } from "./workspaces/types";

/** Longest-prefix workspace owner match for a session cwd (nested workspaces:
 *  deeper path wins; unavailable workspaces never own sessions). */
export function workspaceForSession(
  session: { cwd: string },
  workspaces: WorkspaceSummary[],
): WorkspaceSummary | undefined {
  return workspaces
    .filter((workspace) => {
      const prefix = `${workspace.path.replace(/\/+$/, "")}/`;
      return workspace.available && (session.cwd === workspace.path || session.cwd.startsWith(prefix));
    })
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export interface WorkspaceSessionGroup {
  workspace: WorkspaceSummary;
  /** Sessions owned by this workspace, newest first. */
  sessions: SessionInfo[];
  /** `modified` of the group's newest session ("" when the group is empty). */
  latestModified: string;
}

/** Group sessions by owning workspace for the home quick-switch list.
 *  Available workspaces only (each keeps a group, header-only when empty);
 *  subagent children and sessions outside every workspace are dropped.
 *  Groups with sessions sort by latestModified desc; empty groups sink to the
 *  bottom (name asc). */
export function groupSessionsByWorkspace(
  workspaces: WorkspaceSummary[],
  sessions: SessionInfo[],
): WorkspaceSessionGroup[] {
  const byId = new Map<string, WorkspaceSessionGroup>(
    workspaces
      .filter((workspace) => workspace.available)
      .map((workspace) => [workspace.id, { workspace, sessions: [], latestModified: "" }]),
  );
  const owners = [...byId.values()].map((group) => group.workspace);
  for (const session of sessions) {
    if (session.subagentChild) continue;
    const owner = workspaceForSession(session, owners);
    if (!owner) continue;
    byId.get(owner.id)!.sessions.push(session);
  }
  const groups = [...byId.values()];
  for (const group of groups) {
    group.sessions.sort((a, b) => b.modified.localeCompare(a.modified));
    group.latestModified = group.sessions[0]?.modified ?? "";
  }
  groups.sort((a, b) => {
    if (a.latestModified && b.latestModified) return b.latestModified.localeCompare(a.latestModified);
    if (a.latestModified) return -1;
    if (b.latestModified) return 1;
    return a.workspace.name.localeCompare(b.workspace.name);
  });
  return groups;
}

/** Default workspace for the home new-session page: the owner of the most
 *  recently active session → most recently used open tab → first group. */
export function defaultHomeNewSessionWorkspaceId(
  workspaces: WorkspaceSummary[],
  sessions: SessionInfo[],
  mruWorkspaceIds: string[],
): string | null {
  const groups = groupSessionsByWorkspace(workspaces, sessions);
  const latest = groups.find((group) => group.latestModified);
  if (latest) return latest.workspace.id;
  for (const id of mruWorkspaceIds) {
    if (groups.some((group) => group.workspace.id === id)) return id;
  }
  return groups[0]?.workspace.id ?? null;
}
