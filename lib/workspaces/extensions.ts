import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createDeliveryRunnerExtension } from "../work-items/delivery-runner/tools.ts";
import { createWorkspaceWorkItemExtension } from "../work-items/extension.ts";
import { workspaceRepositoryPath } from "./service.ts";
import type { KnowledgeRepoRef } from "./kb-search/index.ts";
import { createKbSearchExtension } from "./kb-search/extension.ts";
import type { WorkspaceCapability, WorkspaceManifest } from "./types.ts";

/**
 * A workspace-scoped pi extension that registers LLM-callable tools for a
 * specific workspace. Modules that expose tools to the agent register here;
 * rpc-manager attaches the ones whose capability is enabled on the workspace.
 *
 * This is the "module" abstraction for tool-providing modules:
 *   module = capability (manifest toggle) + extension (tools) + config UI.
 * Server-side modules (loop) are not extensions; they are
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
// NOTE: `subagent` is intentionally NOT registered here. It is a global
// capability, attached to every session in lib/rpc-manager.ts (startRpcSession),
// independent of workspace capability toggles. Do not re-add it as a module.
export const WORKSPACE_EXTENSION_FACTORIES: readonly WorkspaceExtensionFactory[] = [
  {
    capability: "work-items",
    build: (manifest, workspacePath) =>
      createWorkspaceWorkItemExtension(manifest.id, workspacePath),
  },
  {
    // 交付自动化领取工具（Phase-2）：挂载需要 work-items ∧ workflows 双能力
    // （与服务侧 claim 的 assertAutomationCapable 同一对，config.ts）。单
    // capability 的注册表表达不了合取——在 build 里补第二道门，返回
    // undefined = 静默不挂载。工具运行时另有角色授权身份门
    // （delivery-runner/role-grants.ts），capability 只管挂载。
    capability: "work-items",
    build: (manifest, workspacePath) =>
      manifest.capabilities.includes("workflows")
        ? createDeliveryRunnerExtension(manifest.id, workspacePath)
        : undefined,
  },
  {
    // knowledge capability carries BOTH always-on L0 (agent read/grep/ls, no tool)
    // AND this opt-in L1 `kb_search` enhancement (redesign decisions 11/14). The two
    // coexist: L0 needs no extension, this factory only adds the ranked-search tool.
    capability: "knowledge",
    build: (manifest, workspacePath) => {
      const knowledgeRepos: KnowledgeRepoRef[] = manifest.repositories
        .filter((repository) => repository.kind === "knowledge" && repository.status === "active")
        .map((repository) => ({
          alias: repository.alias,
          path: workspaceRepositoryPath(workspacePath, repository).absolutePath,
        }));
      return createKbSearchExtension(manifest.id, workspacePath, knowledgeRepos);
    },
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
  const capabilities = manifest.capabilities;
  const extensions: InlineExtension[] = [];
  for (const entry of WORKSPACE_EXTENSION_FACTORIES) {
    if (!capabilities.includes(entry.capability)) continue;
    const extension = entry.build(manifest, workspacePath);
    if (extension) extensions.push(extension);
  }
  return extensions;
}
