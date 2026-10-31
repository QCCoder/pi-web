import { execFile } from "child_process";
import { promisify } from "util";

// ============================================================================
// 工作项 Git 分支状态探测（只读，永不落盘）：
// 给 /api/workspaces/[id]/work-items/[key]/git 提供「当前开发分支 / 是否已
// 合入 develop、master（兜底 main）」的实时计算。合并状态是仓库的派生事实，
// 不进 item.yaml、不进 events.jsonl。
// ============================================================================

const execFileAsync = promisify(execFile);

/** 合并检查：工作项分支/提交是否已合入目标分支。 */
export interface WorkItemMergeCheck {
  target: string;
  merged: boolean;
}

/** managed 项候选提交（delivery.candidates）的合并状态。 */
export interface WorkItemCandidateStatus {
  commit: string;
  targets: WorkItemMergeCheck[];
}

/** 交付流自动分支（pi-delivery/<KEY>/genN）的合并状态。 */
export interface WorkItemDeliveryBranchStatus {
  branch: string;
  targets: WorkItemMergeCheck[];
}

/** 每关联仓库一份的分支状态（前端直接 import type 共享）。 */
export interface WorkItemRepoBranchStatus {
  repositoryId: string;
  alias: string;
  repoPathExists: boolean;
  /** 工作项登记的开发分支（item.branches），未登记为 null。 */
  itemBranch: string | null;
  /** 仓库当前 checkout 的分支（来自仓库列表状态），detached/非 git 为 null。 */
  repoBranch: string | null;
  itemBranchExists: boolean;
  /** 对 itemBranch 的合并检查；分支不存在或无目标分支时为空。 */
  branchTargets: WorkItemMergeCheck[];
  /** 交付流自动识别的分支（pi-delivery/<KEY>/*），按 gen 升序。 */
  deliveryBranches: string[];
  /** 最新 gen 交付分支及其合并状态；无交付分支时为 null。 */
  latestDelivery: WorkItemDeliveryBranchStatus | null;
  /** 候选提交及其合并状态（managed 项）；无候选时为 null。 */
  candidate: WorkItemCandidateStatus | null;
  error?: string;
}

// 缓存挂 globalThis（HMR/jiti 双载共享同一实例）。merge-base 与分支列表都是
// 派生事实，短 TTL 只为省子进程，前端刷新按钮 ?refresh=1 可绕过。
declare global {
  var __piWorkItemBranchCache: Map<string, { at: number; value: unknown }> | undefined;
}

const BRANCH_CACHE_TTL_MS = 30_000;
/** 合并目标：优先 develop/master；两者都不存在才兜底 main。 */
const PREFERRED_TARGETS = ["develop", "master"] as const;
const FALLBACK_TARGET = "main";

function branchCache(): Map<string, { at: number; value: unknown }> {
  if (!globalThis.__piWorkItemBranchCache) globalThis.__piWorkItemBranchCache = new Map();
  return globalThis.__piWorkItemBranchCache;
}

function cacheGet<T>(key: string): T | undefined {
  const hit = branchCache().get(key);
  if (hit && Date.now() - hit.at < BRANCH_CACHE_TTL_MS) return hit.value as T;
  if (hit) branchCache().delete(key);
  return undefined;
}

function cacheSet(key: string, value: unknown): void {
  branchCache().set(key, { at: Date.now(), value });
}

/** 测试与 ?refresh=1 共用的缓存清理。 */
export function invalidateWorkItemBranchCache(): void {
  globalThis.__piWorkItemBranchCache?.clear();
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

/** 解析 `for-each-ref --format=%(refname:short) refs/heads/` 输出为本地分支名列表。 */
export function parseLocalBranches(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** 纯函数：从本地分支集合决定检查目标。develop/master 缺一个也算「存在偏好」，
 *  两个全缺才退回 main；main 也没有则无处可查（空数组）。 */
export function resolveMergeTargets(localBranches: string[]): string[] {
  const present = new Set(localBranches);
  const preferred = PREFERRED_TARGETS.filter((target) => present.has(target));
  if (preferred.length > 0) return preferred;
  return present.has(FALLBACK_TARGET) ? [FALLBACK_TARGET] : [];
}

/** 纯函数：从分支列表挑出该项的交付流分支（pi-delivery/<KEY>/genN），按 gen
 *  升序；gen 解析不了的排最后（按字典序稳定排序）。 */
export function deliveryBranchesForKey(localBranches: string[], key: string): string[] {
  const prefix = `pi-delivery/${key}/`;
  const gen = (branch: string): number => {
    const match = branch.slice(prefix.length).match(/^gen(\d+)$/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  return localBranches
    .filter((branch) => branch.startsWith(prefix))
    .sort((a, b) => gen(a) - gen(b) || a.localeCompare(b));
}

/** 仓库本地分支列表（单次 for-each-ref，30s TTL）。 */
async function loadLocalBranches(repoPath: string, refresh?: boolean): Promise<string[]> {
  const key = `branches|${repoPath}`;
  if (!refresh) {
    const hit = cacheGet<string[]>(key);
    if (hit) return hit;
  }
  const output = await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const branches = parseLocalBranches(output);
  cacheSet(key, branches);
  return branches;
}

/** merge-base --is-ancestor：exit 0 = 已是祖先（已合入），1 = 未合入，
 *  其他退出码（分支/提交不存在等）原样抛出由调用方按仓报错。 */
async function isAncestor(repoPath: string, from: string, target: string, refresh?: boolean): Promise<boolean> {
  const key = `ancestor|${repoPath}|${from}|${target}`;
  if (!refresh) {
    const hit = cacheGet<boolean>(key);
    if (hit !== undefined) return hit;
  }
  try {
    await git(repoPath, ["merge-base", "--is-ancestor", from, target]);
    cacheSet(key, true);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) {
      cacheSet(key, false);
      return false;
    }
    throw error;
  }
}

async function mergeChecks(
  repoPath: string,
  from: string,
  targets: string[],
  refresh?: boolean,
): Promise<WorkItemMergeCheck[]> {
  return Promise.all(targets.map(async (target) => ({
    target,
    merged: await isAncestor(repoPath, from, target, refresh),
  })));
}

export async function computeWorkItemRepoBranchStatus(params: {
  repositoryId: string;
  alias: string;
  repoPath: string;
  key: string;
  itemBranch: string | null;
  repoBranch: string | null;
  candidateCommit: string | null;
  refresh?: boolean;
}): Promise<WorkItemRepoBranchStatus> {
  const { repositoryId, alias, repoPath, key, itemBranch, repoBranch, candidateCommit, refresh } = params;
  const status: WorkItemRepoBranchStatus = {
    repositoryId,
    alias,
    repoPathExists: true,
    itemBranch,
    repoBranch,
    itemBranchExists: false,
    branchTargets: [],
    deliveryBranches: [],
    latestDelivery: null,
    candidate: null,
  };
  try {
    const localBranches = await loadLocalBranches(repoPath, refresh);
    const targets = resolveMergeTargets(localBranches);
    status.itemBranchExists = itemBranch !== null && localBranches.includes(itemBranch);
    if (itemBranch && status.itemBranchExists && targets.length > 0) {
      status.branchTargets = await mergeChecks(repoPath, itemBranch, targets, refresh);
    }
    const delivery = deliveryBranchesForKey(localBranches, key);
    status.deliveryBranches = delivery;
    const latest = delivery.at(-1);
    if (latest && targets.length > 0) {
      status.latestDelivery = { branch: latest, targets: await mergeChecks(repoPath, latest, targets, refresh) };
    }
    if (candidateCommit && targets.length > 0) {
      status.candidate = { commit: candidateCommit, targets: await mergeChecks(repoPath, candidateCommit, targets, refresh) };
    }
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }
  return status;
}
