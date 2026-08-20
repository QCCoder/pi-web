import { discoverWorkspaces } from "../workspaces/service.ts";
import { findWorkItemByConversation } from "../work-items/service.ts";
import type { WorkspaceLocation } from "./types.ts";
import { listRunSnapshots } from "./store.ts";

/** Web-side join between Loop orchestrator sessions and the work items their
 *  runs picked. This is the SAME chain the host's sessionNamer uses
 *  (findWorkItemByConversation over item.yaml `conversations`), so a run the
 *  sidebar routes to a work item and a session the namer titles "(Loop) …"
 *  can never disagree.
 *
 *  Used by:
 *  - GET /api/workspaces/:id/loop/runs — per-run work item badge.
 *  - GET /api/sessions — `loopOrchestrator`/`loopWorkItem` tags so idle
 *    orchestrators (no work item) are hidden from session lists while runs
 *    that picked an item stay listed. */

export interface OrchestratorWorkItem {
  key: string;
  title: string;
}

/** Map sessionId → work item for every run of one workspace that has a
 *  sessionId and is linked to a work item conversation. */
export async function orchestratorWorkItemIndex(
  workspace: WorkspaceLocation,
): Promise<Map<string, OrchestratorWorkItem>> {
  const index = new Map<string, OrchestratorWorkItem>();
  const runs = await listRunSnapshots(workspace).catch(() => []);
  const seen = new Set<string>();
  for (const run of runs) {
    if (!run.sessionId || seen.has(run.sessionId)) continue;
    seen.add(run.sessionId);
    const item = await findWorkItemByConversation(workspace.path, run.sessionId).catch(() => undefined);
    if (item) index.set(run.sessionId, item);
  }
  return index;
}

export interface LoopSessionTag {
  orchestrator: true;
  workItemKey?: string;
}

const TAGS_CACHE_TTL_MS = 30_000;

/** sessionId → loop tag across all workspaces (30s cache — the join reads every
 *  work item's item.yaml per orchestrator session). `refresh=true` on the
 *  sessions route invalidates it alongside the session-list cache so a freshly
 *  triggered round's orchestrator is tagged immediately. */
export async function loopSessionTags(): Promise<Map<string, LoopSessionTag>> {
  const cache = (globalThis as {
    __piLoopSessionTags?: { ts: number; tags: Map<string, LoopSessionTag> };
  }).__piLoopSessionTags;
  if (cache && Date.now() - cache.ts < TAGS_CACHE_TTL_MS) return cache.tags;

  const tags = new Map<string, LoopSessionTag>();
  const workspaces = await discoverWorkspaces().catch(() => []);
  for (const workspace of workspaces) {
    if (!workspace.available) continue;
    const location: WorkspaceLocation = { id: workspace.id, name: workspace.name, path: workspace.path };
    const runs = await listRunSnapshots(location).catch(() => []);
    if (runs.length === 0) continue;
    const items = await orchestratorWorkItemIndex(location);
    for (const run of runs) {
      if (!run.sessionId || tags.has(run.sessionId)) continue;
      tags.set(run.sessionId, { orchestrator: true, workItemKey: items.get(run.sessionId)?.key });
    }
  }
  (globalThis as { __piLoopSessionTags?: { ts: number; tags: Map<string, LoopSessionTag> } }).__piLoopSessionTags = {
    ts: Date.now(),
    tags,
  };
  return tags;
}

export function invalidateLoopSessionTags(): void {
  (globalThis as { __piLoopSessionTags?: unknown }).__piLoopSessionTags = undefined;
}
