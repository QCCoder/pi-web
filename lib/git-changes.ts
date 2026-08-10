import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { discoverRepoAndWorktreeRoots } from "./git-discover";
import type {
  GitFileDiffResponse,
  GitStatusResponse,
} from "./git-types";
import {
  buildRepoGroups,
  classifyGitStatus,
  isWithinPath,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
  type RawRepoStatus,
} from "./git-status";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

async function readTrackedLineStats(
  repositoryRoot: string,
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  const relativeCwd = toGitPath(path.relative(repositoryRoot, cwd));
  const pathspec = relativeCwd || ".";
  try {
    const output = await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

function countUntrackedTextLines(filePath: string): number {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return 0;
    const content = fs.readFileSync(filePath);
    if (hasNullByte(content) || content.length === 0) return 0;
    const text = content.toString("utf8");
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const primaryRoot = await findRepositoryRoot(cwd);
  // Worktrees are separated out so they are not queried as independent repos
  // (their branch-vs-HEAD diff is not workspace change). Their paths are still
  // returned so the nested-boundary dedup below can drop each parent repo's
  // `worktrees/<name>` untracked entry.
  const { repoRoots: nestedRoots, worktreeRoots } = discoverRepoAndWorktreeRoots(cwd);
  const allRoots = new Set<string>();
  if (primaryRoot) allRoots.add(primaryRoot);
  for (const root of nestedRoots) allRoots.add(root);
  for (const root of worktreeRoots) allRoots.add(root);

  // Repositories to query: the primary (enclosing) repo scoped to cwd, plus
  // every nested MAIN repo scoped to its own root. Worktrees are deliberately
  // excluded — they are parallel checkouts of an already-queried main repo.
  // The primary may also appear in nestedRoots (when cwd is itself a repo) —
  // skip it so it's queried once.
  const queryRepos: Array<{ root: string; isPrimary: boolean; scopeCwd: string }> = [];
  if (primaryRoot) queryRepos.push({ root: primaryRoot, isPrimary: true, scopeCwd: cwd });
  for (const root of nestedRoots) {
    if (root === primaryRoot) continue;
    queryRepos.push({ root, isPrimary: false, scopeCwd: root });
  }

  if (queryRepos.length === 0) {
    return { isGitRepository: false, groups: [], additions: 0, deletions: 0 };
  }

  // Best-effort per repo: a corrupt .git or an unchecked-out submodule must
  // not abort the whole listing, so failures are swallowed per repo.
  const gathered: RawRepoStatus[] = [];
  await Promise.all(queryRepos.map(async (repo) => {
    try {
      const [entries, trackedLineStats] = await Promise.all([
        readStatusEntries(repo.root),
        readTrackedLineStats(repo.root, repo.scopeCwd),
      ]);
      gathered.push({
        root: repo.root,
        isPrimary: repo.isPrimary,
        scopeCwd: repo.scopeCwd,
        entries,
        trackedAdditions: trackedLineStats.additions,
        trackedDeletions: trackedLineStats.deletions,
      });
    } catch {
      // skip this repository
    }
  }));

  const groups = buildRepoGroups(cwd, primaryRoot, gathered, allRoots);

  // Untracked additions read files from disk, so they are added here (after the
  // pure grouping produced the filtered file list) rather than in buildRepoGroups.
  for (const group of groups) {
    let untrackedAdditions = 0;
    for (const file of group.files) {
      if (file.status === "untracked") untrackedAdditions += countUntrackedTextLines(file.filePath);
    }
    group.additions += untrackedAdditions;
  }

  const additions = groups.reduce((sum, group) => sum + group.additions, 0);
  const deletions = groups.reduce((sum, group) => sum + group.deletions, 0);
  return { isGitRepository: queryRepos.length > 0, groups, additions, deletions };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  // Resolve the repository from the FILE's location, not cwd, so a file inside
  // a nested repository is diffed against its own repo rather than the
  // enclosing one. cwd is still used by the route for allow-list checks.
  const repositoryRoot = await findRepositoryRoot(path.dirname(filePath));
  if (!repositoryRoot || !isWithinPath(repositoryRoot, filePath)) return { supported: false };

  const resolvedFilePath = path.resolve(filePath);
  const relativePath = toGitPath(path.relative(repositoryRoot, resolvedFilePath));
  const entries = await readStatusEntries(repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return { supported: true, status, patch };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
