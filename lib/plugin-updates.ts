import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PluginScope, PluginUpdateResult } from "@/lib/api-types";
import { getProjectTrustStatus } from "./project-trust";

// Version comparison is a small in-file subset of `semver` (valid / validRange /
// gt / maxSatisfying / rcompare — the only functions the upstream
// implementation used). The repo does not take new runtime dependencies, so the
// needed semantics are implemented here and pinned by plugin-updates.test.mjs.
// Only the syntax npm plugin specs actually use is supported: exact versions,
// ^ / ~ ranges, x-ranges (1, 1.2, 1.x), comparator lists (>= < space-joined),
// hyphen ranges and `||` alternatives; `latest` / `*` are not ranges.

const execFileAsync = promisify(execFile);

type ConfiguredPackage = {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;

type CheckOptions = {
  packages?: ConfiguredPackage[];
  npmCommand?: string[];
  runCommand?: CommandRunner;
};

type ParsedNpmSource = {
  name: string;
  spec: string;
  version?: string;
};

// ── minimal semver subset ─────────────────────────────────────────────────────

const VERSION_PATTERN
  = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+)?$/;

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const delta = Number(a) - Number(b);
    return delta < 0 ? -1 : delta > 0 ? 1 : 0;
  }
  if (aNumeric) return -1; // numeric identifiers sort before alphanumeric
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareVersions(aValue: string, bValue: string): number {
  const a = parseVersion(aValue);
  const b = parseVersion(bValue);
  if (!a || !b) return Number.NaN;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1; // release > prerelease
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1; // fewer identifiers sort lower
    if (bPart === undefined) return 1;
    const delta = comparePrereleaseIdentifiers(aPart, bPart);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Returns the trimmed value when it is a full valid version, else null. */
function validVersion(value: string): string | null {
  return parseVersion(value) ? value.trim() : null;
}

type RangeComparator = { op: ">=" | "<"; version: ParsedVersion };

type XRangeParts = [number | undefined, number | undefined, number | undefined];

function xRangeBound(parts: XRangeParts, upper: boolean): ParsedVersion {
  const [major, minor, patch] = parts;
  if (upper) {
    if (major === undefined) return { major: Number.MAX_SAFE_INTEGER, minor: 0, patch: 0, prerelease: [] };
    if (minor === undefined) return { major: major + 1, minor: 0, patch: 0, prerelease: [] };
    if (patch === undefined) return { major, minor: minor + 1, patch: 0, prerelease: [] };
    return { major, minor, patch: patch + 1, prerelease: [] };
  }
  return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0, prerelease: [] };
}

function parseXRangeParts(value: string): XRangeParts | null {
  const cleaned = value.trim().replace(/^v/, "");
  if (cleaned === "*" || cleaned === "x" || cleaned === "X" || cleaned === "") return [undefined, undefined, undefined];
  const segments = cleaned.split(".");
  if (segments.length > 3) return null;
  const parts: number[] = [];
  for (const segment of segments) {
    if (segment === "x" || segment === "X" || segment === "*") break;
    if (!/^\d+$/.test(segment)) return null; // ranges with prerelease tags are outside this subset
    parts.push(Number(segment));
  }
  return [parts[0], parts[1], parts[2]];
}

/** Desugars one comparator token (or hyphen range) into >= / < pairs. */
function parseComparatorToken(token: string): RangeComparator[] | null {
  const hyphen = token.match(/^(.+?)\s+-\s+(.+)$/); // "1.2.3 - 2.3.4" style
  if (hyphen) {
    const low = parseVersion(hyphen[1]);
    if (!low) return null;
    const highParts = parseXRangeParts(hyphen[2]);
    if (!highParts) return null;
    return [
      { op: ">=", version: low },
      { op: "<", version: xRangeBound(highParts, true) },
    ];
  }
  const match = token.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
  if (!match) return null;
  const op = match[1] ?? "";
  const raw = match[2].trim();
  if (op === "^" || op === "~") {
    const parts = parseXRangeParts(raw);
    if (!parts) return null;
    const [major, minor, patch] = parts;
    if (major === undefined) return null;
    let upper: ParsedVersion;
    if (op === "^") {
      upper = major > 0 || minor === undefined
        ? { major: major + 1, minor: 0, patch: 0, prerelease: [] }
        : minor > 0 || patch === undefined
          ? { major, minor: minor + 1, patch: 0, prerelease: [] }
          : { major, minor, patch: patch + 1, prerelease: [] };
    } else {
      upper = minor === undefined
        ? { major: major + 1, minor: 0, patch: 0, prerelease: [] }
        : { major, minor: minor + 1, patch: 0, prerelease: [] };
    }
    return [
      { op: ">=", version: xRangeBound(parts, false) },
      { op: "<", version: upper },
    ];
  }
  if (raw === "*" || raw === "x" || raw === "X" || raw === "") {
    return [];
  }
  const parts = parseXRangeParts(raw);
  if (!parts) return null;
  const [major, minor, patch] = parts;
  if (major !== undefined && minor !== undefined && patch !== undefined) {
    const exact = parseVersion(raw);
    if (!exact) return null;
    if (op === ">") return [{ op: ">=", version: { major, minor, patch: patch + 1, prerelease: [] } }];
    if (op === "<") return [{ op: "<", version: exact }];
    if (op === "<=") return [{ op: "<", version: { major, minor, patch: patch + 1, prerelease: [] } }];
    if (op === ">=") return [{ op: ">=", version: exact }];
    return [
      { op: ">=", version: exact },
      { op: "<", version: { major, minor, patch: patch + 1, prerelease: [] } },
    ];
  }
  // x-range (possibly partial): >= lower bound, < next boundary
  return [
    ...(op === ">=" ? [{ op: ">=" as const, version: xRangeBound(parts, false) }] : []),
    ...(op === ">" ? [{ op: ">=" as const, version: xRangeBound(parts, true) }] : []),
    ...(op === "<" ? [{ op: "<" as const, version: xRangeBound(parts, false) }] : []),
    ...(op === "<=" ? [{ op: "<" as const, version: xRangeBound(parts, true) }] : []),
    ...(op === "" || op === "=" ? [
      { op: ">=" as const, version: xRangeBound(parts, false) },
      { op: "<" as const, version: xRangeBound(parts, true) },
    ] : []),
  ];
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  return comparePrereleaseArrays(a.prerelease, b.prerelease);
}

function comparePrereleaseArrays(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a[index];
    const bPart = b[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const delta = comparePrereleaseIdentifiers(aPart, bPart);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Joins operators with their operand ("^ 1.2" -> "^1.2") so whitespace
 *  tokenization cannot split them apart. */
function normalizeRange(range: string): string {
  return range.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
}

function tokenizeRangeSet(set: string): string[] {
  return normalizeRange(set).trim().split(/\s+/).filter(Boolean);
}

/** Returns the trimmed range when it parses, else null (like semver.validRange). */
function validRange(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return trimmed;
  for (const set of trimmed.split("||")) {
    const tokens = tokenizeRangeSet(set);
    if (tokens.length === 0) continue;
    let ok = true;
    for (let index = 0; index < tokens.length; index += 1) {
      const merged = tokens[index + 1] === "-"
        ? `${tokens[index]} - ${tokens[index + 2] ?? ""}`
        : undefined;
      if (merged !== undefined) {
        index += 2;
        if (parseComparatorToken(merged) === null) ok = false;
        continue;
      }
      if (tokens[index] === "-") {
        ok = false;
        continue;
      }
      if (parseComparatorToken(tokens[index]) === null) ok = false;
    }
    if (ok) return trimmed;
  }
  return null;
}

function satisfiesRange(value: string, range: string): boolean {
  const parsed = parseVersion(value);
  if (!parsed) return false;
  for (const set of range.split("||")) {
    const tokens = tokenizeRangeSet(set);
    const comparators: RangeComparator[] = [];
    let valid = true;
    for (let index = 0; index < tokens.length; index += 1) {
      const merged = tokens[index + 1] === "-"
        ? `${tokens[index]} - ${tokens[index + 2] ?? ""}`
        : undefined;
      if (merged !== undefined) {
        index += 2;
        const parsedToken = parseComparatorToken(merged);
        if (parsedToken === null) valid = false;
        else comparators.push(...parsedToken);
        continue;
      }
      if (tokens[index] === "-") {
        valid = false;
        continue;
      }
      const parsedToken = parseComparatorToken(tokens[index]);
      if (parsedToken === null) valid = false;
      else comparators.push(...parsedToken);
    }
    if (!valid) continue;
    // npm semantics: prerelease versions only satisfy ranges that opt into
    // prerelease identifiers — this subset has none, so they never match.
    if (parsed.prerelease.length > 0) continue;
    let matches = true;
    for (const { op, version: bound } of comparators) {
      const delta = compareParsed(parsed, bound);
      if (op === ">=" ? delta < 0 : delta >= 0) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/** Highest version satisfying the range, or null (like semver.maxSatisfying). */
function maxSatisfyingVersion(versions: string[], range: string): string | null {
  let best: string | null = null;
  for (const candidate of versions) {
    if (!satisfiesRange(candidate, range)) continue;
    if (best === null || compareVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}

/** Descending-order comparator (like semver.rcompare); NaN sorts last. */
function rcompareVersions(a: string, b: string): number {
  const delta = compareVersions(b, a);
  return Number.isNaN(delta) ? (parseVersion(a) ? -1 : 1) : delta;
}

/** Strictly greater (like semver.gt). */
function greaterThan(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}

// ── plugin update checking ────────────────────────────────────────────────────

function toPluginScope(scope: ConfiguredPackage["scope"]): PluginScope {
  return scope === "project" ? "project" : "global";
}

function parseNpmSource(source: string): ParsedNpmSource | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return {
    name: match?.[1] ?? spec,
    spec,
    version: match?.[2],
  };
}

function hasGitRef(source: string): boolean {
  const value = source.startsWith("git:") ? source.slice(4).trim() : source.trim();
  const scpPath = value.match(/^git@[^:]+:(.+)$/)?.[1];
  if (scpPath) return scpPath.includes("@");
  if (value.includes("://")) {
    try {
      return new URL(value).pathname.replace(/^\/+/, "").includes("@");
    } catch {
      return false;
    }
  }
  const slash = value.indexOf("/");
  return slash >= 0 && value.slice(slash + 1).includes("@");
}

export function isPluginSourceCheckable(source: string): boolean {
  const npm = parseNpmSource(source);
  if (npm) return validVersion(npm.version ?? "") === null;
  if (source.startsWith("git:") || /^(https?|ssh|git):\/\//i.test(source)) {
    return !hasGitRef(source);
  }
  return false;
}

function result(
  pkg: ConfiguredPackage,
  state: PluginUpdateResult["state"],
  message?: string,
): PluginUpdateResult {
  const npm = parseNpmSource(pkg.source);
  return {
    source: pkg.source,
    scope: toPluginScope(pkg.scope),
    displayName: npm?.name ?? pkg.source,
    type: npm ? "npm" : "git",
    state,
    message,
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return stdout;
}

function readInstalledVersion(installedPath: string): string {
  const parsed = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || !validVersion(parsed.version)) {
    throw new Error("Installed package version is unavailable.");
  }
  return parsed.version;
}

function readLatestVersion(stdout: string, range?: string): string {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (typeof parsed === "string" && validVersion(parsed)) return parsed;
  if (Array.isArray(parsed)) {
    const versions = parsed.filter((value): value is string => typeof value === "string" && validVersion(value) !== null);
    const latest = range ? maxSatisfyingVersion(versions, range) : versions.sort(rcompareVersions)[0];
    if (latest) return latest;
  }
  throw new Error("Unexpected response from npm view.");
}

async function checkNpmPackage(
  pkg: ConfiguredPackage,
  cwd: string,
  npmCommand: string[] | undefined,
  runner: CommandRunner,
): Promise<PluginUpdateResult> {
  if (!pkg.installedPath || !existsSync(pkg.installedPath)) {
    return result(pkg, "error", "Package is not installed.");
  }
  const npm = parseNpmSource(pkg.source);
  if (!npm) return result(pkg, "unsupported");
  const [command = "npm", ...commandArgs] = npmCommand ?? [];
  if (!command) return result(pkg, "error", "Invalid npmCommand.");
  const current = readInstalledVersion(pkg.installedPath);
  const stdout = await runner(
    command,
    [...commandArgs, "view", npm.spec, "version", "--json"],
    { cwd },
  );
  const range = npm.version ? validRange(npm.version) ?? undefined : undefined;
  const latest = readLatestVersion(stdout, range);
  return result(pkg, greaterThan(latest, current) ? "update-available" : "up-to-date");
}

async function checkGitPackage(
  pkg: ConfiguredPackage,
  runner: CommandRunner,
): Promise<PluginUpdateResult> {
  if (!pkg.installedPath || !existsSync(pkg.installedPath)) {
    return result(pkg, "error", "Package is not installed.");
  }
  const options = {
    cwd: pkg.installedPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
  const local = (await runner("git", ["rev-parse", "HEAD"], options)).trim();
  const upstream = await runner("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], options)
    .then((value) => value.trim())
    .catch(() => "");
  const ref = upstream.startsWith("origin/")
    ? `refs/heads/${upstream.slice("origin/".length)}`
    : "HEAD";
  const remoteOutput = await runner("git", ["ls-remote", "origin", ref], options);
  const remote = remoteOutput.match(/^([0-9a-f]{40,64})\s+/m)?.[1];
  if (!remote) throw new Error(`Failed to determine remote ${ref}.`);
  return result(pkg, local === remote ? "up-to-date" : "update-available");
}

function isOffline(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
}

export async function checkPluginUpdates(
  cwd: string,
  filter?: { source?: string; scope?: PluginScope },
  options: CheckOptions = {},
): Promise<PluginUpdateResult[]> {
  let packages = options.packages;
  let npmCommand = options.npmCommand;
  if (!packages) {
    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(cwd, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: projectTrust.trusted,
    });
    packages = new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages();
    npmCommand ??= settingsManager.getNpmCommand();
  }

  const selected = packages.filter((pkg) => {
    if (!filter?.source) return true;
    return pkg.source === filter.source && toPluginScope(pkg.scope) === filter.scope;
  });
  const runner = options.runCommand ?? runCommand;

  return Promise.all(selected.map(async (pkg) => {
    if (!isPluginSourceCheckable(pkg.source)) {
      return result(pkg, "unsupported", "Pinned or local packages cannot be checked automatically.");
    }
    if (isOffline()) {
      return result(pkg, "error", "Update checks are disabled while PI_OFFLINE=1.");
    }
    try {
      return parseNpmSource(pkg.source)
        ? await checkNpmPackage(pkg, cwd, npmCommand, runner)
        : await checkGitPackage(pkg, runner);
    } catch (error) {
      return result(pkg, "error", error instanceof Error ? error.message : String(error));
    }
  }));
}
