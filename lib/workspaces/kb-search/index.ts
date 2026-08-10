/**
 * Pure-JS full-text search index for OKF knowledge bundles (redesign Slice-6 /
 * decisions 11 "L1 opt-in", 14 "self-healing index", §6.1 "cross-bundle").
 *
 * This module owns the **L1 retrieval** layer for a workspace's knowledge bundles.
 * It deliberately uses **no native dependencies** (no better-sqlite3): each OKF
 * bundle is a directory of Markdown + YAML frontmatter, so we tokenize frontmatter
 * + body and rank matches with **BM25**. The files themselves remain the source of
 * truth; the index is a **rebuildable cache** stored under
 * `<workspacePath>/.pi/cache/kb-index/<repoAlias>.json` (already git-ignored by the
 * workspace `.gitignore`).
 *
 * Self-healing (decision 14): `ensureIndex()` is called before every search. It
 * walks the bundle's `.md` files, compares each file's **mtime** against the cached
 * entry, and re-parses **only** the new/changed files. Unchanged files are reused
 * verbatim ("不搜不花索引成本" — no search, no reindex cost). A missing or corrupt
 * cache file simply triggers a full rebuild.
 *
 * L0 (`read` / `ls` / `grep`) is always built-in and needs no tool — `kb_search` is
 * an **opt-in enhancement**, not a replacement (decisions 11/12).
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { withWorkspaceWriteLock } from "../service.ts";

/** Schema version of the on-disk index cache. Bump on incompatible format changes. */
const KB_INDEX_CACHE_SCHEMA_VERSION = 1 as const;

/** A knowledge bundle to index/search: its alias + absolute filesystem path. */
export interface KnowledgeRepoRef {
  alias: string;
  /** Absolute path to the bundle directory (`repositories/knowledge/<alias>`). */
  path: string;
}

/** Optional frontmatter-based filters applied at search time. */
export interface SearchFilters {
  /** Restrict to notes whose frontmatter `type` matches exactly. */
  type?: string;
  /** Restrict to notes carrying at least one of the given frontmatter `tags`. */
  tags?: string[];
}

export interface SearchOptions {
  /** Max results to return (default 10). Clamped to [1, 50]. */
  limit?: number;
  filters?: SearchFilters;
}

/** One ranked search hit. */
export interface SearchResult {
  repoAlias: string;
  /** POSIX-style path of the note within its bundle (e.g. `concepts/welcome.md`). */
  path: string;
  title: string;
  snippet: string;
  /** BM25 score; higher is more relevant. */
  score: number;
  type?: string;
  tags?: string[];
}

/** On-disk cache entry for a single indexed note. The cache is JSON-serializable. */
interface CachedDoc {
  path: string;
  title: string;
  type?: string;
  tags?: string[];
  mtime: number;
  /** term → raw frequency in this note (frontmatter title/tags + body). */
  termFreq: Record<string, number>;
  /** Body text (frontmatter stripped), kept so snippets can be generated without
   *  re-reading the file. The cache is rebuildable so this storage cost is fine. */
  content: string;
}

interface KbIndexCache {
  schemaVersion: typeof KB_INDEX_CACHE_SCHEMA_VERSION;
  repoAlias: string;
  docs: CachedDoc[];
}

/** In-memory corpus index with BM25 statistics precomputed. */
export interface KbIndex {
  repoAlias: string;
  docs: IndexedDoc[];
  avgDocLength: number;
  /** Per-corpus document frequency: term → number of docs containing it. */
  docFreq: Record<string, number>;
  docCount: number;
}

interface IndexedDoc {
  path: string;
  title: string;
  type?: string;
  tags?: string[];
  mtime: number;
  termFreq: Record<string, number>;
  length: number;
  content: string;
}

/** BM25 free parameters (standard Okapi defaults). */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Tiny English stop-word set, applied only to query tokens to cut ranking noise.
 *  Indexing stays complete (every token is stored) so these never lose matches. */
const QUERY_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on",
  "with", "as", "by", "at", "be", "this", "that", "from",
]);

/**
 * Tokenize text for indexing/searching. Handles both space-delimited scripts
 * (ASCII words/numbers) and CJK (indexed as unigram + bigram for recall). Output is
 * lowercased. Single ASCII characters are dropped (noise); CJK single chars are kept.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // ASCII word/number runs.
  const wordRe = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(lower)) !== null) {
    if (m[0].length >= 2) tokens.push(m[0]);
  }
  // CJK characters (CJK Unified Ideographs + Ext-A + Compatibility Ideographs):
  // index each char plus its adjacent bigram so multi-character terms still match.
  const cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
  const chars: string[] = [];
  while ((m = cjkRe.exec(lower)) !== null) {
    chars.push(m[0]);
  }
  for (let i = 0; i < chars.length; i++) {
    tokens.push(chars[i]);
    if (i + 1 < chars.length) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/** Compute the cache file path for a bundle's index. Exported for testability. */
export function kbIndexCachePath(workspacePath: string, repoAlias: string): string {
  return join(workspacePath, ".pi", "cache", "kb-index", `${repoAlias}.json`);
}

/** Split a Markdown note into its YAML frontmatter (parsed) and body. Frontmatter
 *  parse failures degrade gracefully to an empty object (the note is still indexed
 *  by its body). */
function splitFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    parsed = undefined;
  }
  const frontmatter =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: match[2] ?? "" };
}

function extractTitle(body: string, posixPath: string): string {
  const match = body.match(/^#{1,6}\s+(.+?)\s*$/m);
  if (match) return match[1].trim();
  return basename(posixPath, ".md");
}

/** Build an in-memory {@link IndexedDoc} from raw note text. */
function indexNote(posixPath: string, content: string, mtime: number): IndexedDoc {
  const { frontmatter, body } = splitFrontmatter(content);
  const title = extractTitle(body, posixPath);
  const type = typeof frontmatter.type === "string" ? frontmatter.type : undefined;
  const tagsValue = frontmatter.tags;
  const tags = Array.isArray(tagsValue)
    ? tagsValue.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  // Title + tags + body are all searchable; type is a filter dimension only.
  const tokenSource = [title, ...(tags ?? []), body].join("\n");
  const tokens = tokenize(tokenSource);
  const termFreq: Record<string, number> = {};
  let length = 0;
  for (const token of tokens) {
    termFreq[token] = (termFreq[token] ?? 0) + 1;
    length += 1;
  }
  return { path: posixPath, title, type, tags, mtime, termFreq, length, content: body };
}

/** Recursively collect `.md` files under `dir`, returning POSIX-style relative
 *  paths. Hidden entries (`.git`, etc.) are skipped. */
async function walkMarkdown(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(relative(dir, full).split(sep).join("/"));
    }
  }
  return results;
}

function isCachedDoc(value: unknown): value is CachedDoc {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string"
    && typeof record.mtime === "number"
    && !!record.termFreq
    && typeof record.termFreq === "object"
  );
}

/** Load + validate the cache. Any malformed/missing/corrupt cache returns null,
 *  which causes a full rebuild (decision 14 self-healing). */
async function loadCache(
  cachePath: string,
  repoAlias: string,
): Promise<KbIndexCache | null> {
  let content: string;
  try {
    content = await readFile(cachePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      !parsed
      || typeof parsed !== "object"
      || (parsed as KbIndexCache).schemaVersion !== KB_INDEX_CACHE_SCHEMA_VERSION
      || (parsed as KbIndexCache).repoAlias !== repoAlias
    ) {
      return null;
    }
    const cache = parsed as KbIndexCache;
    if (!Array.isArray(cache.docs)) return null;
    cache.docs = cache.docs.filter(isCachedDoc);
    return cache;
  } catch {
    return null;
  }
}

/** Atomic cache write (tmp file + rename) so a torn write never leaves a
 *  half-written JSON — the worst case is a rebuild next time. The workspace write
 *  lock serializes concurrent index writes for the same workspace. */
async function saveCache(cachePath: string, cache: KbIndexCache): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(cache), "utf8");
  await rename(temporary, cachePath);
}

/** Recompute corpus-wide BM25 statistics (avg doc length + document frequencies)
 *  from a fresh doc list. */
function buildIndex(repoAlias: string, docs: IndexedDoc[]): KbIndex {
  const docFreq: Record<string, number> = {};
  let totalLength = 0;
  for (const doc of docs) {
    for (const term of Object.keys(doc.termFreq)) {
      docFreq[term] = (docFreq[term] ?? 0) + 1;
      totalLength += doc.termFreq[term];
    }
  }
  const avgDocLength = docs.length > 0 ? totalLength / docs.length : 0;
  return { repoAlias, docs, avgDocLength, docFreq, docCount: docs.length };
}

function cachedToIndexed(doc: CachedDoc): IndexedDoc {
  let length = 0;
  for (const term of Object.keys(doc.termFreq)) length += doc.termFreq[term];
  return {
    path: doc.path,
    title: doc.title,
    type: doc.type,
    tags: doc.tags,
    mtime: doc.mtime,
    termFreq: doc.termFreq,
    length,
    content: doc.content,
  };
}

/**
 * Ensure the index for one bundle is up to date, then return it in memory.
 *
 * Walks the bundle's `.md` files and compares each file's mtime to the cached
 * entry: only new/changed files are re-parsed (decision 14). Deleted files
 * (present in cache, absent on disk) are dropped. The result is written back to
 * the cache atomically (under the workspace write lock) only when something
 * actually changed. A missing/corrupt cache triggers a full rebuild.
 *
 * If the bundle directory does not exist, returns an empty index (no throw).
 */
export async function ensureIndex(
  workspacePath: string,
  repo: KnowledgeRepoRef,
): Promise<KbIndex> {
  const cachePath = kbIndexCachePath(workspacePath, repo.alias);
  const cached = await loadCache(cachePath, repo.alias);
  const cachedByPath = new Map<string, CachedDoc>((cached?.docs ?? []).map((doc) => [doc.path, doc]));

  const files = await walkMarkdown(repo.path);
  const filePathSet = new Set(files);
  const next: CachedDoc[] = [];
  let changed = false;

  for (const posixPath of files) {
    const absolute = join(repo.path, ...posixPath.split("/"));
    let mtime: number;
    try {
      mtime = (await stat(absolute)).mtimeMs;
    } catch {
      continue; // raced away; will be picked up next pass
    }
    const existing = cachedByPath.get(posixPath);
    if (existing && existing.mtime === mtime) {
      next.push(existing); // unchanged — reuse cache entry, skip re-parse
      continue;
    }
    changed = true;
    const content = await readFile(absolute, "utf8");
    const indexed = indexNote(posixPath, content, mtime);
    next.push({
      path: indexed.path,
      title: indexed.title,
      type: indexed.type,
      tags: indexed.tags,
      mtime: indexed.mtime,
      termFreq: indexed.termFreq,
      content: indexed.content,
    });
  }

  // Detect deletions: cached paths no longer on disk.
  for (const cachedPath of cachedByPath.keys()) {
    if (!filePathSet.has(cachedPath)) changed = true;
  }

  if (changed) {
    const cache: KbIndexCache = {
      schemaVersion: KB_INDEX_CACHE_SCHEMA_VERSION,
      repoAlias: repo.alias,
      docs: next,
    };
    await withWorkspaceWriteLock(workspacePath, () => saveCache(cachePath, cache));
  }

  return buildIndex(repo.alias, next.map(cachedToIndexed));
}

/** Build a short context snippet around the first query-term occurrence; falls back
 *  to the start of the body when no term is found (e.g. title-only matches). */
function makeSnippet(content: string, queryTerms: string[], maxLen = 200): string {
  if (!content) return "";
  const lower = content.toLowerCase();
  let pos = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (pos < 0 || idx < pos)) pos = idx;
  }
  const start = pos < 0 ? 0 : Math.max(0, pos - Math.floor(maxLen / 3));
  const end = start + maxLen;
  const slice = content.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + slice + suffix;
}

function docMatchesFilters(doc: IndexedDoc, filters: SearchFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.type !== undefined && doc.type !== filters.type) return false;
  if (filters.tags && filters.tags.length > 0) {
    if (!doc.tags || !doc.tags.some((tag) => filters.tags!.includes(tag))) return false;
  }
  return true;
}

/**
 * Rank `query` against one or more in-memory indexes using BM25 and return the top
 * hits merged across all bundles (redesign §6.1: cross-bundle search). Each index
 * carries its own corpus statistics (avgdl / doc frequency / N), so BM25 scores are
 * computed per-bundle then globally merge-sorted — a bundle is a distinct corpus.
 *
 * Stop words in the query are dropped; if the whole query reduces to nothing, no
 * results are returned (the caller should suggest L0 `grep`).
 */
export function searchIndex(
  query: string,
  indexes: readonly KbIndex[],
  options?: SearchOptions,
): SearchResult[] {
  const rawTerms = tokenize(query);
  const queryTerms = rawTerms.filter((term) => !QUERY_STOP_WORDS.has(term));
  if (queryTerms.length === 0) return [];

  const requestedLimit = options?.limit ?? 10;
  const limit = Math.min(50, Math.max(1, requestedLimit));
  const filters = options?.filters;
  const results: SearchResult[] = [];

  for (const index of indexes) {
    if (index.docCount === 0) continue;
    const avgdl = index.avgDocLength > 0 ? index.avgDocLength : 1;
    for (const doc of index.docs) {
      if (!docMatchesFilters(doc, filters)) continue;
      let score = 0;
      const denomLength = doc.length > 0 ? doc.length : 1;
      for (const term of queryTerms) {
        const tf = doc.termFreq[term] ?? 0;
        if (!tf) continue;
        const df = index.docFreq[term] ?? 0;
        // Okapi BM25 idf (with +1 inside log to stay non-negative).
        const idf = Math.log((index.docCount - df + 0.5) / (df + 0.5) + 1);
        score +=
          (idf * (tf * (BM25_K1 + 1)))
          / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (denomLength / avgdl)));
      }
      if (score > 0) {
        results.push({
          repoAlias: index.repoAlias,
          path: doc.path,
          title: doc.title,
          snippet: makeSnippet(doc.content, queryTerms),
          score,
          ...(doc.type ? { type: doc.type } : {}),
          ...(doc.tags && doc.tags.length > 0 ? { tags: doc.tags } : {}),
        });
      }
    }
  }

  results.sort((left, right) => right.score - left.score);
  return results.slice(0, limit);
}
