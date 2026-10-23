import assert from "node:assert/strict";
import test from "node:test";
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
