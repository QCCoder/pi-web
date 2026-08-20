import { discoverWorkspaces } from "../workspaces/service.ts";
import type { WorkspaceLocation } from "./types.ts";
import { listRunSnapshots } from "./store.ts";

/** v3: selection-round orchestrator marker. Every orchestrator session is idle
 *  by contract (selection rounds pick + seed, they never own a work item), so
 *  they are hidden from session lists — their entry point is the Loop view's
 *  run record. */
export interface LoopSessionTag {
  orchestrator: true;
}

const TAGS_CACHE_TTL_MS = 30_000;

/** sessionId → loop tag across all workspaces (30s cache). `refresh=true` on
 *  the sessions route invalidates it alongside the session-list cache so a
 *  freshly triggered round's orchestrator is tagged immediately. */
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
    for (const run of runs) {
      if (!run.sessionId || tags.has(run.sessionId)) continue;
      tags.set(run.sessionId, { orchestrator: true });
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
