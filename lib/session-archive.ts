// Session archive primitives: move .jsonl files between an encoded-cwd session
// directory and its `.archived/` subdirectory. `SessionManager.listAll()` only
// scans the top-level .jsonl files of each cwd directory (it does not recurse),
// so moving a file into `.archived/` hides it from the normal session list, and
// moving it back restores it — with no changes to the .jsonl format that pi owns.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir, readdir, rename, stat, unlink } from "fs/promises";
import { basename, dirname, join } from "path";
import {
  cacheSessionPath,
  getAgentDir,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readSessionHeader,
  resolveSessionPath,
} from "./session-reader";
import { getRpcSession } from "./rpc-manager";

/** Root directory holding all per-cwd session folders (~/.pi/agent/sessions). */
function getSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

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
}

/** The `.archived/` directory sibling to a session file. */
function archiveDirFor(sessionFilePath: string): string {
  return join(dirname(sessionFilePath), ARCHIVE_DIR_NAME);
}

function firstUserMessageText(entries: { type: string; message?: { role: string; content: unknown } }[]): string {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const textBlock = content.find((b: { type?: string }) => b?.type === "text") as { text?: string } | undefined;
      if (textBlock?.text) return textBlock.text;
    }
  }
  return "";
}

async function buildArchivedSessionInfo(filePath: string): Promise<ArchivedSessionInfo | null> {
  const header = readSessionHeader(filePath);
  if (!header?.id) return null;
  let name = "";
  let firstMessage = "";
  try {
    const sm = SessionManager.open(filePath);
    name = sm.getSessionName() ?? "";
    firstMessage = firstUserMessageText(sm.getEntries() as never);
  } catch {
    // Degrade gracefully — header-only info is still usable for restore/delete.
  }
  let modified: string;
  let archivedAt: string;
  try {
    const s = await stat(filePath);
    modified = s.mtime.toISOString();
    archivedAt = s.mtime.toISOString();
  } catch {
    modified = header.timestamp ?? new Date().toISOString();
    archivedAt = modified;
  }
  return {
    id: header.id,
    path: filePath,
    cwd: header.cwd ?? "",
    name,
    firstMessage: firstMessage || "(no messages)",
    modified,
    archivedAt,
  };
}

async function loadArchivedSessions(): Promise<ArchivedSessionInfo[]> {
  const sessionsDir = getSessionsDir();
  const out: ArchivedSessionInfo[] = [];
  let cwdDirs: string[];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    cwdDirs = entries.filter((e) => e.isDirectory() && e.name !== ARCHIVE_DIR_NAME).map((e) => join(sessionsDir, e.name));
  } catch {
    return [];
  }
  for (const cwdDir of cwdDirs) {
    const archiveDir = join(cwdDir, ARCHIVE_DIR_NAME);
    let files: string[];
    try {
      files = (await readdir(archiveDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const info = await buildArchivedSessionInfo(join(archiveDir, file));
      if (info) out.push(info);
    }
  }
  out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return out;
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

/** Move an active session into its project's `.archived/` subdirectory. */
export async function archiveSession(sessionId: string): Promise<{ archivedPath: string }> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionArchiveError("Session not found");
  getRpcSession(sessionId)?.destroy();
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
  getRpcSession(sessionId)?.destroy();
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
  getRpcSession(sessionId)?.destroy();
  await unlink(archivedPath);
  invalidateArchivedSessionsCache();
  return { ok: true };
}

/** True if a session id currently resolves to an archived file. */
export async function isSessionArchived(sessionId: string): Promise<boolean> {
  return (await resolveArchivedSessionPath(sessionId)) !== null;
}
