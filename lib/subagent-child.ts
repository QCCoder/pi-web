/**
 * Subagent-child identification for the community @henryqw/pi-subagent package.
 *
 * The package persists child sessions by default with a parent-generated
 * session id `pi-subagent-<uuid>` and session name `pi-subagent <role>`
 * (both opt-out-able via role `persist: false` / config `childSessions: false`).
 * The sessions API tags children by that prefix and the sidebar keeps hiding
 * them. (The retired built-in subagent's frozen `subagent-children.txt`
 * registry — and the old children it listed — was archived away in 2026-09;
 * only the community prefix check remains.)
 */

/** Session id prefix the package stamps on every persisted child. */
export const PI_SUBAGENT_CHILD_ID_PREFIX = "pi-subagent-";

/**
 * Session name prefix (`pi-subagent <role>`) set via the child's `--name`.
 * Includes the trailing space: generated names are exactly `pi-subagent <role>`,
 * and a bare `pi-subagent` prefix would false-positive on user-named sessions
 * like "pi-subagentive notes".
 */
export const PI_SUBAGENT_CHILD_NAME_PREFIX = "pi-subagent ";

/** True when a session is a persisted community subagent child (id/name prefix). */
export function isSubagentChildSession(session: { id: string; name?: string }): boolean {
  return (
    session.id.startsWith(PI_SUBAGENT_CHILD_ID_PREFIX) ||
    (session.name?.startsWith(PI_SUBAGENT_CHILD_NAME_PREFIX) ?? false)
  );
}
