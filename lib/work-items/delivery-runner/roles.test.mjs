// final-arch step-3 Task 1（2026-10-26）：角色词表——reviewer 进活值表、
// verifier 进 legacy 脚手架（AnyDeliveryRole 双守卫）；零依赖叶子不 import。
// Task 4（2026-10-26）：verifier 正式退役——活值表恒四活值，verifier 只在
// LEGACY_DELIVERY_ROLES（历史数据面守卫 isAnyDeliveryRole 仍为真）。
// 词表单一事实源：config.ts（roles 键校验）、pool.ts（角色投影）、claim.ts
// （claim role 门）都从这里取——守卫语义在这里钉死，别处不再各自为政。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const roles = await jiti.import("./roles.ts");

test("DELIVERY_ROLES 四活值：verifier 已退役（reviewer 在列），序固定", () => {
  assert.deepEqual([...roles.DELIVERY_ROLES], [
    "designer",
    "developer",
    "reviewer",
    "release-preparer",
  ]);
});

test("LEGACY_DELIVERY_ROLES 只含 verifier；LegacyDeliveryRole/AnyDeliveryRole 脚手架在场", () => {
  assert.deepEqual([...roles.LEGACY_DELIVERY_ROLES], ["verifier"]);
  // 双守卫都在场且语义互补（活值表 vs 活值+legacy 全集）。
  assert.equal(typeof roles.isDeliveryRole, "function");
  assert.equal(typeof roles.isAnyDeliveryRole, "function");
});

test("isDeliveryRole：活值全真；verifier 已摘除（legacy 只留给历史数据面）；词表外为假", () => {
  for (const role of roles.DELIVERY_ROLES) {
    assert.equal(roles.isDeliveryRole(role), true, `${role} is active`);
  }
  // Task 4 起 verifier 不再是合法新写入值（config roles 键/claim 输入门）。
  assert.equal(roles.isDeliveryRole("verifier"), false, "verifier retired from the active vocabulary");
  assert.equal(roles.isDeliveryRole("boss"), false);
  assert.equal(roles.isDeliveryRole(""), false);
  assert.equal(roles.isDeliveryRole(null), false);
  assert.equal(roles.isDeliveryRole(undefined), false);
  assert.equal(roles.isDeliveryRole(42), false);
});

test("isAnyDeliveryRole：verifier（legacy）为真；词表外为假", () => {
  for (const role of roles.DELIVERY_ROLES) {
    assert.equal(roles.isAnyDeliveryRole(role), true, `${role} is any-role`);
  }
  // 历史数据（审计/澄清/存量 claim）的 verifier 值永可解析。
  assert.equal(roles.isAnyDeliveryRole("verifier"), true, "verifier is legacy-any");
  assert.equal(roles.isAnyDeliveryRole("boss"), false);
  assert.equal(roles.isAnyDeliveryRole(""), false);
  assert.equal(roles.isAnyDeliveryRole(null), false);
  assert.equal(roles.isAnyDeliveryRole(undefined), false);
});

test("零依赖叶子：roles.ts 不含任何 import（config/pool 共用，防循环导入）", async () => {
  const source = await readFile(new URL("./roles.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m, "no import statements in roles.ts");
  assert.doesNotMatch(source, /from\s+"/, "no from-imports in roles.ts");
});
