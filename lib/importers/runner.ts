/** Importer runner (design §5). This is the deep-module seam that hides the
 *  full "pull → dedup → create work item → localize images → rewrite README src
 *  → append events" flow behind one entry point. Both the loop-host system timer
 *  and the web manual-sync endpoint call only `syncImporterForWorkspace`.
 *
 *  The run is deterministic I/O — it is NOT delegated to an LLM (design §5:
 *  prevent hallucination / wrong params). The third-party source is isolated
 *  behind the Importer SPI, so swapping Chandao for Jira changes one adapter,
 *  not this runner.
 *
 *  Strip-only-compatible (no parameter properties) so it loads under
 *  `node --test` as well as jiti/Next. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspace } from "../workspaces/service.ts";
import {
  createWorkItem,
  listWorkItems,
  recordWorkItemMilestone,
} from "../work-items/service.ts";
import { ChandaoImporter } from "./chandao-importer.ts";
import { readImporterConfig } from "./config.ts";
import { extractChandaoFileIds, rewriteChandaoImageSources } from "./images.ts";
import { buildExternalIndex, externalKey, mapSourceKindToWorkItemType } from "./mapping.ts";
import type { Attachment, Importer } from "./types.ts";

export interface ImporterRunDetail {
  sourceId: string;
  kind: string;
  action: "created" | "synced" | "skipped" | "error";
  key?: string;
  error?: string;
}

export interface ImporterRunSummary {
  workspaceId: string;
  source: string;
  created: number;
  synced: number;
  skipped: number;
  errors: number;
  details: ImporterRunDetail[];
}

/** Run a given Importer against a workspace: pull assigned items and materialize
 *  them into work items (deduped by external.sourceId). Inject the importer so
 *  tests can mock the source without touching the network. */
export async function runImporterForWorkspace(
  workspaceId: string,
  importer: Importer,
  options: { now?: () => Date } = {},
): Promise<ImporterRunSummary> {
  const now = (options.now ?? (() => new Date()))();
  const lastSyncedAt = now.toISOString();
  const { path: workspacePath } = await getWorkspace(workspaceId);

  // Dedup index from existing work items.
  const { items } = await listWorkItems(workspacePath);
  const index = buildExternalIndex(items);

  const sourceItems = await importer.listAssigned({});

  const summary: ImporterRunSummary = {
    workspaceId,
    source: importer.kind,
    created: 0,
    synced: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  for (const item of sourceItems) {
    const key = externalKey(importer.kind, item.sourceId);
    const existing = index.get(key);
    try {
      // Archived items are never re-touched.
      if (existing && existing.archivedAt) {
        summary.skipped += 1;
        summary.details.push({ sourceId: item.sourceId, kind: item.kind, action: "skipped", key: existing.key });
        continue;
      }
      if (!existing) {
        const detail = await importer.getDetail(item.sourceId);
        // Download every referenced image, then localize the <img> srcs.
        const fileIds = extractChandaoFileIds(detail.body);
        const attachments = new Map<string, Attachment>();
        for (const fileId of fileIds) {
          attachments.set(fileId, await importer.getAttachment(fileId));
        }
        const extOf = (fileId: string) => attachments.get(fileId)?.ext ?? "bin";
        const body = rewriteChandaoImageSources(detail.body, extOf, importer.kind);
        // Chandao tasks (and occasionally bugs) may have an empty description.
        // The work item requires a non-empty Original Description, so substitute
        // a traceable placeholder rather than dropping the item.
        const description = body.trim()
          ? body
          : `（${importer.kind} 来源描述为空，详见标题与外部链接）`;

        const created = await createWorkItem(workspaceId, {
          type: mapSourceKindToWorkItemType(item.kind),
          title: detail.title,
          originalDescription: description,
          external: {
            source: importer.kind,
            sourceId: detail.sourceId,
            ...(detail.url ? { url: detail.url } : {}),
            lastSyncedAt,
          },
          tags: [importer.kind],
          actor: "external",
        });
        // Persist downloaded images into the work item's attachments dir.
        await Promise.all(
          [...attachments.entries()].map(async ([fileId, att]) =>
            writeFile(
              join(created.path, "attachments", `${importer.kind}-${fileId}.${att.ext}`),
              att.bytes,
            ),
          ),
        );
        await recordWorkItemMilestone(workspaceId, created.item.key, {
          type: "imported",
          actor: "external",
          data: { action: "created", source: importer.kind, sourceId: detail.sourceId, lastSyncedAt },
        });
        summary.created += 1;
        summary.details.push({ sourceId: item.sourceId, kind: item.kind, action: "created", key: created.item.key });
        continue;
      }

      // Existing & open: nothing changed (P1 does not diff upstream content yet).
      // A no-op sync is NOT a timeline event — appending one on every timer tick
      // (ImporterScheduler = every 30min) floods events.jsonl with redundant
      // `imported:synced` rows: one open item produces ~48 noise rows/day, which
      // is exactly what polluted REQ-0012's timeline (35 identical rows). The run
      // summary still counts it as `synced` so the report is informative; the
      // one-time `imported:created` provenance row from the first import stays.
      // Nothing consumes `imported:synced` (timeline consumers only react to
      // work_item.updated), so dropping it is behavior-safe.
      summary.synced += 1;
      summary.details.push({ sourceId: item.sourceId, kind: item.kind, action: "synced", key: existing.key });
    } catch (error) {
      summary.errors += 1;
      summary.details.push({
        sourceId: item.sourceId,
        kind: item.kind,
        action: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

/** Read the workspace's importer config, build the matching adapter, and run.
 *  Currently only Chandao is supported; throws if not configured. */
export async function syncImporterForWorkspace(workspaceId: string): Promise<ImporterRunSummary> {
  const config = await readImporterConfig(workspaceId);
  if (!config?.chandao) {
    throw new Error(`No importer configured for workspace ${workspaceId}`);
  }
  const importer = new ChandaoImporter(config.chandao);
  return runImporterForWorkspace(workspaceId, importer);
}
