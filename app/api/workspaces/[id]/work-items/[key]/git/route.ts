import { NextResponse } from "next/server";
import {
  computeWorkItemRepoBranchStatus,
  type WorkItemRepoBranchStatus,
} from "@/lib/work-items/branch-status";
import { readWorkItem } from "@/lib/work-items/service";
import { getWorkspace, listWorkspaceRepositories, workspaceRepositoryPath } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";

function inactiveRepoStatus(repositoryId: string, alias: string, error: string): WorkItemRepoBranchStatus {
  return {
    repositoryId,
    alias,
    repoPathExists: false,
    itemBranch: null,
    repoBranch: null,
    itemBranchExists: false,
    branchTargets: [],
    deliveryBranches: [],
    latestDelivery: null,
    candidate: null,
    error,
  };
}

// GET：实时计算工作项各关联仓库的分支状态（当前分支 / 是否已合入 develop、
// master）。合并状态永远现算（仓库列表缓存 + 本模块 30s TTL），不落盘；
// ?refresh=1 同时穿透两层缓存。
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    const workspace = await getWorkspace(id);
    const { item } = await readWorkItem(workspace.path, key);
    const repoStates = await listWorkspaceRepositories(id, undefined, { refresh });
    const branchByRepo = new Map((item.branches ?? []).map((entry) => [entry.repositoryId, entry.branch]));
    const candidateByRepo = new Map(
      (item.delivery?.candidates ?? []).map((entry) => [entry.repositoryId, entry.commit]),
    );
    const repositories = await Promise.all(item.repositories.map(async (repositoryId): Promise<WorkItemRepoBranchStatus> => {
      const state = repoStates.find((repo) => repo.id === repositoryId);
      if (!state || state.status !== "active") {
        return inactiveRepoStatus(repositoryId, state?.alias ?? repositoryId, "仓库已移除或不存在");
      }
      if (!state.exists) {
        return inactiveRepoStatus(repositoryId, state.alias, "仓库目录在磁盘上缺失");
      }
      const { absolutePath } = workspaceRepositoryPath(workspace.path, state);
      return computeWorkItemRepoBranchStatus({
        repositoryId,
        alias: state.alias,
        repoPath: absolutePath,
        key,
        itemBranch: branchByRepo.get(repositoryId) ?? null,
        repoBranch: state.branch ?? null,
        candidateCommit: candidateByRepo.get(repositoryId) ?? null,
        refresh,
      });
    }));
    return NextResponse.json({ repositories });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
