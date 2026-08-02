export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

/**
 * One repository's changed files plus its own line-stat subtotals. A change
 * listing is split into one group per discovered git repository under the cwd
 * (the primary/enclosing repo plus any nested repos), so multi-repo projects
 * show every repository's changes instead of only the top-level one.
 */
export interface RepoGroup {
  /** Absolute working-tree root of the repository this group belongs to. */
  repositoryRoot: string;
  /** This repository's own additions subtotal (tracked numstat + untracked lines). */
  additions: number;
  /** This repository's own deletions subtotal. */
  deletions: number;
  /** Changed files in this repository. `filePath` is absolute. */
  files: GitFileStatus[];
}

export interface GitStatusResponse {
  /** True when at least one repository under cwd has changes. */
  isGitRepository: boolean;
  /** Per-repository groups; only repositories with changes appear. Primary
   *  repository (the one enclosing cwd) first, then nested repos by relative path. */
  groups: RepoGroup[];
  /** Grand totals across every group (for the section header badge). */
  additions: number;
  deletions: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}
