import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, openSync, readSync } from "fs";
import { normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { sessionPathKey } from "./session-path";
import { ensureSessionIndex, type SessionIndexEntry } from "./session-index";
import { skillMessageTitle } from "./skill-message";
import { resolveProject, type ProjectInfo } from "./worktree";

export { getAgentDir };

/** Title shown in session lists — keep it short; the raw first message can be
 *  tens of KB and once inflated a 1MB /api/sessions payload. */
const FIRST_MESSAGE_DISPLAY_CHARS = 160;

export function firstMessageTitle(entry: Pick<SessionIndexEntry, "firstMessage">): string {
  const raw = entry.firstMessage;
  if (!raw) return "(no messages)";
  const title = skillMessageTitle(raw);
  return title.length > FIRST_MESSAGE_DISPLAY_CHARS
    ? `${title.slice(0, FIRST_MESSAGE_DISPLAY_CHARS)}…`
    : title;
}

/** Map index entries (active only) to the API's SessionInfo shape. */
async function entriesToSessionInfos(entries: SessionIndexEntry[]): Promise<SessionInfo[]> {
  const active = entries.filter((entry) => !entry.archived);
  const pathToId = new Map<string, string>();
  for (const entry of active) pathToId.set(sessionPathKey(entry.path), entry.id);

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(active.map((entry) => entry.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return active.map((entry) => {
    cacheSessionPath(entry.id, entry.path);
    const project = entry.cwd ? projectByCwd.get(entry.cwd) : undefined;
    return {
      path: entry.path,
      id: entry.id,
      cwd: entry.cwd,
      name: entry.name,
      created: new Date(entry.createdMs).toISOString(),
      modified: new Date(entry.modifiedMs).toISOString(),
      messageCount: entry.messageCount,
      firstMessage: firstMessageTitle(entry),
      parentSessionId: entry.parentPath ? pathToId.get(sessionPathKey(entry.parentPath)) : undefined,
      projectRoot: project?.projectRoot ?? entry.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  }).sort((left, right) => right.modified.localeCompare(left.modified)); // newest first — canonical list order
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  return entriesToSessionInfos(await ensureSessionIndex());
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((globalThis.__piSessionListGeneration ?? 0) === generation) {
      globalThis.__piSessionListCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

// Short TTL: the index made list rebuilds cheap, so this cache now only
// coalesces concurrent requests — fresh sessions appear on the next poll/bump
// instead of waiting out a long staleness window.
const SESSION_LIST_CACHE_TTL_MS = 3_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
}

/** 列表版本（invalidation 代数）：会话全文搜索的跨窗口同步用它做轻量轮询比对。 */
export function getSessionListVersion(): number {
  return globalThis.__piSessionListGeneration ?? 0;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: {
    deferThinking?: boolean;
    deferToolResultImages?: boolean;
    /** Return only the last N messages (tail window) — the initial big-session
     *  view. Older messages load on demand via buildEarlierContext. */
    tailMessages?: number;
  } = {},
): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  const contextEntries = piBuildContextEntries(
    piEntries,
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );

  // Collect the requested window from the END backwards — a long session must
  // not materialize every thinking block/tool payload just to show its tail.
  const limit = options.tailMessages && options.tailMessages > 0 ? options.tailMessages : Infinity;
  const window: Array<{ entry: SessionEntry; m: AgentMessage }> = [];
  let hasEarlier = false;
  for (let i = contextEntries.length - 1; i >= 0; i--) {
    const localEntry = contextEntries[i] as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (!m) continue;
    if (window.length >= limit) {
      hasEarlier = true; // found an older mappable entry beyond the window
      break;
    }
    window.push({ entry: localEntry, m });
  }
  window.reverse(); // chronological

  return {
    messages: window.map((x) => x.m),
    entryIds: window.map((x) => x.entry.id),
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
    ...(hasEarlier ? { hasEarlier: true } : {}),
  };
}

/** Build a window of OLDER messages immediately before `beforeEntryId` on the
 *  same branch (leafId). The server-side half of tail-first loading: the client
 *  prepends the result as the user scrolls up. */
export function buildEarlierContext(
  entries: SessionEntry[],
  beforeEntryId: string,
  options: {
    leafId?: string | null;
    deferThinking?: boolean;
    deferToolResultImages?: boolean;
    limit?: number;
  } = {},
): SessionContext | null {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const contextEntries = piBuildContextEntries(
    piEntries,
    options.leafId ?? null,
    byId as unknown as Map<string, PiSessionEntry>,
  );

  const anchorIndex = contextEntries.findIndex((entry) => entry.id === beforeEntryId);
  if (anchorIndex < 0) return null;
  const limit = options.limit && options.limit > 0 ? options.limit : 100;

  // Walk backwards from the anchor, mapping at most `limit` messages.
  const mapped: Array<{ entry: SessionEntry; m: AgentMessage }> = [];
  let hasEarlier = false;
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const localEntry = contextEntries[i] as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (!m) continue;
    if (mapped.length >= limit) {
      hasEarlier = true; // older mappable entries remain beyond this window
      break;
    }
    mapped.push({ entry: localEntry, m });
  }
  // Walked backwards; reverse to chronological order.
  mapped.reverse();
  return {
    messages: mapped.map((x) => x.m),
    entryIds: mapped.map((x) => x.entry.id),
    // thinkingLevel/model are properties of the leaf context, not of an older
    // window — the client ignores them here.
    thinkingLevel: "",
    model: null,
    ...(hasEarlier ? { hasEarlier: true } : {}),
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
// bump 1787327832864408000
// bump 1787353777527299000
