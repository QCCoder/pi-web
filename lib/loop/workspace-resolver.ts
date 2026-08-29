import { discoverWorkspaces, getWorkspace } from "../workspaces/service.ts";
import type { WorkspaceResolver } from "./types.ts";

export class PiWorkspaceResolver implements WorkspaceResolver {
  async get(workspaceId: string) {
    const { path, manifest } = await getWorkspace(workspaceId);
    return { id: manifest.id, name: manifest.name, path };
  }

  async list() {
    // The `loop` workspace capability is retired (read-path strip — see
    // LEGACY_READ_CAPABILITIES in ../workspaces/service.ts): parsed manifests
    // can no longer carry it, so this filter is always empty and the v3
    // scheduler stays dormant until the engine is deleted (kit-teardown Task 5).
    // Kept as a filter (not a literal []) so the retirement stays visible at
    // the deletion site; do NOT remove the check — that would wake the v3
    // engine for every workspace with a loops/ directory.
    return (await discoverWorkspaces())
      .filter((workspace) => workspace.available && (workspace.capabilities as readonly string[]).includes("loop"))
      .map((workspace) => ({ id: workspace.id, name: workspace.name, path: workspace.path }));
  }
}
