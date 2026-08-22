/**
 * Persistent, mtime-incremental index over the .jsonl session files under
 * `~/.pi/agent/sessions` (active + `.archived/`), for the session LIST paths
 * (sidebar, locate, archive modal). Same pattern as the kb-search index: the
 * `.jsonl` files are the source of truth; this index is a rebuildable cache.
 * A missing/corrupt cache file simply triggers a full rebuild.
 *
 * Why: `SessionManager.listAll()` re-reads every session file on each cold
 * scan (O(total files)); with hundreds of sessions that is seconds per list
 * refresh. Here each file is re-parsed only when its mtime+size changed —
 * `ensureSessionIndex()` is stat-heavy, not read-heavy, for the steady state.
 *
 * Entry semantics deliberately mirror the SDK's `buildSessionInfo`:
 *  - messageCount counts every `type === "message"` entry;
 *  - firstMessage is the first *user* message's text content;
 *  - name is the latest `session_info` entry's name;
 *  - modified falls back last-activity → header timestamp → file mtime.
 * firstMessage is truncated at index time (list rows only need a title).
 */

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withWorkspaceWriteLock } from "./workspaces/service";

const SESSION_INDEX_SCHEMA_VERSION = 1 as const;
const FIRST_MESSAGE_MAX_CHARS = 400;

export interface SessionIndexEntry {
  /** Absolute path of the .jsonl file. Cache key. */
  path: string;
  id: string;
  cwd: string;
  name?: string;
  /** Header `timestamp` as epoch ms. */
  createdMs: number;
  /** SDK semantics: last user/assistant activity, else header time, else mtime. */
  modifiedMs: number;
  messageCount: number;
  /** Truncated first user message text (raw; the reader applies skill titles). */
  firstMessage: string;
  /** Absolute path from the header's `parentSession`, if any. */
  parentPath?: string;
  /** True when the file lives under a `<dir>/.archived/` subtree. */
  archived: boolean;
  mtimeMs: number;
  size: number;
}

interface SessionIndexFile {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  entries: SessionIndexEntry[];
}

declare global {
  /** Memoized snapshot + build time. The memo is TTL-bound (see
   * SESSION_INDEX_MEMO_TTL_MS): a memo hit only coalesces concurrent calls,
   * it must never freeze the process's view of the sessions directory — the
   * daemon writes new .jsonl files (subagent children, loop rounds) in a
   * different process, so a forever-memo makes them invisible to
   * locate/detail/list until a restart. New global name (the old
   * `__piSessionIndexCache` array shape is not reused) so a stale value from
   * a hot-reloaded module graph can never be misread. */
  var __piSessionIndexMemo: { entries: SessionIndexEntry[]; at: number } | undefined;
  var __piSessionIndexPromise: Promise<SessionIndexEntry[]> | undefined;
  /** True when the last index save failed — later calls retry the save in the
   *  background while still serving the in-memory snapshot. */
  var __piSessionIndexSaveDirty: boolean | undefined;
  var __piSessionIndexSaveRetry: Promise<void> | undefined;
}

/** How long an in-memory index snapshot is served before the (cheap,
 * mtime+size incremental) re-walk runs again. Aligns with the session-list
 * TTL (SESSION_LIST_CACHE_TTL_MS): fresh sessions appear on the next poll,
 * not on the next process restart. Env-overridable for tests, mirroring the
 * heartbeat's PI_SESSION_STALL_*_MS convention. */
const DEFAULT_SESSION_INDEX_MEMO_TTL_MS = 3_000;

function sessionIndexMemoTtlMs(): number {
  const raw = Number(process.env.PI_SESSION_INDEX_MEMO_TTL_MS);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : DEFAULT_SESSION_INDEX_MEMO_TTL_MS;
}

export function sessionIndexPath(): string {
  return join(getAgentDir(), "sessions", ".index.json");
}

function parseLine(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") return null;
  return entry as Record<string, unknown>;
}

function isMessageWithContent(message: unknown): message is { role: string; content?: unknown; timestamp?: unknown } {
  return typeof message === "object" && message !== null && typeof (message as { role?: unknown }).role === "string";
}

function extractTextContent(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { text?: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

/** Parse one session file into an index entry (SDK `buildSessionInfo` parity).
 *  Returns null for files without a valid session header. */
async function buildIndexEntry(
  filePath: string,
  archived: boolean,
  stats: { mtimeMs: number; size: number },
): Promise<SessionIndexEntry | null> {
  let header: Record<string, unknown> | null = null;
  let messageCount = 0;
  let firstMessage = "";
  let name: string | undefined;
  let lastActivityMs: number | undefined;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // torn tail line from an in-flight write
      }
      const entry = parseLine(parsed);
      if (!entry) continue;
      if (!header) {
        if (entry.type !== "session") return null;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        const candidate = typeof entry.name === "string" ? entry.name.trim() : "";
        name = candidate || undefined;
      }
      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message;
      if (!isMessageWithContent(message)) continue;
      if (message.role === "user" || message.role === "assistant") {
        const msgTimestamp = typeof message.timestamp === "number"
          ? message.timestamp
          : Number.isNaN(Date.parse(String(entry.timestamp)))
            ? undefined
            : Date.parse(String(entry.timestamp));
        if (typeof msgTimestamp === "number") {
          lastActivityMs = Math.max(lastActivityMs ?? 0, msgTimestamp);
        }
      }
      if (!firstMessage && message.role === "user") {
        firstMessage = extractTextContent(message).slice(0, FIRST_MESSAGE_MAX_CHARS);
      }
    }
  } catch {
    return null;
  }
  if (!header) return null;
  const headerTimeMs = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  const modifiedMs =
    typeof lastActivityMs === "number" && lastActivityMs > 0
      ? lastActivityMs
      : !Number.isNaN(headerTimeMs)
        ? headerTimeMs
        : stats.mtimeMs;
  return {
    path: filePath,
    id: typeof header.id === "string" ? header.id : "",
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    ...(name !== undefined ? { name } : {}),
    createdMs: !Number.isNaN(headerTimeMs) ? headerTimeMs : stats.mtimeMs,
    modifiedMs,
    messageCount,
    firstMessage,
    ...(typeof header.parentSession === "string" ? { parentPath: header.parentSession } : {}),
    archived,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function isValidEntry(value: unknown): value is SessionIndexEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string"
    && typeof record.id === "string"
    && typeof record.mtimeMs === "number"
    && typeof record.size === "number"
    && typeof record.archived === "boolean"
  );
}

async function loadIndexFile(): Promise<Map<string, SessionIndexEntry>> {
  const map = new Map<string, SessionIndexEntry>();
  let content: string;
  try {
    content = await readFile(sessionIndexPath(), "utf8");
  } catch {
    return map;
  }
  try {
    const parsed = JSON.parse(content) as SessionIndexFile;
    if (parsed.schemaVersion !== SESSION_INDEX_SCHEMA_VERSION || !Array.isArray(parsed.entries)) return map;
    for (const entry of parsed.entries) {
      if (isValidEntry(entry)) map.set(entry.path, entry);
    }
  } catch {
    // Corrupt cache → full rebuild.
  }
  return map;
}

interface DiscoveredFile {
  path: string;
  archived: boolean;
  mtimeMs: number;
  size: number;
}

async function discoverSessionFiles(root: string): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const cwdDir = join(root, dir.name);
    const collect = async (directory: string, archived: boolean) => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const filePath = join(directory, entry.name);
        try {
          const stats = await stat(filePath);
          files.push({ path: filePath, archived, mtimeMs: stats.mtimeMs, size: stats.size });
        } catch {
          // raced away; next pass picks it up
        }
      }
    };
    await collect(cwdDir, false);
    await collect(join(cwdDir, ".archived"), true);
  }
  return files;
}

/** Drop the in-memory snapshot (after archive/restore moves a file underneath
 *  the index); the next ensure re-walks and re-parses only what changed. */
export function invalidateSessionIndexMemory(): void {
  globalThis.__piSessionIndexMemo = undefined;
  globalThis.__piSessionIndexPromise = undefined;
  globalThis.__piSessionIndexSaveDirty = undefined;
  globalThis.__piSessionIndexSaveRetry = undefined;
}

async function saveIndexFile(entries: SessionIndexEntry[]): Promise<void> {
  const target = sessionIndexPath();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const file: SessionIndexFile = { schemaVersion: SESSION_INDEX_SCHEMA_VERSION, entries };
  await writeFile(temporary, JSON.stringify(file), "utf8");
  await rename(temporary, target);
}

const MAX_CONCURRENT_ENTRY_BUILDS = 10;

/** Ensure the persistent index is fresh (mtime+size incremental) and return
 *  every session entry, active and archived. The in-memory memo is TTL-bound
 *  and single-flight per process: concurrent callers share one walk, and an
 *  expired memo re-walks incrementally (~stat-heavy, not read-heavy) so files
 *  created by OTHER processes (the session daemon spawning subagent children)
 *  become visible without a restart. */
export async function ensureSessionIndex(): Promise<SessionIndexEntry[]> {
  const memo = globalThis.__piSessionIndexMemo;
  if (memo && Date.now() - memo.at < sessionIndexMemoTtlMs()) {
    // A previously failed save must not stick for the process lifetime: retry
    // it in the background (single-flight) while serving the memory snapshot.
    if (globalThis.__piSessionIndexSaveDirty && !globalThis.__piSessionIndexSaveRetry) {
      const entries = memo.entries;
      globalThis.__piSessionIndexSaveRetry = (async () => {
        try {
          await withWorkspaceWriteLock(sessionIndexPath(), () => saveIndexFile(entries));
          globalThis.__piSessionIndexSaveDirty = false;
        } catch {
          // still dirty — the next ensure retries again
        } finally {
          globalThis.__piSessionIndexSaveRetry = undefined;
        }
      })();
    }
    return memo.entries;
  }
  if (globalThis.__piSessionIndexPromise) return globalThis.__piSessionIndexPromise;

  const load = (async (): Promise<SessionIndexEntry[]> => {
    const root = join(getAgentDir(), "sessions");
    const cached = await loadIndexFile();
    const files = await discoverSessionFiles(root);

    const next: SessionIndexEntry[] = [];
    const stale: DiscoveredFile[] = [];
    const seenPaths = new Set<string>();
    for (const file of files) {
      seenPaths.add(file.path);
      const hit = cached.get(file.path);
      if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) {
        next.push(hit);
      } else {
        stale.push(file);
      }
    }

    if (stale.length > 0) {
      // Bounded concurrency re-parse of only new/changed files (SDK parity).
      let cursor = 0;
      const workers = Array.from({ length: Math.min(MAX_CONCURRENT_ENTRY_BUILDS, stale.length) }, async () => {
        while (cursor < stale.length) {
          const file = stale[cursor++];
          const entry = await buildIndexEntry(file.path, file.archived, file);
          if (entry) next.push(entry);
        }
      });
      await Promise.all(workers);
    }

    let changed = stale.length > 0;
    for (const path of cached.keys()) {
      if (!seenPaths.has(path)) changed = true; // deletions/moves
    }
    next.sort((left, right) => left.path.localeCompare(right.path));

    if (changed) {
      try {
        await withWorkspaceWriteLock(sessionIndexPath(), () => saveIndexFile(next));
        globalThis.__piSessionIndexSaveDirty = false;
      } catch (error) {
        // A failed cache write must not fail the list — the in-memory snapshot
        // still serves, and the next ensure retries the save (see below).
        globalThis.__piSessionIndexSaveDirty = true;
        console.error("[session-index] cache write failed:", error);
      }
    }

    globalThis.__piSessionIndexMemo = { entries: next, at: Date.now() };
    return next;
  })();

  globalThis.__piSessionIndexPromise = load;
  try {
    return await load;
  } finally {
    globalThis.__piSessionIndexPromise = undefined;
  }
}

/** Look a session up by id through the (fresh) index — the locate path's
 *  replacement for "invalidate + force a full list scan". */
export async function findSessionIndexEntry(sessionId: string): Promise<SessionIndexEntry | null> {
  const entries = await ensureSessionIndex();
  return entries.find((entry) => entry.id === sessionId) ?? null;
}

// cache-buster: force webpack recompile after the comment fix above
// bump 1787325665
// bump 1787327302219282000
// bump 1787472599 (memo TTL fix)
