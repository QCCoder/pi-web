import type { SubagentProfile, SubagentScope, SubagentWritableScope } from "./subagents";

/**
 * 作用域 → 目录 的展示用纯函数（客户端安全，不碰 fs）。
 *
 * project / workspace 的相对目录由 lib/subagents.ts 的 profileDirectories 钉死
 * （`./.pi/agents` / `./.agents/agents`）；global 目录 = getAgentDir()/agents，
 * 用户用 scripts/adopt-pi-home.mjs 把数据家搬进仓库后它不再是 `~/.pi/agent`，
 * 所以优先从已加载的 global 配置 filePath 反推真实目录（落在 cwd 内就显示成
 * `./…` 相对路径，与项目配置同一规则），没有样本才回落到默认。
 */

export const DEFAULT_GLOBAL_AGENTS_DIRECTORY = "~/.pi/agent/agents";

export function shortenHomePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function parentDirectory(filePath: string): string {
  return filePath.replace(/[/\\][^/\\]+$/, "");
}

function displayDirectory(directory: string, cwd: string | undefined): string {
  if (cwd && directory.startsWith(cwd)) {
    const relative = directory.slice(cwd.length).replace(/^[/\\]/, "");
    return relative ? `./${relative}` : ".";
  }
  return shortenHomePath(directory);
}

export function globalAgentsDirectory(
  profiles: readonly Pick<SubagentProfile, "scope" | "filePath">[],
  cwd?: string,
): string {
  const sample = profiles.find((profile) => profile.scope === "global" && profile.filePath);
  return sample?.filePath ? displayDirectory(parentDirectory(sample.filePath), cwd) : DEFAULT_GLOBAL_AGENTS_DIRECTORY;
}

/** 侧栏 / 分组标题旁的目录 hint；内置配置没有目录。 */
export function subagentScopeDirectory(
  scope: SubagentScope,
  profiles: readonly Pick<SubagentProfile, "scope" | "filePath">[],
  cwd?: string,
): string | null {
  switch (scope) {
    case "project": return "./.pi/agents";
    case "workspace": return "./.agents/agents";
    case "global": return globalAgentsDirectory(profiles, cwd);
    case "builtin": return null;
  }
}

/** 新建时将写入的文件路径（与 lib/subagents.ts writableProfileDirectory 同规则）。 */
export function subagentTargetPath(
  scope: SubagentWritableScope,
  name: string,
  profiles: readonly Pick<SubagentProfile, "scope" | "filePath">[],
  cwd?: string,
): string {
  const file = `${name || "..."}.md`;
  return scope === "global" ? `${globalAgentsDirectory(profiles, cwd)}/${file}` : `./.pi/agents/${file}`;
}
