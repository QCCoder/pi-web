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
 * Matches the gitdir gitlink written into a linked worktree's `.git` file:
 * `gitdir: <mainrepo>/.git/worktrees/<name>`. Submodule gitlinks point at
 * `.git/modules/...` (or a relative path) and intentionally do NOT match, so
 * submodules keep being treated as normal nested repos.
 */
const WORKTREE_GITLINK_RE = /[/\\]\.git[/\\]worktrees[/\\]/;

/**
 * Backstop against symlink cycles and runaway trees during repo discovery.
 * IGNORED_NAMES already prunes build output; 32 is generous for nesting.
 * Mirrors the value historically used by the file-index walk.
 */
export const MAX_DISCOVER_DEPTH = 32;

export interface DiscoverResult {
  /** Every directory containing a `.git` at or below cwd, in BFS order. */
  repoRoots: string[];
  /** Directories that are linked worktrees of another discovered repo
   *  (`<dir>/.git` is a gitlink file whose `gitdir:` points at
   *  `…/.git/worktrees/…`). Populated in both modes: with
   *  `skipWorktrees:false` these are ALSO in `repoRoots` (legacy behavior,
   *  e.g. file-index), with `skipWorktrees:true` they are excluded from
   *  `repoRoots` (e.g. git-status, so worktrees are not queried as independent
   *  repos). */
  worktreeRoots: string[];
  /** Files outside any repo boundary (relative to cwd), only when requested. */
  scatteredFiles: string[];
}

/** Result of {@link discoverRepoAndWorktreeRoots}. */
export interface DiscoverRepoAndWorktreeResult {
  /** Main git repository roots at/below cwd, excluding linked worktrees. */
  repoRoots: string[];
  /** Linked worktree roots at/below cwd (parallel checkouts, not queried). */
  worktreeRoots: string[];
}

/**
 * Detect whether `abs` is a linked worktree: its `.git` is a FILE whose
 * `gitdir:` content points at `…/.git/worktrees/…`. A submodule's `.git`
 * file points at `.git/modules/…` (or a relative path) and so does not match.
 * Any read/stat error is treated as "not a worktree" so the caller keeps
 * handling the directory as a normal repo (never silently drops a repo on a
 * transient FS error).
 */
function isWorktreeGitlink(abs: string, hasGitEntry: boolean): boolean {
  if (!hasGitEntry) return false;
  const gitPath = path.join(abs, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(gitPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false; // a real `.git` directory → normal repo
  let content: string;
  try {
    content = fs.readFileSync(gitPath, "utf8");
  } catch {
    return false;
  }
  return WORKTREE_GITLINK_RE.test(content);
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
 * Linked worktrees (`<repo>/worktrees/<name>`, `.git` gitlink file) are always
 * recorded in `worktreeRoots`. When `skipWorktrees` is true they are NOT added
 * to `repoRoots` and their subtree is not descended into — they are a parallel
 * checkout of an already-discovered main repo, so their branch-vs-HEAD diff
 * should not be queried as an independent repo (its path is still reported so
 * callers can union it into their nested-boundary dedup set). When
 * `skipWorktrees` is false the legacy behavior is preserved: the worktree is
 * also a normal `repoRoots` entry and is descended into (file-index wants
 * worktree files listed).
 *
 * Shared by /api/file-index (scattered + per-repo ls-files,
 * `skipWorktrees:false`) and git-status (`skipWorktrees:true`, roots only, for
 * per-repo status). Roots-only skips the scattered-file accumulation so large
 * trees do not build a list just to discard it.
 */
function walkTree(cwd: string, collectScattered: boolean, skipWorktrees: boolean): DiscoverResult {
  const repoRoots: string[] = [];
  const repoRootSet = new Set<string>();
  const worktreeRoots: string[] = [];
  const worktreeRootSet = new Set<string>();
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

    const hasGit = dirents.some((d) => d.name === ".git");
    const isWorktree = isWorktreeGitlink(abs, hasGit);

    // A linked worktree is a parallel checkout of an already-discovered main
    // repo. Record it (always) so callers can keep its path in their dedup set,
    // but when skipWorktrees is set, do NOT treat it as an independent repo to
    // query and do NOT descend into it.
    if (isWorktree && !worktreeRootSet.has(abs)) {
      worktreeRootSet.add(abs);
      worktreeRoots.push(abs);
    }
    if (isWorktree && skipWorktrees) {
      continue;
    }

    const isRepo = hasGit;
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

  return { repoRoots, worktreeRoots, scatteredFiles };
}

/**
 * Every git repository root at or below cwd (BFS order), INCLUDING linked
 * worktrees (legacy behavior — file-index and other callers expect worktrees
 * to be listed and descended into). Does not collect files. `worktreeRoots` is
 * also returned but ignored by existing callers.
 */
export function discoverRepoRoots(cwd: string): string[] {
  return walkTree(cwd, false, false).repoRoots;
}

/** Repository roots at/below cwd plus files that live outside every repo.
 *  Linked worktrees are included in `repoRoots` (legacy behavior). */
export function discoverReposAndScattered(cwd: string): DiscoverResult {
  return walkTree(cwd, true, false);
}

/**
 * Main git repository roots AND linked worktree roots at/below cwd, with
 * worktrees separated out. Worktrees are NOT in `repoRoots` and are not
 * descended into: they are parallel checkouts of an already-discovered main
 * repo, so the Changes view must not query each one as an independent repo
 * (its branch-vs-HEAD diff is not workspace change). Their paths are still
 * returned in `worktreeRoots` so the caller can union them into its
 * nested-boundary dedup set and drop the parent repo's `worktrees/<name>`
 * untracked entries.
 */
export function discoverRepoAndWorktreeRoots(cwd: string): DiscoverRepoAndWorktreeResult {
  const { repoRoots, worktreeRoots } = walkTree(cwd, false, true);
  return { repoRoots, worktreeRoots };
}
