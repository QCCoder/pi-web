// Phase-2 Task 8: 交付执行状态端点（GET）。四读拼装（claim / attempts 末 5 /
// paused / pendingInterruption）——itemPath 经 readWorkItem 推导（item 不存在
// → 404）；claim 剥离 ownerTokenHash（token 哈希只用于进程内归属校验，永不
// 离开服务端）。runtime/ 是 advisory 运行态，读路径宽松（缺失即 null）。
//
// fix round 1（Phase-3 T5 裁定）：worktrees 的 repositoryId 是 ULID——响应组装
// 时用 manifest repositories 联表富化展示 alias（无 alias/未登记 → 不加字段，
// UI 回退 repositoryId）。alias 是展示元数据且可改名：claim 时落盘会漂移，
// 读取时联表永远新鲜（claim.json / attempts 审计保持服务端事实，不写 alias）。
import { NextResponse } from "next/server";
import { getWorkspace, readWorkspaceManifest } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { readWorkItem } from "@/lib/work-items/service";
import {
  listAttempts,
  listPendingInterruptions,
  readClaim,
  readPaused,
  type ClaimState,
} from "@/lib/work-items/delivery-runner/attempts";
import type { RoleWorktree } from "@/lib/work-items/delivery-runner/worktrees";

/** ownerTokenHash 剥离（rest 解构）——响应里的 claim 不携带归属凭证哈希。 */
function publicClaim(claim: ClaimState): Omit<ClaimState, "ownerTokenHash"> {
  const { ownerTokenHash: _tokenHash, ...rest } = claim;
  void _tokenHash;
  return rest;
}

/** worktrees 读取时联表富化：命中 aliasById 才补 `alias` 字段（不虚构）。 */
function enrichWorktrees(
  worktrees: RoleWorktree[] | undefined,
  aliasById: Map<string, string>,
): Array<RoleWorktree & { alias?: string }> | undefined {
  if (worktrees === undefined) return undefined;
  return worktrees.map((worktree) => {
    const alias = aliasById.get(worktree.repositoryId);
    return alias ? { ...worktree, alias } : { ...worktree };
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const { path } = await getWorkspace(id);
    const detail = await readWorkItem(path, key);
    const itemPath = detail.path;
    // removed 条目也进联表——worktree 引用的仓后来移除时，末次 alias 仍比
    // ULID 可读（富化只做展示，不影响登记事实）。
    const aliasById = new Map(
      (await readWorkspaceManifest(path)).repositories.map((repository) => [
        repository.id,
        repository.alias,
      ]),
    );
    const claim = readClaim(itemPath);
    const attempts = await listAttempts(itemPath); // attemptId（ULID）升序
    return NextResponse.json({
      claim:
        claim === null
          ? null
          : { ...publicClaim(claim), worktrees: enrichWorktrees(claim.worktrees, aliasById) },
      recentAttempts: attempts
        .slice(-5) // 末 5 条、新者在前
        .reverse()
        .map((entry) => ({ ...entry, worktrees: enrichWorktrees(entry.worktrees, aliasById) })),
      paused: readPaused(itemPath),
      pendingInterruption: (await listPendingInterruptions(itemPath)).length > 0,
    });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
