/**
 * Resolve how to invoke a real `pi` subprocess for a subagent worker.
 *
 * Preferred: run the CLI bundled in the installed `@earendil-works/pi-coding-agent`
 * package via the current Node executable. This works regardless of PATH.
 * Fallback: the `pi` command on PATH (present under `npm run` contexts where
 * `node_modules/.bin` is on PATH).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PI_PKG_PARTS = ["node_modules", "@earendil-works", "pi-coding-agent"];

function findBundledCli(startCwd: string): string | null {
  let dir = resolve(startCwd);
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, ...PI_PKG_PARTS, "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface PiInvocation {
  command: string;
  /** Args to prepend before the actual pi flags. */
  prefix: string[];
}

export function resolvePiInvocation(startCwd: string): PiInvocation {
  const cli = findBundledCli(startCwd);
  if (cli) return { command: process.execPath, prefix: [cli] };
  return { command: "pi", prefix: [] };
}
