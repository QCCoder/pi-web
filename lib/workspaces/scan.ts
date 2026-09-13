/** 工作区仓库自动扫描（2026-09「扫描为事实，manifest 只存记忆」约定）。
 *
 *  从工作区根扫两类可登记目录：
 *  - OKF 知识库：目录含 `index.md` + `log.md`（优先于 git 判定——知识库也可以是 git 仓）；
 *  - git 仓：目录含 `.git` **目录**（linked worktree 的 `.git` 是文件、指向别处的主仓，
 *    不算独立仓）。
 *
 *  发现即停（不再下钻仓内部——仓内嵌套的仓是那个仓自己的事）；点目录、
 *  `node_modules`、`.worktrees` 剪枝；深度上限 4（登记语义只面向根附近的目录）。
 *
 *  消费方：`syncRepositoriesFromScan`（service.ts）把扫描结果对账进 manifest——
 *  新目录自动登记、消失目录自动停用、重现自动恢复；manifest 条目的
 *  alias/kind 是钉住覆盖（扫描不改写），path 是对账键。 */
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

export interface ScannedRepository {
  /** 相对工作区根的 POSIX 路径（对账键，同 manifest.repositories[].path）。 */
  path: string;
  /** 目录名——新登记条目的默认 alias（manifest 已钉住的 alias 不被改写）。 */
  alias: string;
  kind: "code" | "knowledge";
}

const PRUNE_NAMES = new Set(["node_modules", ".worktrees"]);
const MAX_SCAN_DEPTH = 4;

function isOkfBundle(dir: string): boolean {
  return existsSync(join(dir, "index.md")) && existsSync(join(dir, "log.md"));
}

function isGitRepo(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return false; // 无 .git，或 .git 是文件（linked worktree → 属于别处的主仓）
  }
}

function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

export function scanWorkspaceRepositories(workspacePath: string): ScannedRepository[] {
  const results: ScannedRepository[] = [];
  const walk = (dir: string, depth: number): void => {
    // depth = dir 距根的段数；本层条目在 depth+1 段，超过上限即剪
    if (depth >= MAX_SCAN_DEPTH) return;
    // NOTE: ReturnType<typeof readdirSync> resolves the wrong overload under
    // @types/node 25 (Dirent<NonSharedBuffer>) — annotate Dirent<string>[] directly.
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || PRUNE_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (isOkfBundle(full)) {
        results.push({ path: relPosix(workspacePath, full), alias: entry.name, kind: "knowledge" });
        continue; // 发现即停
      }
      if (isGitRepo(full)) {
        results.push({ path: relPosix(workspacePath, full), alias: entry.name, kind: "code" });
        continue; // 发现即停
      }
      walk(full, depth + 1);
    }
  };
  walk(workspacePath, 0);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}
