// Phase-2 Task 5: 角色授权登记（spec 2026-10-24-phase-two §5.3）。
// Phase-3 Task 4: RoleGrant.role 放宽为 DeliveryRole（designer | developer）——
// setGrantToken/hasAnyActiveExecution/roleGrantOf 逻辑不变（跨角色单槽位天然成立）。
// 进程内单例：sessionId → RoleGrant。dispatcher 在拉起角色会话时 grantRole；
// 会话结束/关停（role-session 结束钩子）revokeRole。工具层（tools.ts）只经
// setGrantToken 把 claim 服务一次性核发的 ownerToken 落到已有 grant 上
// ——token 永不离开进程（不进 LLM 参数、不落盘；claim.json 只存哈希）。
//
// 单例挂 globalThis（对照 lib/session-host/registry.ts 的 declare global
// 习语）：HMR / jiti 双载各自得到新模块实例，Map 分裂会让「授予」与「校验」
// 落到两个登记簿——身份门全瞎。globalThis 守卫保证所有实例共享同一张表。
import type { DeliveryRole } from "./pool.ts";

export interface RoleGrant {
  role: DeliveryRole;
  workspacePath: string;
  /** claim 服务首次核发的明文 ownerToken（幂等重放拿不到——空）。 */
  ownerToken?: string;
  /** 本会话当前活动领取的 attemptId（claim 后在场，submit/fail 后清空）。 */
  attemptId?: string;
  /** 领取代次——submit/fail 服务签名需要；brief 未列出，作为 RoleGrant 的
   *  补充字段由 setGrantToken 一并落账。 */
  generation?: number;
}

declare global {
  var __piDeliveryRoleGrants: Map<string, RoleGrant> | undefined;
}

function grants(): Map<string, RoleGrant> {
  if (!globalThis.__piDeliveryRoleGrants) {
    globalThis.__piDeliveryRoleGrants = new Map();
  }
  return globalThis.__piDeliveryRoleGrants;
}

/** 授予角色（全量替换——submit/fail 成功后也用它把 grant 重置回裸授权，
 *  清掉过期凭证）。值拷贝入表：调用方手里的对象后续改动不影响登记簿。 */
export function grantRole(sessionId: string, grant: RoleGrant): void {
  grants().set(sessionId, { ...grant });
}

export function revokeRole(sessionId: string): void {
  grants().delete(sessionId);
}

export function roleGrantOf(sessionId: string): RoleGrant | null {
  return grants().get(sessionId) ?? null;
}

/** claim 成功后由工具回调调用：把一次性核发的 ownerToken（连同 attemptId/
 *  generation）补到该会话已有的 grant 上。无 grant 时 no-op——授权的创建
 *  只属于 dispatcher（grantRole），工具层不能自授身份。 */
export function setGrantToken(
  sessionId: string,
  attemptId: string,
  ownerToken: string,
  generation?: number,
): void {
  const current = grants().get(sessionId);
  if (!current) return;
  grants().set(sessionId, {
    ...current,
    attemptId,
    ownerToken,
    ...(generation !== undefined ? { generation } : {}),
  });
}

/** dispatcher 单槽位判定（T7 用）：该工作区是否已有角色会话在场。
 *  裸授权即占槽——授予到领取之间（会话引导 + 读池）的窗口不允许第二个
 *  dispatcher 起会话双派发；凭证（attemptId）在场显然也占槽。会话结束由
 *  T6 revoke 释放槽位（anacron-lite 心跳下一拍自然补上）。 */
export function hasAnyActiveExecution(workspacePath: string): boolean {
  for (const grant of grants().values()) {
    if (grant.workspacePath === workspacePath) return true;
  }
  return false;
}
