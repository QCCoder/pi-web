import fs from "fs";
import path from "path";
import { resolveDirentIsDirectory } from "@/lib/file-dirent";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);
const IGNORED_SUFFIXES = [".pyc"];
const MAX_REPO_ROOTS = 128;

/**
 * Backstop against symlink cycles and runaway trees during repo discovery.
 * IGNORED_NAMES already prunes build output; 32 is generous for nesting.
 * Mirrors the value historically used by the file-index walk.
 */
export const MAX_DISCOVER_DEPTH = 32;

export interface DiscoverResult {
  /** Every directory containing a `.git` at or below cwd, in BFS order. */
  repoRoots: string[];
  /** Files outside any repo boundary (relative to cwd), only when requested. */
  scatteredFiles: string[];
}

/**
 * Walk the cwd tree once to discover nested git repository roots (any
 * directory containing a `.git`, whether a submodule gitlink file or an
 * independent repo directory) and, optionally, collect "scattered" files that
 * live outside every repo.
 *
 * Files inside any repo boundary are NOT collected here — each repo's own
 * `git ls-files` / `git status` lists them (honoring that repo's .gitignore).
 * We still recurse into repos so deeper nested repos are discovered. This is
 * what makes submodules, independent nested repos, and worktrees all visible.
 *
 * Shared by /api/file-index (scattered + per-repo ls-files) and git-status
 * (roots only, for per-repo status). Roots-only skips the scattered-file
 * accumulation so large trees do not build a list just to discard it.
 */
function walkTree(cwd: string, collectScattered: boolean): DiscoverResult {
  const repoRoots: string[] = [];
  const repoRootSet = new Set<string>();
  const scatteredFiles: string[] = [];

  // BFS carrying whether any ancestor directory was a git repo. A file is only
  // "scattered" (collected here) if no ancestor — and its own directory — is a
  // repo; otherwise the owning repo's git lists it. We still recurse into repos
  // so deeper nested repos are discovered.
  const queue: Array<{ abs: string; rel: string; depth: number; ancestorIsRepo: boolean }> = [
    { abs: cwd, rel: "", depth: 0, ancestorIsRepo: false },
  ];

  while (queue.length > 0) {
    const { abs, rel, depth, ancestorIsRepo } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }

    const isRepo = dirents.some((d) => d.name === ".git");
    if (isRepo && !repoRootSet.has(abs) && repoRoots.length < MAX_REPO_ROOTS) {
      repoRootSet.add(abs);
      repoRoots.push(abs);
    }
    const ownsFiles = isRepo || ancestorIsRepo;

    if (depth >= MAX_DISCOVER_DEPTH) continue;

    for (const d of dirents) {
      if (d.name === ".git") continue; // never descend into a .git
      if (IGNORED_NAMES.has(d.name) || IGNORED_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(abs, d.name);
      const childIsDir = resolveDirentIsDirectory(d, childAbs);
      if (childIsDir === null) continue; // unreadable / broken symlink
      if (childIsDir) {
        queue.push({ abs: childAbs, rel: childRel, depth: depth + 1, ancestorIsRepo: ownsFiles });
      } else if (collectScattered && !ownsFiles) {
        scatteredFiles.push(childRel);
      }
    }
  }

  return { repoRoots, scatteredFiles };
}

/** Every git repository root at or below cwd (BFS order). Does not collect files. */
export function discoverRepoRoots(cwd: string): string[] {
  return walkTree(cwd, false).repoRoots;
}

/** Repository roots at/below cwd plus files that live outside every repo. */
export function discoverReposAndScattered(cwd: string): DiscoverResult {
  return walkTree(cwd, true);
}
