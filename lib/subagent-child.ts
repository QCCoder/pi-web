/**
 * Subagent-child identification for the community @henryqw/pi-subagent package.
 *
 * The package persists child sessions by default with a parent-generated
 * session id `pi-subagent-<uuid>` and session name `pi-subagent <role>`
 * (both opt-out-able via role `persist: false` / config `childSessions: false`).
 * That deterministic prefix replaces the old built-in's append-only
 * `~/.pi/agent/subagent-children.txt` registry (writer: the deleted
 * lib/subagent/registry.ts) — the sessions API tags children by prefix and the
 * sidebar keeps hiding them exactly as before.
 */

/** Session id prefix the package stamps on every persisted child. */
export const PI_SUBAGENT_CHILD_ID_PREFIX = "pi-subagent-";

/** Session name prefix (`pi-subagent <role>`) set via the child's `--name`. */
export const PI_SUBAGENT_CHILD_NAME_PREFIX = "pi-subagent";

/** True when a session is a persisted community-subagent child session. */
export function isSubagentChildSession(session: {
  id: string;
  name?: string;
}): boolean {
  return (
    session.id.startsWith(PI_SUBAGENT_CHILD_ID_PREFIX) ||
    (session.name?.startsWith(PI_SUBAGENT_CHILD_NAME_PREFIX) ?? false)
  );
}
