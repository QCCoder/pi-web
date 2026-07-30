export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

export function encodeFilePathForApi(filePath: string): string {
  return normalizeFilePathSlashes(filePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (lastSlash === 2 && /^[a-zA-Z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}

/** Default character budget for {@link abbreviateFilePathParts}. Roughly maps to
 *  the @ autocomplete menu width at the mono font size, leaving room for the
 *  leading icon and padding. */
export const DEFAULT_PATH_ABBREV_MAX = 48;

/**
 * Split a "/"-separated relative path into a display { dir, name } pair where
 * `dir` is middle-abbreviated to fit within `maxLen` characters. The basename
 * (`name`) is always shown in full; the directory prefix keeps its first
 * segment (the strongest disambiguator in multi-repo projects — usually the
 * repo/module name) plus as many trailing segments as the budget allows, with
 * "…" where segments were dropped.
 *
 * Display-only: the full path is still what gets inserted as an @mention.
 *
 * Examples (maxLen = 26):
 *   "app/api/route.ts"                              -> { dir: "app/api/", name: "route.ts" }
 *   "packages/frontend/src/components/Widget.tsx"    -> { dir: "packages/…/", name: "Widget.tsx" }
 *   "tests/unit/config.json" (fits)                  -> { dir: "tests/unit/", name: "config.json" }
 */
export function abbreviateFilePathParts(
  filePath: string,
  maxLen: number = DEFAULT_PATH_ABBREV_MAX,
): { dir: string; name: string } {
  const segments = normalizeFilePathSlashes(filePath).split("/").filter(Boolean);
  const name = segments.length > 0 ? (segments.pop() as string) : filePath;
  const dirs = segments;

  const fullDir = dirs.length > 0 ? `${dirs.join("/")}/` : "";
  if (fullDir.length + name.length <= maxLen) {
    return { dir: fullDir, name };
  }

  // No directory part, or the name alone already meets/exceeds the budget:
  // truncate the name itself with a trailing ellipsis.
  if (dirs.length === 0 || name.length >= maxLen) {
    if (name.length <= maxLen) return { dir: "", name };
    return { dir: "", name: `${name.slice(0, Math.max(1, maxLen - 1))}…` };
  }

  const budget = maxLen - name.length; // chars available for the dir prefix
  const head = dirs[0];
  const minimum = `${head}/…/`; // smallest meaningful abbreviation

  // Greedily fill trailing segments (the immediate parents) while in budget.
  const tail: string[] = [];
  for (let i = dirs.length - 1; i >= 1; i--) {
    const candidate = `${head}/…/${[...tail, dirs[i]].join("/")}/`;
    if (candidate.length <= budget) {
      tail.unshift(dirs[i]);
    } else {
      break;
    }
  }

  let dir: string;
  if (tail.length > 0) {
    dir = `${head}/…/${tail.join("/")}/`;
  } else if (minimum.length <= budget) {
    dir = minimum;
  } else if ("…/".length <= budget) {
    dir = "…/";
  } else {
    dir = "";
  }
  return { dir, name };
}
