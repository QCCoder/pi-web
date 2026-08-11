import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { parse } from "yaml";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/pi-cwd-* directories created by the default-cwd endpoint.
  try {
    for (const name of readdirSync(homedir())) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  // Workspace-owned directories (repositories/* and knowledge/*, work-items, loops)
  // are owned by the workspace, so they are inherently readable via /api/files.
  // We read the global workspace index — the single source of truth for every
  // workspace path (including imported workspaces at arbitrary locations) — so
  // this is self-sufficient: it does not depend on the in-memory allowFileRoot()
  // set (lost on restart) nor on GET /api/workspaces having been called first.
  addWorkspaceIndexRoots(roots);

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

/**
 * Add every workspace path listed in the global workspace index to `roots`.
 *
 * The index path is resolved inline (mirroring lib/workspaces/service.ts'
 * getWorkspaceIndexPath) rather than importing the service module, to keep the
 * file-access import graph light. Missing/unreadable/unparseable index is
 * silently skipped — this path is purely additive on top of the session and
 * additional roots already collected.
 */
function addWorkspaceIndexRoots(roots: Set<string>): void {
  const indexPath =
    process.env.PI_WORKSPACE_INDEX_FILE?.trim() || path.join(homedir(), ".pi", "workspace.yaml");
  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch {
    return; // index missing or unreadable — skip
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return; // malformed YAML — skip
  }
  if (!parsed || typeof parsed !== "object") return;
  const workspaces = (parsed as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(workspaces)) return;
  for (const entry of workspaces) {
    if (!entry || typeof entry !== "object") continue;
    const wsPath = (entry as { path?: unknown }).path;
    if (typeof wsPath === "string" && wsPath.trim()) {
      roots.add(normalizeSlashes(wsPath));
    }
  }
}

export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}
