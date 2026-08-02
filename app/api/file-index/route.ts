import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy";
import { discoverReposAndScattered } from "@/lib/git-discover";
import { mergeFileLists, type FileListing } from "@/lib/file-index";

const execFileAsync = promisify(execFile);

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard cap on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { timeout: 10_000, env: { ...process.env, LC_ALL: "C" } },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** List one repo's files relative to cwd. Best-effort: any git error (missing
 *  submodule checkout, corrupt .git, timeout) returns an empty list. */
async function listGitFiles(repoRoot: string, cwd: string): Promise<string[]> {
  try {
    const cwdWithinRepo = path.relative(repoRoot, cwd);
    const pathspec = cwdWithinRepo && !cwdWithinRepo.startsWith(`..${path.sep}`)
      ? ["--", cwdWithinRepo]
      : [];
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z", ...pathspec],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    return stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => path.relative(cwd, path.join(repoRoot, file)).split(path.sep).join("/"))
      .filter((file) => file !== ".." && !file.startsWith("../"));
  } catch {
    return [];
  }
}

/** Unified listing: discover all nested repos + scattered files, git-list each
 *  repo in parallel, merge with the ignore post-filter, then apply the hard
 *  cap. Replaces the old single-repo listWithGit / readdir listWithWalk. */
async function listAllFiles(cwd: string): Promise<FileListing> {
  const { repoRoots, scatteredFiles } = discoverReposAndScattered(cwd);
  const primaryRoot = await findRepositoryRoot(cwd);
  const roots = Array.from(new Set(primaryRoot ? [primaryRoot, ...repoRoots] : repoRoots));
  const gitLists = await Promise.all(
    roots.map((root) => listGitFiles(root, cwd)),
  );
  const nonRepoFiles = primaryRoot ? [] : scatteredFiles;
  const all = mergeFileLists([nonRepoFiles, ...gitLists]);
  if (all.length > GIT_HARD_CAP) {
    return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
  }
  return { files: all, hardTruncated: false };
}

// GET /api/file-index?cwd=/abs/path[&q=query]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd).
// The listing spans the cwd repo AND every nested git repo it contains
// (submodules, independent nested repos, worktrees) plus scattered files
// outside any repo — each repo's own .gitignore is honored. Guarded by the
// same allow-list as /api/files.
export async function GET(req: NextRequest) {
  try {
    const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const cache = getIndexCache();
    const now = Date.now();
    let cached = cache.get(cwd);
    if (!cached || cached.expiresAt <= now) {
      const listing = await listAllFiles(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cached = { listing, expiresAt: now + CACHE_TTL_MS };
      cache.set(cwd, cached);
    }

    if (query) {
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      return NextResponse.json({ matches: filterFileEntries(cached.entries, query) });
    }

    const { files, hardTruncated } = cached.listing;
    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
