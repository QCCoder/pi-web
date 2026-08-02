import path from "path";
import type { GitFileStatus, RepoGroup } from "./git-types";

export interface GitPorcelainEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

function usesRenamePath(indexStatus: string, worktreeStatus: string): boolean {
  return indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
}

export function parseGitPorcelainV1(output: string): GitPorcelainEntry[] {
  const records = output.split("\0");
  const entries: GitPorcelainEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4 || record[2] !== " ") continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const entry: GitPorcelainEntry = {
      path: record.slice(3),
      indexStatus,
      worktreeStatus,
    };
    if (usesRenamePath(indexStatus, worktreeStatus)) {
      entry.originalPath = records[++i] || undefined;
    }
    entries.push(entry);
  }

  return entries;
}

const CONFLICT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function classifyGitStatus(entry: GitPorcelainEntry): Pick<GitFileStatus, "status" | "code"> {
  const pair = `${entry.indexStatus}${entry.worktreeStatus}`;
  if (pair === "??") return { status: "untracked", code: "U" };
  if (CONFLICT_STATUSES.has(pair) || pair.includes("U")) return { status: "conflict", code: "C" };
  if (pair.includes("D")) return { status: "deleted", code: "D" };
  if (pair.includes("R") || pair.includes("C")) return { status: "renamed", code: "R" };
  if (pair.includes("A")) return { status: "added", code: "A" };
  return { status: "modified", code: "M" };
}

/** True when `target` is `parent` itself or nested below it (both absolute). */
export function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** A repository's raw gathered status before grouping/dedup. */
export interface RawRepoStatus {
  /** Absolute working-tree root of this repository. */
  root: string;
  /** True for the repository that encloses cwd (scoped to cwd). */
  isPrimary: boolean;
  /** Directory changes are scoped to: cwd for the primary repo, the repo's own
   *  root for nested repos. */
  scopeCwd: string;
  /** All porcelain status entries for this repository (cwd-scoping applied here). */
  entries: GitPorcelainEntry[];
  /** Tracked additions/deletions from `git diff --numstat HEAD` (already scoped). */
  trackedAdditions: number;
  trackedDeletions: number;
}

/**
 * Pure assembly of per-repository raw status into display groups.
 *
 * For each repository: resolve entry paths to absolute file paths, drop entries
 * outside the repo's scope cwd, drop entries that point at another discovered
 * repository boundary (D1 dedup — that nested repo's own group lists its real
 * changes), classify the status, and emit a group only if it has files left.
 * Groups are ordered: primary (cwd-enclosing) repo first, then nested repos by
 * path relative to cwd.
 *
 * Untracked line counts are NOT computed here (they read files from disk); the
 * caller adds them to each group's `additions` afterwards.
 */
export function buildRepoGroups(
  cwd: string,
  primaryRoot: string | null,
  repos: RawRepoStatus[],
  allRoots: Set<string>,
): RepoGroup[] {
  const groups: RepoGroup[] = [];
  for (const repo of repos) {
    const files: GitFileStatus[] = [];
    for (const entry of repo.entries) {
      const filePath = path.resolve(repo.root, entry.path);
      if (!isWithinPath(repo.scopeCwd, filePath)) continue;
      // D1 dedup: a parent repo reports a nested repo as a single boundary
      // entry (submodule gitlink / untracked dir). The nested repo's own group
      // already shows its real changes, so drop the boundary entry to avoid
      // double-listing and double-counting.
      if (allRoots.has(filePath) && filePath !== repo.root) continue;
      const classified = classifyGitStatus(entry);
      files.push({
        filePath,
        ...classified,
        indexStatus: entry.indexStatus,
        worktreeStatus: entry.worktreeStatus,
      });
    }
    if (files.length === 0) continue;
    groups.push({
      repositoryRoot: repo.root,
      files,
      additions: repo.trackedAdditions,
      deletions: repo.trackedDeletions,
    });
  }
  // Primary repo first, then nested repos alphabetically by cwd-relative path.
  groups.sort((a, b) => {
    const aPrimary = a.repositoryRoot === primaryRoot ? 0 : 1;
    const bPrimary = b.repositoryRoot === primaryRoot ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;
    return path.relative(cwd, a.repositoryRoot).localeCompare(path.relative(cwd, b.repositoryRoot));
  });
  return groups;
}
