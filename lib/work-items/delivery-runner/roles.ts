// Seam-repositioning Task 1（2026-10-26）：交付角色词表单一事实源——合法值表、
// 类型与守卫。刻意零依赖（不 import 任何模块）：config.ts（roles 键校验）与
// pool.ts（角色投影）都要引它，词表若放任一侧即成 config ↔ pool 循环导入
// ——下沉为独立叶子模块才是两边共用的落点。
//
// final-arch step-3 Task 1（2026-10-26）：`reviewer` 进活值表（先审后跑）。
// Task 4（2026-10-26）：verifier 从活值表摘除——词表恒四活值
// （designer/developer/reviewer/release-preparer）；`verifier` 只活在
// LEGACY_DELIVERY_ROLES legacy 脚手架里。`AnyDeliveryRole` = 活值 ∪ legacy：
// 审计/澄清等**历史数据面**用它读旧记录（verifier 澄清、verifier attempt、
// 存量 verifier claim 永远可解析）；**新写入面**只认活值表（isDeliveryRole）。
export const DELIVERY_ROLES = [
  "designer",
  "developer",
  "reviewer",
  "release-preparer",
] as const;

/** 已退役角色词表（step-3：verifier → reviewer 先审后跑）。历史数据面的
 *  读守卫用 isAnyDeliveryRole；新写入面不用它。config 的 roles.verifier 键
 *  按 legacy 键跳过（不进 roles、告警一次）。 */
export const LEGACY_DELIVERY_ROLES = ["verifier"] as const;

export type DeliveryRole = (typeof DELIVERY_ROLES)[number];

export type LegacyDeliveryRole = (typeof LEGACY_DELIVERY_ROLES)[number];

/** 活值 ∪ legacy：历史数据（审计/澄清等落盘 JSON）的合法角色全集。 */
export type AnyDeliveryRole = DeliveryRole | LegacyDeliveryRole;

/** 活值守卫：新写入面的角色门（claim 输入、config roles 键等）。 */
export function isDeliveryRole(value: unknown): value is DeliveryRole {
  return typeof value === "string" && (DELIVERY_ROLES as readonly string[]).includes(value);
}

/** 历史数据守卫：读路径放宽到 legacy 词表——旧 verifier 记录永可解析。 */
export function isAnyDeliveryRole(value: unknown): value is AnyDeliveryRole {
  return (
    isDeliveryRole(value) ||
    (typeof value === "string" && (LEGACY_DELIVERY_ROLES as readonly string[]).includes(value))
  );
}
