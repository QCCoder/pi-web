import { joinFilePath, normalizeFilePathSlashes } from "./file-paths.ts";
import type { AgentMessage } from "./types";

/**
 * "Files changed in this session" — a pure derivation from the session message
 * stream (no git involvement, no backend). The data source is tool calls:
 * every `write` / `edit` (and edit-tool-name variants) in THIS session's
 * stream. Subagent children no longer contribute: the community
 * @henryqw/pi-subagent package runs children as separate pi processes whose
 * file operations never appear in the parent stream (only capped summaries
 * do) — their own session files list them instead. bash-touched files
 * (`cat >`, `sed -i`, `git commit`, …) are deliberately NOT counted — the
 * detection would be regex guesswork, and commit doesn't change content.
 *
 * Semantics (agreed with user): "files this session has touched", NOT "current
 * uncommitted changes" — the list survives commits and branch switches, unlike
 * the git Changes panel.
 */

export interface ChangedFileEntry {
  /** Absolute path as recorded in the tool-call arguments. */
  filePath: string;
  /** Kind of the most recent touch. */
  kind: "write" | "edit";
  /** How many write/edit occurrences touched this file. */
  count: number;
}

/** Matches pi's edit tool plus common variants (edit_*, *.edit, str_replace, …).
 *  Consolidated here from MessageView.tsx so UI and derivation agree. */
export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

function isWriteToolName(toolName: string): boolean {
  return toolName.toLowerCase() === "write";
}

function isAbsoluteLikePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Tool-call `file_path` args are frequently RELATIVE to the session cwd (pi's
 *  edit/write accept both). Resolve against cwd so entries are absolute —
 *  openFile → /api/files needs an absolute path under an allowed root, and
 *  dedup must collapse `lib/a.ts` with `/abs/cwd/lib/a.ts`. Collapses `.`/`..`
 *  segments like file-links.ts does. */
function resolveToolPath(raw: string, cwd?: string): string {
  const joined = !cwd || isAbsoluteLikePath(raw) ? raw : joinFilePath(cwd, raw);
  const normalized = normalizeFilePathSlashes(joined);
  const leadingSlash = normalized.startsWith("/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      else if (!leadingSlash) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return (leadingSlash ? "/" : "") + parts.join("/");
}

/** Extract the file path from a tool-call argument bag, tolerating the
 *  file_path / filePath / path key spellings. Returns null when absent or
 *  not a string (nothing to record — not an error). */
function extractFilePath(args: Record<string, unknown> | undefined | null): string | null {
  if (!args) return null;
  const v = args.file_path ?? args.filePath ?? args.path;
  return typeof v === "string" && v.length > 0 ? v : null;
}

interface Accumulator {
  filePath: string;
  kind: "write" | "edit";
  count: number;
  /** Monotonic sequence of the last touch — higher = more recent. */
  lastIndex: number;
}

function record(map: Map<string, Accumulator>, seq: number, filePath: string, kind: "write" | "edit"): void {
  const existing = map.get(filePath);
  if (existing) {
    existing.count += 1;
    existing.lastIndex = seq;
    existing.kind = kind;
  } else {
    map.set(filePath, { filePath, kind, count: 1, lastIndex: seq });
  }
}

/** Walk one message's assistant toolCall blocks, recording write/edit calls. */
/** Shared per-derivation context: the accumulation map, the monotonic touch
 *  sequence, and the session cwd used to resolve relative tool-call paths. */
interface Ctx {
  map: Map<string, Accumulator>;
  seq: { n: number };
  cwd?: string;
}

function collectFromAssistantMessage(ctx: Ctx, message: AgentMessage): void {
  if (message.role !== "assistant") return;
  for (const block of message.content ?? []) {
    if (block.type !== "toolCall") continue;
    if (isWriteToolName(block.toolName)) {
      const p = extractFilePath(block.input);
      if (p) record(ctx.map, ctx.seq.n++, resolveToolPath(p, ctx.cwd), "write");
    } else if (isEditToolName(block.toolName)) {
      const p = extractFilePath(block.input);
      if (p) record(ctx.map, ctx.seq.n++, resolveToolPath(p, ctx.cwd), "edit");
    }
  }
}

/** Best-effort walk of a tool result's nested details was REMOVED with the
 *  built-in subagent (the community package's children are separate processes —
 *  see the module header). */

export interface DeriveSessionChangedFilesOptions {
  /** The currently-streaming assistant message (partial) — its toolCall blocks
   *  count immediately (file_path is known at call time, decision: real-time). */
  streamingMessage?: Partial<AgentMessage> | null;
  /** Session cwd — tool-call `file_path` args are often relative to it; entries
   *  are resolved to absolute paths so openFile → /api/files passes the
   *  allow-list (a bare relative path is rejected as "Access denied"). */
  cwd?: string;
}

/**
 * Derive the deduplicated, most-recent-first list of files written/edited in
 * this session. Pure: same input → same output; no I/O.
 */
export function deriveSessionChangedFiles(
  messages: readonly AgentMessage[],
  options?: DeriveSessionChangedFilesOptions,
): ChangedFileEntry[] {
  const map = new Map<string, Accumulator>();
  const seq = { n: 0 };
  const ctx: Ctx = { map, seq, cwd: options?.cwd };

  for (const message of messages) {
    collectFromAssistantMessage(ctx, message);
  }

  const streaming = options?.streamingMessage;
  if (streaming && streaming.role === "assistant") {
    collectFromAssistantMessage(ctx, streaming as AgentMessage);
  }

  return Array.from(map.values())
    .sort((a, b) => b.lastIndex - a.lastIndex || (a.filePath < b.filePath ? -1 : 1))
    .map(({ filePath, kind, count }) => ({ filePath, kind, count }));
}
