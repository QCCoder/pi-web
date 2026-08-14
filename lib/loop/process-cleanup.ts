/**
 * Reap OS processes that a Loop round spawned (via the bash tool) but that
 * survive `session.destroy()`.
 *
 * Why this exists: pi-coding-agent's bash tool spawns each shell
 * `detached: true` (so it becomes its own process-group leader) and tracks the
 * pid in a global set that is ONLY swept when the whole pi process receives a
 * process-level SIGHUP/SIGTERM. The loop host (`bin/pi-loop.js`) is a
 * long-lived process that never exits, and `abortRound` tears a round down with
 * `session.destroy()` — which does NOT fire the in-flight tool's `AbortSignal`.
 * So a round that is aborted or times out while an `npm install` / `mvn` is
 * running leaves that `bash → npm → node` subtree reparented to launchd (PID 1),
 * still holding `node_modules` file handles (which is why `rm -rf` then fails
 * and the orphan sits at ~100% CPU).
 *
 * This module is the loop-side safety net: on abort/timeout it finds the round's
 * orphaned process trees and kills them explicitly. It is scoped to processes
 * whose cwd is inside the run's workspace, so concurrent rounds in *other*
 * workspaces are left alone. (Two concurrent rounds in the *same* workspace can
 * still overlap — acceptable and recoverable; see reapOrphanedRoundProcesses.)
 */
import { spawnSync } from "node:child_process";
import { sep } from "node:path";

const HOST_PID = process.pid;

/** Commands whose processes are worth cwd-checking when scanning for reparented
 *  orphans. This is only a perf pre-filter (to avoid lsof-ing every launchd
 *  daemon); the real safety gate is the workspace-cwd match. */
const BUILD_OR_SHELL = new Set([
  "npm", "npx", "yarn", "pnpm", "node", "mvn", "gradle", "gradlew",
  "java", "javac", "bash", "sh", "zsh", "dash", "make", "python", "python3",
  "pip", "tsc", "esbuild", "webpack", "vite", "rollup", "jest", "vitest",
]);

/** Parse `pgrep -P <pid>` output into a list of child pids. Pure. */
export function parsePgrepChildren(stdout: string): number[] {
  const pids: number[] = [];
  for (const raw of stdout.split("\n")) {
    const token = raw.trim();
    if (token === "" || !/^\d+$/.test(token)) continue; // reject "12x3"-style junk
    pids.push(Number(token));
  }
  return pids;
}

/** Parse `lsof -a -p <pid> -d cwd -Fn` output for the cwd path. Pure. */
export function parseLsofCwd(stdout: string): string | undefined {
  const match = stdout.match(/^n(.+)$/m);
  return match ? match[1] : undefined;
}

export interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Parse `ps -axo pid,ppid,command` output into rows. The header row ("PID
 *  PPID COMMAND") is skipped because its first two fields are non-numeric. Pure. */
export function parsePsRows(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3].trim(),
    });
  }
  return rows;
}

/** True if `cwd` is `workspacePath` or a subdirectory of it (path-boundary
 *  aware, so `/foo/ws` does NOT match `/foo/ws-other`). Pure. */
export function isCwdInWorkspace(cwd: string | undefined, workspacePath: string): boolean {
  if (!cwd) return false;
  return cwd === workspacePath || cwd.startsWith(workspacePath + sep);
}

/** True if the command's first token (basename) is a known build/shell binary.
 *  Pure; used only to narrow the reparented-orphan scan before the lsof cwd
 *  check. */
export function isBuildOrShellCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  if (!first) return false;
  const base = first.split("/").pop()?.toLowerCase();
  return base !== undefined && BUILD_OR_SHELL.has(base);
}

/** Direct child pids of `rootPid` via `pgrep -P`. Returns [] if pgrep is
 *  unavailable (e.g. Windows). */
export function collectDirectChildPids(rootPid: number): number[] {
  try {
    const res = spawnSync("pgrep", ["-P", String(rootPid)], { encoding: "utf8", timeout: 5000 });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    return parsePgrepChildren(res.stdout);
  } catch {
    return [];
  }
}

/** A pid plus all of its descendants (recursive `pgrep -P` walk). The root is
 *  included. Best-effort: returns just `[rootPid]` if pgrep is unavailable. */
export function collectTreePids(rootPid: number): number[] {
  const all = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const child of collectDirectChildPids(parent)) {
      if (!all.has(child)) {
        all.add(child);
        stack.push(child);
      }
    }
  }
  return [...all];
}

/** Best-effort cwd of a pid via `lsof`. Returns undefined if unknown. */
export function pidCwd(pid: number): string | undefined {
  try {
    const res = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (res.error || res.status !== 0 || !res.stdout) return undefined;
    return parseLsofCwd(res.stdout);
  } catch {
    return undefined;
  }
}

/** One `ps -axo pid,ppid,command` snapshot of the whole process table. */
export function listAllProcesses(): PsRow[] {
  try {
    const res = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    return parsePsRows(res.stdout);
  } catch {
    return [];
  }
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
  // Group kill first (bash children are detached → their own PGID == pid), then
  // a direct kill for reparented singletons that are not group leaders.
  try { process.kill(-pid, signal); } catch { /* no such group */ }
  try { process.kill(pid, signal); } catch { /* already dead */ }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ReapResult {
  workspacePath: string;
  /** Every pid that received a signal (target roots + their descendants). */
  killedPids: number[];
  /** The top-level process roots that matched the workspace scope. */
  targetRoots: number[];
}

/**
 * Find and kill process trees orphaned by a Loop round for `workspacePath`:
 *
 * 1. Direct children of *this* loop-host process whose cwd is inside the
 *    workspace (the normal case — the round's `bash -c "npm install …"` is
 *    still a live, detached child of the host when the round is aborted).
 * 2. Any process reparented to launchd (ppid 1) whose command is a build/shell
 *    binary AND whose cwd is inside the workspace (the residual case — a bash
 *    leader that already died but left npm/node behind).
 *
 * Each matched root is expanded to its full subtree, then the whole set is sent
 * SIGTERM and, after `graceMs`, SIGKILL. Never throws — cleanup must not break
 * the abort/timeout flow. Scoped by cwd so other workspaces' concurrent rounds
 * are untouched.
 */
export async function reapOrphanedRoundProcesses(
  workspacePath: string,
  graceMs = 1500,
): Promise<ReapResult> {
  const targetRoots = new Set<number>();

  // (1) live detached children of the loop host, scoped by workspace cwd
  for (const pid of collectDirectChildPids(HOST_PID)) {
    if (isCwdInWorkspace(pidCwd(pid), workspacePath)) targetRoots.add(pid);
  }
  // (2) launchd-reparented build/shell processes, scoped by workspace cwd
  for (const row of listAllProcesses()) {
    if (row.ppid === 1 && row.pid !== HOST_PID && isBuildOrShellCommand(row.command)) {
      if (isCwdInWorkspace(pidCwd(row.pid), workspacePath)) targetRoots.add(row.pid);
    }
  }

  // Expand each root to its full subtree so npm/node grandchildren are included.
  const all = new Set<number>();
  for (const root of targetRoots) for (const pid of collectTreePids(root)) all.add(pid);
  const killedPids = [...all];

  for (const pid of killedPids) tryKill(pid, "SIGTERM");
  if (killedPids.length > 0) await sleep(graceMs);
  for (const pid of killedPids) tryKill(pid, "SIGKILL");

  return { workspacePath, killedPids, targetRoots: [...targetRoots] };
}
