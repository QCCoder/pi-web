import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createWorkspaceWorkItemExtension } from "../work-items/extension.ts";
import { effectiveCapabilities } from "./service.ts";
import type { WorkspaceCapability, WorkspaceManifest } from "./types.ts";

/**
 * A workspace-scoped pi extension that registers LLM-callable tools for a
 * specific workspace. Modules that expose tools to the agent register here;
 * rpc-manager attaches the ones whose capability is enabled on the workspace.
 *
 * This is the "module" abstraction for tool-providing modules:
 *   module = capability (manifest toggle) + extension (tools) + config UI.
 * Server-side modules (loop, feishu-channel) are not extensions; they are
 * background services gated by the same capabilities.
 */
export interface WorkspaceExtensionFactory {
  /** Capability that enables this extension. Attached only when the workspace's
   *  effective capabilities include this value. */
  capability: WorkspaceCapability;
  /** Build the extension for a workspace. Return undefined to skip silently. */
  build: (manifest: WorkspaceManifest, workspacePath: string) => InlineExtension | undefined;
}

/**
 * Registry of workspace tool modules. To add a new tool module:
 *   1. add a capability to {@link WorkspaceCapability} (lib/workspaces/types.ts)
 *   2. implement an InlineExtension factory (see work-items/extension.ts)
 *   3. add an entry here
 *   4. add a config UI panel gated on the same capability
 */
export const WORKSPACE_EXTENSION_FACTORIES: readonly WorkspaceExtensionFactory[] = [
  {
    capability: "work-items",
    build: (manifest, workspacePath) =>
      createWorkspaceWorkItemExtension(manifest.id, workspacePath),
  },
];

/**
 * Build the InlineExtensions to attach for a workspace, filtered by the
 * workspace's effective capabilities. This is the single attachment point used
 * by rpc-manager and the source of truth for "which tool modules are active".
 */
export function buildWorkspaceExtensions(
  manifest: WorkspaceManifest,
  workspacePath: string,
): InlineExtension[] {
  const capabilities = effectiveCapabilities(manifest);
  const extensions: InlineExtension[] = [];
  for (const entry of WORKSPACE_EXTENSION_FACTORIES) {
    if (!capabilities.includes(entry.capability)) continue;
    const extension = entry.build(manifest, workspacePath);
    if (extension) extensions.push(extension);
  }
  return extensions;
}
