// Phase-3 Task 2: developer 领取事务的工作区预建与候选核验（spec
// 2026-10-24-phase-three §5，Task 3 的 claim 事务消费）。
//
//   prepareWorktrees —— 项仓库范围内每登记仓建一个 git worktree（分支
//     `pi-delivery/<KEY>/gen<N>`，addWorktree 内部 sanitize 出目录名）。
//     在 claim 事务状态落盘之前调用：任一仓失败 → 整体抛（不落状态），
//     已建的不回滚——孤儿 worktree 无害（下代领取用新分支，不与旧代冲突）。
//     幂等：同 generation 二次调用复用既有 worktree path（先 listWorktrees
//     按分支找现 worktree；addWorktree 对已存在目录会抛 "Directory already
//     exists"，其「分支已存在则复用」语义只覆盖目录不存在的场景）。
//
//   verifyCandidateCommits —— 候选 commits[] 核验：repoPaths（Task 3 从
//     prepareWorktrees 结果装配 repositoryId → repoPath）必须含该
//     repositoryId，且 commit 真是 repo 的一个 commit（git rev-parse
//     --verify `<sha>^{commit}`）。同步实现（spawnSync——计划裁定锁内可
//     接受）；git 不可用 / 非仓也走 Validation（带 repo 路径与原因）。
//
// 登记复验（第二道门）：manifest 的 repositories[] 只认 status==="active"
// 的登记仓；未登记 / removed 的 id → WorkItemValidationError
// "repository not registered: <id>"（与池子谓词的 repo-not-registered 对应
// ——第一道在池子，claim 事务前置复验在这里）。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { addWorktree, listWorktrees } from "../../worktree.ts";
import { readWorkspaceManifest } from "../../workspaces/service.ts";
import type { WorkspaceManifest } from "../../workspaces/types.ts";
import { WorkItemValidationError } from "../errors.ts";

/** developer 执行槽位的 worktree 描述（Task 3 的 claim 产物组成部分）。 */
export interface RoleWorktree {
  repositoryId: string;
  /** 登记仓在工作区内的绝对路径（join(workspacePath, repository.path)）。 */
  repoPath: string;
  /** worktree 检出路径（`<repoRoot>-worktrees/<sanitized branch>`）。 */
  path: string;
  branch: string;
}

/** deps 注入缝（默认真实现；测试用注入 + 真 git 仓用例双轨）。 */
export interface PrepareWorktreesDeps {
  addWorktree?: typeof addWorktree;
  listWorktrees?: typeof listWorktrees;
  /** manifest 读取（默认 readWorkspaceManifest）。 */
  manifest?: (workspacePath: string) => Promise<Pick<WorkspaceManifest, "repositories">>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 分支命名：generation 进分支名，代与代互不冲突（同代幂等复用）。 */
export function deliveryBranch(key: string, generation: number): string {
  return `pi-delivery/${key}/gen${generation}`;
}

/**
 * 项范围每仓建 worktree。流程：先整表解析登记（未登记/removed 在建任何
 * worktree 之前拒绝——部分建不会因登记过期发生），再按 item.repositories
 * 顺序逐仓建/复用（结果顺序与输入一致）。任一仓失败 → 整体抛
 * WorkItemValidationError（带 repositoryId / repoPath / 分支 / 原因），
 * 已建的不回滚（见模块头）。
 */
export async function prepareWorktrees(
  workspacePath: string,
  item: { key: string; repositories: string[] },
  generation: number,
  deps: PrepareWorktreesDeps = {},
): Promise<RoleWorktree[]> {
  const addWorktreeImpl = deps.addWorktree ?? addWorktree;
  const listWorktreesImpl = deps.listWorktrees ?? listWorktrees;
  const readManifest = deps.manifest ?? readWorkspaceManifest;

  // 第二道登记门：未登记 / removed → Validation（池子谓词是第一道）。
  const manifest = await readManifest(workspacePath);
  const registered = new Map(manifest.repositories.map((repo) => [repo.id, repo]));
  const resolved = item.repositories.map((repositoryId) => {
    const repo = registered.get(repositoryId);
    if (!repo || repo.status !== "active") {
      throw new WorkItemValidationError(`repository not registered: ${repositoryId}`);
    }
    return { repositoryId, repoPath: join(workspacePath, repo.path) };
  });

  const branch = deliveryBranch(item.key, generation);
  const results: RoleWorktree[] = [];
  for (const { repositoryId, repoPath } of resolved) {
    // 幂等复用：该分支的 worktree 已在场（同 generation 重备）→ 直接用现
    // path。listWorktrees 读失败（非仓/损坏）不在此处报错——交给
    // addWorktree 产生权威错误后统一包装。
    let path: string | undefined;
    try {
      path = (await listWorktreesImpl(repoPath))
        .find((worktree) => worktree.branch === branch)?.path;
    } catch {
      path = undefined;
    }
    if (path === undefined) {
      try {
        path = (await addWorktreeImpl(repoPath, branch)).path;
      } catch (error) {
        throw new WorkItemValidationError(
          `worktree preparation failed for repository ${repositoryId} `
            + `(${repoPath}, branch ${branch}): ${errorMessage(error)}`,
        );
      }
    }
    results.push({ repositoryId, repoPath, path, branch });
  }
  return results;
}

// ------------------------------------------------------- candidate verification

export interface VerifyCandidatesDeps {
  /** 单候选核验缝（默认 spawnSync git rev-parse）。 */
  run?: (args: { repo: string; commit: string }) => { ok: boolean; stderr?: string };
}

function defaultVerifyRun(args: { repo: string; commit: string }): { ok: boolean; stderr?: string } {
  const result = spawnSync(
    "git",
    ["-C", args.repo, "rev-parse", "--verify", `${args.commit}^{commit}`],
    {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      // 与 lib/worktree.ts 同习语：钉死 locale，错误文本可断言。
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  // git 不可用 / 无法 spawn → 也是 Validation（带 repo 路径与原因）。
  if (result.error) return { ok: false, stderr: result.error.message };
  const stderr = result.stderr?.toString().trim();
  return { ok: result.status === 0, stderr: stderr || undefined };
}

/**
 * 每候选：repoPaths 含 repositoryId → `git -C <repo> rev-parse --verify
 * <commit>^{commit}` 成功。失败 / 未知 repo → WorkItemValidationError 带
 * repositoryId + commit（+ repo 路径与 stderr 原因）。同步（锁内调用，
 * spawnSync 计划裁定可接受）；空候选 no-op。
 */
export function verifyCandidateCommits(
  repoPaths: Map<string, string>,
  candidates: Array<{ repositoryId: string; commit: string }>,
  deps: VerifyCandidatesDeps = {},
): void {
  const run = deps.run ?? defaultVerifyRun;
  for (const candidate of candidates) {
    const repo = repoPaths.get(candidate.repositoryId);
    if (repo === undefined) {
      throw new WorkItemValidationError(
        `candidate references unknown repository ${candidate.repositoryId} `
          + `(commit ${candidate.commit}): repository not in the prepared worktree set`,
      );
    }
    const result = run({ repo, commit: candidate.commit });
    if (!result.ok) {
      throw new WorkItemValidationError(
        `candidate commit ${candidate.commit} is not a commit in repository `
          + `${candidate.repositoryId} (${repo})${result.stderr ? `: ${result.stderr}` : ""}`,
      );
    }
  }
}
