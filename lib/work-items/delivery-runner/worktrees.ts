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
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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

// ------------------------------------------------------- verify checkouts (Phase-4 T2)

/** 分支命名：仅作 worktree 目录名载体（addWorktree 不支持检出指定 commit——
 *  只在分支存在时复用/否则在 HEAD 新建，detached 检出必须第二步补）。 */
export function verifyBranch(key: string, generation: number): string {
  return `pi-verify/${key}/gen${generation}`;
}

export interface PrepareVerifyCheckoutsDeps {
  addWorktree?: typeof addWorktree;
  /** worktree 内 detached checkout 缝（默认 spawnSync git checkout --detach）。 */
  checkout?: (args: { worktreePath: string; commit: string }) => { ok: boolean; stderr?: string };
}

/** 镜像 lib/worktree.ts 的 sanitizeBranchForDir（未导出；目录推导必须与
 *  addWorktree 完全一致——漂移 = 幂等 existsSync 预检失效）。 */
function sanitizeBranchForDir(branch: string): string {
  return branch.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultVerifyCheckout(args: { worktreePath: string; commit: string }): { ok: boolean; stderr?: string } {
  const result = spawnSync(
    "git",
    ["-C", args.worktreePath, "checkout", "--detach", args.commit],
    {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      // 与 defaultVerifyRun 同习语：钉死 locale，错误文本可断言。
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  if (result.error) return { ok: false, stderr: result.error.message };
  const stderr = result.stderr?.toString().trim();
  return { ok: result.status === 0, stderr: stderr || undefined };
}

/**
 * 每候选仓一个 detached checkout，检出到该仓的候选 commit（Phase-4 T2，
 * verifier claim 事务的前置——状态落盘之前调用，失败零状态）。
 *
 * 两步法：`addWorktree(repoPath, pi-verify/<KEY>/gen<N>)` 建目录（分支仅作
 * 目录名载体，目录名 sanitize 为 `pi-verify-<KEY>-gen<N>`）→ `git checkout
 * --detach <commit>` 检出到候选。
 *
 * 幂等：同 gen 目录已存在 → 跳过创建但【仍】checkout --detach 目标 commit——
 * 修复半建残留（目录在、checkout 未发生或停在别的 commit；对已处目标 commit
 * 的 worktree 是幂等 no-op）。预检用确定性路径 existsSync 而非 P3 的按分支找：
 * detached 后 porcelain 不再报 branch，按分支找不到自己刚建的 checkout。
 *
 * 单仓失败 → 整体抛 WorkItemValidationError（带 repositoryId / commit / 路
 * 径 / 原因），已建的不回滚（孤儿 worktree 无害——generation 单调，下代领取
 * 用新目录）。同仓多候选按序处理，后者覆盖前者的 checkout（last-wins；候选
 * 集每仓一条的约束由上游 digest 绑定保证）。
 */
export async function prepareVerifyCheckouts(
  workspacePath: string,
  item: { key: string },
  candidates: Array<{ repositoryId: string; commit: string }>,
  generation: number,
  repoPaths: Map<string, string>,
  deps: PrepareVerifyCheckoutsDeps = {},
): Promise<RoleWorktree[]> {
  const addWorktreeImpl = deps.addWorktree ?? addWorktree;
  const checkout = deps.checkout ?? defaultVerifyCheckout;
  const branch = verifyBranch(item.key, generation);

  const results: RoleWorktree[] = [];
  for (const candidate of candidates) {
    const repoPath = repoPaths.get(candidate.repositoryId);
    if (repoPath === undefined) {
      throw new WorkItemValidationError(
        `verify candidate references unknown repository ${candidate.repositoryId} `
        + `(commit ${candidate.commit}): repository not in the prepared worktree set `
        + `(workspace ${workspacePath})`,
      );
    }
    // 与 addWorktree 的目录推导一致：<resolve(repoRoot)>-worktrees/<sanitized>。
    const expectedPath = join(`${resolve(repoPath)}-worktrees`, sanitizeBranchForDir(branch));
    let path = expectedPath;
    if (!existsSync(expectedPath)) {
      try {
        path = (await addWorktreeImpl(repoPath, branch)).path;
      } catch (error) {
        throw new WorkItemValidationError(
          `verify checkout preparation failed for repository ${candidate.repositoryId} `
          + `(${repoPath}, branch ${branch}): ${errorMessage(error)}`,
        );
      }
    } else {
      // 对齐 addWorktree 的路径形态：它的 repoRoot 来自 git 的 common-dir（已
      // 解引用符号链接——macOS 上 /var → /private/var），而 resolve() 不解引用；
      // realpath 化使复用路径与首建路径逐字一致（幂等 deepEqual / claim 快照稳定）。
      try {
        path = realpathSync(expectedPath);
      } catch {
        // 保留 expectedPath（existsSync 刚过——竞态删除时 checkout 阶段会给出权威错误）。
      }
    }
    const checkedOut = checkout({ worktreePath: path, commit: candidate.commit });
    if (!checkedOut.ok) {
      throw new WorkItemValidationError(
        `verify checkout failed for repository ${candidate.repositoryId} `
        + `(commit ${candidate.commit}, worktree ${path})`
        + `${checkedOut.stderr ? `: ${checkedOut.stderr}` : ""}`,
      );
    }
    results.push({ repositoryId: candidate.repositoryId, repoPath, path, branch });
  }
  return results;
}
