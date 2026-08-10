/**
 * `kb_search` pi extension — the **L1 retrieval** tool for OKF knowledge bundles
 * (redesign Slice-6 / decisions 11, 14, §6.1).
 *
 * Mounted by `buildWorkspaceExtensions` only when the workspace's `knowledge`
 * capability is on (opt-in). It searches across **all active knowledge bundles** of
 * the workspace: before each call it self-heals each bundle's FTS index (pure-JS
 * BM25, see `index.ts`) and then ranks the merged hits.
 *
 * `kb_search` coexists with **L0** (always built-in `read`/`ls`/`grep`): it is an
 * enhancement, not a replacement. If indexing fails for a bundle (or all of them)
 * the tool degrades gracefully and tells the agent to fall back to L0.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  effectiveCapabilities,
  readWorkspaceManifest,
  workspaceRepositoryPath,
} from "../service.ts";
import type { WorkspaceRepository } from "../types.ts";
import {
  ensureIndex,
  searchIndex,
  type KnowledgeRepoRef,
  type SearchFilters,
} from "./index.ts";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve the workspace's currently-active knowledge bundles as index targets.
 *  Re-reads the manifest on each call so bundles added/removed during the session
 *  are reflected without a restart. */
async function resolveActiveKnowledgeRepos(
  workspacePath: string,
): Promise<KnowledgeRepoRef[]> {
  let manifest;
  try {
    manifest = await readWorkspaceManifest(workspacePath);
  } catch {
    return [];
  }
  if (!effectiveCapabilities(manifest).includes("knowledge")) return [];
  return manifest.repositories
    .filter(isActiveKnowledgeRepo)
    .map((repository) => ({
      alias: repository.alias,
      path: workspaceRepositoryPath(workspacePath, repository).absolutePath,
    }));
}

function isActiveKnowledgeRepo(repository: WorkspaceRepository): boolean {
  return repository.kind === "knowledge" && repository.status === "active";
}

function coerceFilters(raw: unknown): SearchFilters | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const typeValue = typeof record.type === "string" ? record.type : undefined;
  const tagsValue = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  const filters: SearchFilters = {};
  if (typeValue) filters.type = typeValue;
  if (tagsValue && tagsValue.length > 0) filters.tags = tagsValue;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

/**
 * Build the `kb_search` InlineExtension for a workspace.
 *
 * @param workspaceId   Workspace id (carried for diagnostics/identity).
 * @param workspacePath Absolute path to the workspace root (cache lives under
 *                      `<workspacePath>/.pi/cache/kb-index/`).
 * @param knowledgeRepos Snapshot of active knowledge bundles at mount time (the
 *                      tool re-resolves the live set on each call, so this is the
 *                      initial/default set only).
 */
export function createKbSearchExtension(
  workspaceId: string,
  workspacePath: string,
  knowledgeRepos: readonly KnowledgeRepoRef[],
): InlineExtension {
  return {
    name: "pi-kb-search",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "kb_search",
        label: "Search Knowledge Bundles",
        description:
          "Ranked full-text search across all active OKF knowledge bundles of this workspace (BM25). Returns the most relevant notes with a snippet and the bundle they came from. L0 access (read/ls/grep over repositories/knowledge/*) is always available without this tool — use kb_search when you need ranked relevance or to find notes across large bundles.",
        promptSnippet: "Ranked full-text search across knowledge bundles",
        promptGuidelines: [
          "Use kb_search for ranked retrieval across knowledge bundles; use read/grep/ls (L0) to open or enumerate notes.",
          "Pass filters.type or filters.tags to narrow to a structural role or tag (OKF frontmatter).",
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Free-text query. Matched against note title, frontmatter tags, and body.",
          }),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 50,
              description: "Maximum results to return (default 10).",
            }),
          ),
          filters: Type.Optional(
            Type.Object({
              type: Type.Optional(
                Type.String({
                  description:
                    "Restrict to notes whose frontmatter `type` matches exactly (e.g. concept, index, log).",
                }),
              ),
              tags: Type.Optional(
                Type.Array(Type.String(), {
                  description: "Restrict to notes carrying at least one of these frontmatter tags.",
                }),
              ),
            }),
          ),
        }),
        execute: async (_callId, params) => {
          const repos = await resolveActiveKnowledgeRepos(workspacePath);
          if (repos.length === 0) {
            return textResult({
              results: [],
              hint:
                `No active knowledge bundles found for this workspace. Initialize or clone one under the 知识库 view.`
                + (knowledgeRepos.length > 0
                  ? ` (At mount time ${knowledgeRepos.length} bundle(s) existed; they may have been removed.)`
                  : ""),
            });
          }

          const indexes = [];
          const indexErrors: Array<{ repo: string; error: string }> = [];
          for (const repo of repos) {
            try {
              indexes.push(await ensureIndex(workspacePath, repo));
            } catch (error) {
              // Index failure never blocks the overall search (decision 14): we
              // skip the failing bundle and, if nothing indexed, point to L0.
              indexErrors.push({ repo: repo.alias, error: errorMessage(error) });
            }
          }

          if (indexes.length === 0) {
            return textResult({
              results: [],
              errors: indexErrors,
              hint:
                "Indexing failed for every knowledge bundle. Fall back to L0: use `grep` / `read` / `ls` directly under repositories/knowledge/<alias>/.",
            });
          }

          const filters = coerceFilters(params.filters);
          const results = searchIndex(params.query as string, indexes, {
            ...(params.limit !== undefined ? { limit: params.limit as number } : {}),
            ...(filters ? { filters } : {}),
          });

          return textResult({
            results,
            ...(indexErrors.length > 0 ? { indexErrors } : {}),
            hint:
              results.length === 0
                ? "No matches. Try a broader query or use L0 (`grep`/`ls`) to browse the bundle's index.md."
                : undefined,
          });
        },
      });
    },
  };
}
