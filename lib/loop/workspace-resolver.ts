import { discoverWorkspaces, getWorkspace } from "../workspaces/service.ts";
import type { WorkspaceResolver } from "./types.ts";

export class PiWorkspaceResolver implements WorkspaceResolver {
  async get(workspaceId: string) {
    const { path, manifest } = await getWorkspace(workspaceId);
    return { id: manifest.id, name: manifest.name, path };
  }

  async list() {
    return (await discoverWorkspaces())
      .filter((workspace) => workspace.available && workspace.capabilities.includes("loop"))
      .map((workspace) => ({ id: workspace.id, name: workspace.name, path: workspace.path }));
  }
}
