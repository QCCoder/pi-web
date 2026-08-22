// Session archive primitives: move .jsonl files between an encoded-cwd session
// directory and its `.archived/` subdirectory. The session index (lib/session-index)
// scans both locations, so moving a file into `.archived/` flips its `archived`
// flag on the next ensure pass — with no changes to the .jsonl format that pi owns.
import { mkdir, rename, unlink } from "fs/promises";
import { basename, dirname, join } from "path";
import {
  cacheSessionPath,
  firstMessageTitle,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  resolveSessionPath,
} from "./session-reader";
import { ensureSessionIndex, invalidateSessionIndexMemory } from "./session-index";
import { daemonProxy } from "./agent-proxy";

/** Subdirectory name used to archive session files within a cwd session dir. */
export const ARCHIVE_DIR_NAME = ".archived";

export class SessionArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionArchiveError";
  }
}

export interface ArchivedSessionInfo {
  id: string;
  /** Current (archived) absolute file path */
  path: string;
  cwd: string;
  name: string;
  firstMessage: string;
  modified: string;
  /** Approximate archive time — the archived file's mtime. */
  archivedAt: string;
}

// Archived-session list cache on globalThis (survives hot-reload). Invalidated
// on every archive/restore/delete mutation.
declare global {
  var __piArchivedSessionsCache:
    | { data: ArchivedSessionInfo[]; pathById: Map<string, string>; ts: number }
    | undefined;
}

const ARCHIVED_CACHE_TTL_MS = 30_000;

export function invalidateArchivedSessionsCache(): void {
  globalThis.__piArchivedSessionsCache = undefined;
  // The archived list derives from the session index; a move changes paths, so
  // the in-memory index snapshot must go too (the disk walk re-parses only the
  // moved file — everything else still hits the mtime cache).
  invalidateSessionIndexMemory();
}

/** The `.archived/` directory sibling to a session file. */
function archiveDirFor(sessionFilePath: string): string {
  return join(dirname(sessionFilePath), ARCHIVE_DIR_NAME);
}

async function loadArchivedSessions(): Promise<ArchivedSessionInfo[]> {
  const entries = (await ensureSessionIndex()).filter((entry) => entry.archived);
  const data: ArchivedSessionInfo[] = entries.map((entry) => ({
    id: entry.id,
    path: entry.path,
    cwd: entry.cwd,
    name: entry.name ?? "",
    firstMessage: entry.firstMessage ? firstMessageTitle(entry) : "(no messages)",
    modified: new Date(entry.modifiedMs).toISOString(),
    archivedAt: new Date(entry.mtimeMs).toISOString(),
  }));
  data.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return data;
}

export async function listArchivedSessions(): Promise<ArchivedSessionInfo[]> {
  const cached = globalThis.__piArchivedSessionsCache;
  if (cached && Date.now() - cached.ts < ARCHIVED_CACHE_TTL_MS) return cached.data;
  const data = await loadArchivedSessions();
  const pathById = new Map<string, string>();
  for (const s of data) pathById.set(s.id, s.path);
  globalThis.__piArchivedSessionsCache = { data, pathById, ts: Date.now() };
  return data;
}

async function resolveArchivedSessionPath(sessionId: string): Promise<string | null> {
  const cached = globalThis.__piArchivedSessionsCache;
  if (cached?.pathById.has(sessionId)) return cached.pathById.get(sessionId)!;
  await listArchivedSessions();
  return globalThis.__piArchivedSessionsCache?.pathById.get(sessionId) ?? null;
}

/** Best-effort wrapper teardown in the session daemon before moving/deleting
 *  the file underneath it (C2: the daemon owns every live wrapper now). A
 *  daemon hiccup must not block archive/restore — the moved file simply
 *  becomes an orphan the existing reapers handle. */
async function destroyDaemonWrapper(sessionId: string): Promise<void> {
  try {
    const client = await daemonProxy();
    await client.destroySession(sessionId);
  } catch {
    // daemon unreachable — proceed with the file move
  }
}

/** Move an active session into its project's `.archived/` subdirectory. */
export async function archiveSession(sessionId: string): Promise<{ archivedPath: string }> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionArchiveError("Session not found");
  await destroyDaemonWrapper(sessionId);
  const archiveDir = archiveDirFor(filePath);
  await mkdir(archiveDir, { recursive: true });
  const archivedPath = join(archiveDir, basename(filePath));
  await rename(filePath, archivedPath);
  invalidateSessionPathCache(sessionId);
  invalidateSessionListCache();
  invalidateArchivedSessionsCache();
  return { archivedPath };
}

/** Move an archived session back to its project's session directory. */
export async function restoreSession(sessionId: string): Promise<{ restoredPath: string }> {
  const archivedPath = await resolveArchivedSessionPath(sessionId);
  if (!archivedPath) throw new SessionArchiveError("Archived session not found");
  await destroyDaemonWrapper(sessionId);
  // `.archived/` is one level below the cwd session dir; restore = move up one.
  const restoredPath = join(dirname(dirname(archivedPath)), basename(archivedPath));
  await rename(archivedPath, restoredPath);
  cacheSessionPath(sessionId, restoredPath);
  invalidateSessionListCache();
  invalidateArchivedSessionsCache();
  return { restoredPath };
}

/** Permanently delete an archived session file. */
export async function deleteArchivedSession(sessionId: string): Promise<{ ok: true }> {
  const archivedPath = await resolveArchivedSessionPath(sessionId);
  if (!archivedPath) throw new SessionArchiveError("Archived session not found");
  await destroyDaemonWrapper(sessionId);
  await unlink(archivedPath);
  invalidateArchivedSessionsCache();
  return { ok: true };
}

/** True if a session id currently resolves to an archived file. */
export async function isSessionArchived(sessionId: string): Promise<boolean> {
  return (await resolveArchivedSessionPath(sessionId)) !== null;
}
