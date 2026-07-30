// Pure helpers for /api/file-index: shared ignore rules, path prefixing, and
// merge/dedupe for the multi-repo file listing. The filesystem walk and git
// invocation live in the route; these are the unit-testable pieces.

/**
 * Directory/file names never indexed, even when a repo committed them. Mirrors
 * the readdir fallback's skip list so the git path and the walk path behave the
 * same way.
 */
export const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

export const IGNORED_SUFFIXES = [".pyc"];

/**
 * Maximum number of nested repository roots to discover before stopping. A
 * project with more nested repos than this is pathological; extras are simply
 * not git-listed (scattered-file collection still continues).
 */
export const MAX_REPO_ROOTS = 256;

export interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

/**
 * True when a relative "/"-separated path has any segment in IGNORED_NAMES or
 * ends with an ignored suffix. Applied as a belt-and-suspenders filter on git
 * ls-files results (which otherwise only honor .gitignore) so a repo that
 * accidentally committed node_modules cannot flood the index.
 */
export function isIgnoredPath(relPath: string): boolean {
  if (IGNORED_SUFFIXES.some((s) => relPath.endsWith(s))) return true;
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (IGNORED_NAMES.has(seg)) return true;
  }
  return false;
}

/**
 * Prefix to apply to files listed inside a nested repo whose absolute root is
 * `repoRoot`, so the result is relative to `cwd`. Returns "" when repoRoot is
 * the top-level cwd itself. Both inputs are absolute, "/"-separated paths and
 * repoRoot must be equal to or nested under cwd.
 */
export function repoPrefix(cwd: string, repoRoot: string): string {
  if (repoRoot === cwd) return "";
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  if (repoRoot.startsWith(base)) return repoRoot.slice(base.length);
  // Fallback: should not happen for discovered roots.
  return "";
}

/**
 * Merge several relative-path file lists into one, dropping empties, applying
 * the IGNORED_NAMES post-filter, and deduping (first occurrence wins). Used to
 * combine scattered files with each nested repo's git ls-files output.
 */
export function mergeFileLists(lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const file of list) {
      if (!file || seen.has(file) || isIgnoredPath(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  return out;
}
