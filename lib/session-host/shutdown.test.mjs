import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

// 测试逃生口（与 background.test.mjs 同口径）：本文件不调用 ensureHostBooted，
// 但防患于未然 —— 任何路径都不得在测试进程里 boot 真实心跳/迁移守卫。
process.env.PI_TEST_NO_BACKGROUND = "1";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const background = await jiti.import("./background.ts");

test("shutdown writes interruption records only for running rounds, then destroys all", () => {
  // 可测缝：markRoundActive 登记 2 轮，1 个 running 1 个 idle —— buildShutdownPlan
  // 是 shutdown 内联逻辑的纯函数抽取（真实销毁循环 getAllRpcSessions 覆盖更广，
  // 这里只验证计划面：记录只给 running 轮、销毁覆盖全部登记轮）。
  background.markRoundActive("run-1", { loopName: "l", workspacePath: "/tmp/ws", dir: "/d", startedAt: Date.now() });
  background.markRoundActive("idle-1", { loopName: "l", workspacePath: "/tmp/ws", dir: "/d", startedAt: Date.now() });
  try {
    const plan = background.buildShutdownPlan(background.listActiveRounds(), ["run-1"]);
    assert.equal(plan.records.length, 1);
    assert.equal(plan.records[0].sessionId, "run-1");
    // 恢复门禁消费的字段（spec §5.4）：needsAttention=true 才阻塞该 loop。
    assert.equal(plan.records[0].needsAttention, true);
    assert.equal(plan.records[0].stopResult, "interrupted-on-shutdown");
    assert.deepEqual(plan.destroySessionIds.sort(), ["idle-1", "run-1"].sort());
  } finally {
    background.clearRoundMark("run-1");
    background.clearRoundMark("idle-1");
  }
});

// Phase-2 Task 6：ActiveRoundInfo 泛化——kind="delivery" 的角色执行登记复用同一张
// 表（markDeliveryExecutionActive），关停计划把两类分开：loop 轮照旧写 loop 中断
// 记录（M1 语义零变化），delivery 执行改写 claim 中断（经 claim.recordInterruption）。
test("shutdown plan separates delivery executions from loop rounds (loop semantics unchanged)", () => {
  background.markRoundActive("loop-1", { loopName: "l", workspacePath: "/tmp/ws", dir: "/d", startedAt: Date.now() });
  background.markDeliveryExecutionActive("del-1", { workspacePath: "/tmp/ws", itemKey: "REQ-0001" });
  try {
    const plan = background.buildShutdownPlan(background.listActiveRounds(), ["loop-1", "del-1"]);
    // loop 记录只给 loop 轮；delivery 执行不进 loop 记录
    assert.equal(plan.records.length, 1);
    assert.equal(plan.records[0].sessionId, "loop-1");
    assert.equal(plan.records[0].loopName, "l");
    // delivery 执行（running）→ claim 中断计划
    assert.deepEqual(plan.deliveryInterruptions, [
      { workspacePath: "/tmp/ws", itemKey: "REQ-0001", sessionId: "del-1" },
    ]);
    // 销毁面覆盖全部登记（两类都在）
    assert.deepEqual(plan.destroySessionIds.sort(), ["del-1", "loop-1"].sort());
    // idle（非 running）delivery 不写中断——与 loop 轮同口径
    const idle = background.buildShutdownPlan(background.listActiveRounds(), []);
    assert.equal(idle.records.length, 0);
    assert.equal(idle.deliveryInterruptions.length, 0);
    assert.deepEqual(idle.destroySessionIds.sort(), ["del-1", "loop-1"].sort());
    // 登记/清除成对（end hook 收尾用 clearDeliveryExecutionMark）
    background.clearDeliveryExecutionMark("del-1");
    const after = background.buildShutdownPlan(background.listActiveRounds(), ["loop-1"]);
    assert.equal(after.deliveryInterruptions.length, 0);
    assert.deepEqual(after.destroySessionIds, ["loop-1"]);
  } finally {
    background.clearRoundMark("loop-1");
    background.clearRoundMark("del-1");
  }
});

test("shutdown handler writes delivery interruptions through claim.recordInterruption (source contract)", async () => {
  const src = await readFile(new URL("./background.ts", import.meta.url), "utf8");
  // 动态 import claim 服务（关停路径不得把 work-item 服务拖进常驻 bundle）
  assert.match(src, /work-items\/delivery-runner\/claim\.ts/);
  assert.match(src, /recordInterruption\(plan\.workspacePath, plan\.itemKey, plan\.sessionId, "host shutdown"\)/);
});
