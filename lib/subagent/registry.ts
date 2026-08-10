/**
 * Append-only registry of subagent worker session ids.
 *
 * Subagent children are real persisted sessions (so they can be opened and
 * streamed live from the parent's result card), but they should NOT clutter
 * the sidebar session list. We record each child id here at creation time;
 * the sessions API tags matching sessions with `subagentChild: true`, which
 * the sidebar filters out of the visible tree.
 *
 * Design notes:
 *   - Append-only (`appendFileSync`) so parallel subagent workers never lose
 *     ids to a read-modify-write race.
 *   - Cross-process safe: the loop host creates children in its own process,
 *     so the reader re-reads the file on mtime change instead of trusting an
 *     in-memory cache.
 *   - Stale ids (deleted sessions) are harmless: they simply match nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const REGISTRY_PATH = join(getAgentDir(), "subagent-children.txt");

let cachedIds: Set<string> | null = null;
let cachedMtime = -1;

/** Load the set of known subagent child session ids (mtime-cached). */
export function loadSubagentChildIds(): Set<string> {
  try {
    if (!existsSync(REGISTRY_PATH)) return new Set();
    const mtime = statSync(REGISTRY_PATH).mtimeMs;
    if (cachedIds && mtime === cachedMtime) return cachedIds;
    const ids = new Set(
      readFileSync(REGISTRY_PATH, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    cachedIds = ids;
    cachedMtime = mtime;
    return ids;
  } catch {
    return cachedIds ?? new Set();
  }
}

/** Record a subagent child id so the session list hides it. */
export function markSubagentChild(id: string): void {
  if (!id) return;
  try {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    appendFileSync(REGISTRY_PATH, `${id}\n`, "utf8");
    cachedIds = null; // mtime will change on next load
  } catch (error) {
    console.error("[pi-web] failed to mark subagent child:", error);
  }
}
