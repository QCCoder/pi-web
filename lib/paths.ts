import { normalize, parse, sep } from "path";

// Partial port of upstream lib/paths.ts — only the comparison primitives the
// terminal manager needs. The full module (native/slash canonical forms,
// API path rebuilding) lands with the tasks that consume it.
//
// Comparison always goes through samePath(), never `===`: git emits POSIX-style
// paths even on Windows, and Windows itself is case-insensitive, so raw string
// equality silently fails on both counts.

export function toNativePath(p: string): string {
  if (!p || process.platform !== "win32") return p;
  return normalize(p);
}

export function toSlashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeForComparison(p: string): string {
  const normalized = normalize(toNativePath(p));
  const rootLength = parse(normalized).root.length;
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === sep) end--;
  return normalized.slice(0, end);
}

/**
 * Whether two paths denote the same location, tolerating separator style and —
 * on Windows, where the filesystem is case-insensitive — case, including the
 * drive letter (`d:\repo` vs `D:\repo`).
 *
 * Compares lexically: callers wanting symlinks resolved should realpath first.
 */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (process.platform === "win32") {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }
  return normalizedA === normalizedB;
}
