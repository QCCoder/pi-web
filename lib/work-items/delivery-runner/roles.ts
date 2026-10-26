// Seam-repositioning Task 1（2026-10-26）：交付角色词表单一事实源——
// 四角色（designer/developer/verifier/release-preparer）的合法值表、类型与
// 守卫。刻意零依赖（不 import 任何模块）：config.ts（roles 四键校验）与
// pool.ts（角色投影）都要引它，词表若放任一侧即成 config ↔ pool 循环导入
// ——下沉为独立叶子模块才是两边共用的落点。
export const DELIVERY_ROLES = ["designer", "developer", "verifier", "release-preparer"] as const;

export type DeliveryRole = (typeof DELIVERY_ROLES)[number];

export function isDeliveryRole(value: unknown): value is DeliveryRole {
  return typeof value === "string" && (DELIVERY_ROLES as readonly string[]).includes(value);
}
