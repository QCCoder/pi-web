/**
 * Subagent-child identification for the community @henryqw/pi-subagent package.
 *
 * The package persists child sessions by default with a parent-generated
 * session id `pi-subagent-<uuid>` and session name `pi-subagent <role>`
 * (both opt-out-able via role `persist: false` / config `childSessions: false`).
 * The sessions API tags children by that prefix and the sidebar keeps hiding
 * them exactly as before.
 *
 * Legacy fallback (A3 review F1): sessions created by the RETIRED built-in
 * subagent carry neither prefix — they were recorded in the append-only
 * `~/.pi/agent/subagent-children.txt` registry (writer: the deleted
 * lib/subagent/registry.ts). That file is frozen but still on disk, so the
 * tagging path ALSO consults it (read-only, mtime-cached — the reader half of
 * the old registry's pattern) to keep those old children hidden. An id is a
 * subagent child if (community prefix match) OR (in the legacy file).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Session id prefix the package stamps on every persisted child. */
export const PI_SUBAGENT_CHILD_ID_PREFIX = "pi-subagent-";

/**
 * Session name prefix (`pi-subagent <role>`) set via the child's `--name`.
 * Includes the trailing space: generated names are exactly `pi-subagent <role>`,
 * and a bare `pi-subagent` prefix would false-positive on user-named sessions
 * like "pi-subagentive notes".
 */
export const PI_SUBAGENT_CHILD_NAME_PREFIX = "pi-subagent ";

/** Path of the retired built-in's append-only child registry (read-only here). */
function legacyRegistryPath(): string {
  return join(getAgentDir(), "subagent-children.txt");
}

/** mtime-cached parse per path (production uses exactly one path). */
const legacyCaches = new Map<string, { mtimeMs: number; ids: Set<string> }>();

/**
 * Load child session ids from the legacy `subagent-children.txt` registry.
 * Read-only, mtime-cached, never throws (a corrupt or missing file matches
 * nothing — stale ids for deleted sessions are harmless). Mirrors the read
 * half of the deleted lib/subagent/registry.ts, with the path overridable so
 * tests can point at a fixture instead of the real agent dir.
 */
export function loadLegacySubagentChildIds(registryPath = legacyRegistryPath()): Set<string> {
  try {
    if (!existsSync(registryPath)) return new Set();
    const mtimeMs = statSync(registryPath).mtimeMs;
    const cached = legacyCaches.get(registryPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.ids;
    const ids = new Set(
      readFileSync(registryPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    legacyCaches.set(registryPath, { mtimeMs, ids });
    return ids;
  } catch {
    return legacyCaches.get(registryPath)?.ids ?? new Set();
  }
}

/**
 * True when a session is a persisted subagent child session: a community
 * @henryqw/pi-subagent child (id/name prefix) OR a legacy built-in child
 * recorded in the frozen registry. `legacyIds` defaults to the real registry
 * load; the route passes a hoisted set so a list call stats the file once.
 */
export function isSubagentChildSession(
  session: { id: string; name?: string },
  legacyIds: ReadonlySet<string> = loadLegacySubagentChildIds(),
): boolean {
  return (
    session.id.startsWith(PI_SUBAGENT_CHILD_ID_PREFIX) ||
    (session.name?.startsWith(PI_SUBAGENT_CHILD_NAME_PREFIX) ?? false) ||
    legacyIds.has(session.id)
  );
}
