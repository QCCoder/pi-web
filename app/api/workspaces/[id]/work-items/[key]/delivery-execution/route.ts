// Phase-2 Task 8: 交付执行状态端点（GET）。四读拼装（claim / attempts 末 5 /
// paused / pendingInterruption）——itemPath 经 readWorkItem 推导（item 不存在
// → 404）；claim 剥离 ownerTokenHash（token 哈希只用于进程内归属校验，永不
// 离开服务端）。runtime/ 是 advisory 运行态，读路径宽松（缺失即 null）。
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspaces/service";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { readWorkItem } from "@/lib/work-items/service";
import {
  listAttempts,
  listPendingInterruptions,
  readClaim,
  readPaused,
  type ClaimState,
} from "@/lib/work-items/delivery-runner/attempts";

/** ownerTokenHash 剥离（rest 解构）——响应里的 claim 不携带归属凭证哈希。 */
function publicClaim(claim: ClaimState): Omit<ClaimState, "ownerTokenHash"> {
  const { ownerTokenHash: _tokenHash, ...rest } = claim;
  void _tokenHash;
  return rest;
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
    const claim = readClaim(itemPath);
    const attempts = await listAttempts(itemPath); // attemptId（ULID）升序
    return NextResponse.json({
      claim: claim === null ? null : publicClaim(claim),
      recentAttempts: attempts.slice(-5).reverse(), // 末 5 条、新者在前
      paused: readPaused(itemPath),
      pendingInterruption: (await listPendingInterruptions(itemPath)).length > 0,
    });
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
