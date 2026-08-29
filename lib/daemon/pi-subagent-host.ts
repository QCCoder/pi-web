/**
 * Daemon-side host adapter for the community `@henryqw/pi-subagent` package
 * (the `delegate_task` tool — replaces pi-web's former built-in lib/subagent).
 *
 * Two adaptations are needed to run the package inside the session daemon:
 *
 * 1. **Process identity.** The package's ephemeral executor refuses any host
 *    that doesn't look like the pi CLI (`PI_CODING_AGENT=true` + process title
 *    `pi`/`pi-rpc`) and re-invokes "the active pi process" as
 *    `process.execPath process.argv[1]` for every child. The daemon hosts the
 *    SDK in-process, so we present the pi CLI's identity and point `argv[1]`
 *    at pi's bundled CLI entry: each delegation then spawns
 *    `node <pi-cli> --mode json -p …` — a REAL pi process of the exact same
 *    0.84.x version, sharing the user's `~/.pi/agent` settings/auth.
 *
 * 2. **Generous timeouts (A3 criterion ③).** The package KILLS the child on
 *    timeout (idle SIGTERM→SIGKILL, max SIGKILL) — a deliberately different
 *    philosophy from the old built-in, whose inactivity budget never aborted a
 *    quiet build. Quiet builds DO renew the idle deadline while they emit
 *    output (bash partials count as activity), but a totally silent one is
 *    killed at the deadline. We therefore configure idle 30 min / max 120 min
 *    (the old built-in's heartbeat safety net used similar 5/20-min margins
 *    with "kill must outlive the longest normal build" as the rule). Per-role
 *    or global overrides live in `<agentDir>/config/pi-subagent/pi-subagent.json`
 *    (`timeout.idleMinutes`/`maxMinutes`) — this explicit policy wins over
 *    that file when attached here.
 *
 * Role discovery (A3 criterion ①) is the package's own:
 *   - built-in `implementer`/`reviewer`,
 *   - project roles from `<cwd>/.pi/agents/pi-subagent/*.md` (trust-gated;
 *     `.pi/agents` is not a trust-requiring resource for pi's SDK, so plain
 *     workspaces are trusted by default — matching the old no-gate posture
 *     for user-owned `~/.pi/workspaces/**`),
 *   - user roles from `~/.pi/agent/config/pi-subagent/*.md`;
 *   precedence built-in < project < user (same-named file wins upward).
 *
 * Child sessions persist by default with parent-generated
 * `pi-subagent-<uuid>` ids + `pi-subagent <role>` names (opt-out per role
 * `persist: false` or globally `childSessions: false`) — pi-web tags them
 * `subagentChild` by that id/name prefix (app/api/sessions/route.ts) and the
 * result card links to them via `details.entries[].session.id`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** Timeout policy passed as the extension factory's second argument. */
export interface PiSubagentTimeoutPolicy {
  idleMs: number;
  maxMs: number;
}

/** Kill-based timeouts: generous enough for quiet builds (see header comment). */
export const PI_SUBAGENT_TIMEOUT_POLICY: PiSubagentTimeoutPolicy = {
  idleMs: 30 * 60_000,
  maxMs: 120 * 60_000,
};

/** Module path of this file, working under jiti, ESM, and CJS alike. */
function moduleFile(): string {
  return typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
}

/** pi-web repo root (this file lives at <root>/lib/daemon/). */
function repoRoot(): string {
  return dirname(dirname(dirname(moduleFile())));
}

/**
 * Resolve an installed package's root directory. `createRequire().resolve`
 * fails on the import-only `exports` maps both targets publish, and
 * `import.meta.resolve` is unavailable in jiti's CJS transform — so walk the
 * repo's hoisted node_modules first (the daemon always runs from this repo)
 * and fall back to ESM/CJS resolvers for exotic installs.
 */
function resolvePackageDir(name: string): string {
  const hoisted = join(repoRoot(), "node_modules", ...name.split("/"));
  if (existsSync(join(hoisted, "package.json"))) return hoisted;
  try {
    return dirname(dirname(createRequire(moduleFile()).resolve(name)));
  } catch {
    // Neither resolver accepted the specifier — let jiti surface the error
    // when the extension import below uses the path.
    return hoisted;
  }
}

/** Absolute path of the installed package's extension entry (not exported via
 *  the package's `exports` map — resolved from the package root instead). */
export function piSubagentExtensionPath(): string {
  return join(resolvePackageDir("@henryqw/pi-subagent"), "extensions", "subagent.ts");
}

/** pi CLI entry used for child delegations (`node <this> --mode json -p …`). */
export function piCliEntryPath(): string | undefined {
  const candidate = join(
    resolvePackageDir("@earendil-works/pi-coding-agent"),
    "dist",
    "bundle",
    "cli.js",
  );
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Present the pi CLI's process identity so the package's executor accepts the
 * daemon as its host and re-invokes the pi CLI (not bin/pi-daemon.js) for
 * children. Idempotent; runs before the extension factory first executes.
 */
export function preparePiSubagentHost(): void {
  process.env.PI_CODING_AGENT ||= "true";
  if (process.title !== "pi" && process.title !== "pi-rpc") process.title = "pi-rpc";
  const cliEntry = piCliEntryPath();
  if (cliEntry) process.argv[1] = cliEntry;
}

let cachedExtension: Promise<InlineExtension> | undefined;

/**
 * Load the community subagent extension once per daemon process and wrap it
 * with pi-web's timeout policy. Attached to EVERY session by rpc-manager
 * (the `subagent` capability remains global, not workspace-gated).
 */
export function piSubagentExtension(): Promise<InlineExtension> {
  cachedExtension ??= (async () => {
    preparePiSubagentHost();
    const jiti = createJiti(moduleFile());
    const mod = await jiti.import<{
      default: (pi: ExtensionAPI, overrideTimeoutPolicy?: PiSubagentTimeoutPolicy) => void;
    }>(piSubagentExtensionPath());
    if (typeof mod.default !== "function") {
      throw new Error("@henryqw/pi-subagent extension entry has no default factory export");
    }
    const factory = mod.default;
    return {
      name: "pi-subagent",
      factory: (pi: ExtensionAPI) => factory(pi, PI_SUBAGENT_TIMEOUT_POLICY),
    } satisfies InlineExtension;
  })();
  return cachedExtension;
}
