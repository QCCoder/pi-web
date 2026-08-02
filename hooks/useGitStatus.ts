"use client";

import { useEffect, useMemo, useState } from "react";
import { getFileDirectory, normalizeFilePathSlashes } from "@/lib/file-paths";
import type { GitFileStatus, GitStatusResponse } from "@/lib/git-types";

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

/** Flatten every repo group into a single changed-file list. */
function flatFiles(status: GitStatusResponse | null): GitFileStatus[] {
  if (!status) return [];
  return status.groups.flatMap((group) => group.files);
}

/**
 * Fetches the multi-repository git change listing for a cwd and derives the
 * per-path lookups the file tree uses to decorate nodes (status badge per file,
 * "contains changes" marker per ancestor directory). Single source of truth for
 * both the file tree decoration and the dedicated Changes panel, so the two
 * never disagree.
 */
export function useGitStatus(cwd: string | null, refreshKey: number) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);

  useEffect(() => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey]);

  const files = useMemo(() => flatFiles(status), [status]);

  const gitStatusByPath = useMemo(
    () => new Map(files.map((file) => [normalizeFilePathSlashes(file.filePath), file])),
    [files],
  );

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    if (!cwd) return directories;
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const file of files) {
      let directory = getFileDirectory(normalizeFilePathSlashes(file.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, files]);

  return { status, gitStatusByPath, changedDirectoryPaths };
}
