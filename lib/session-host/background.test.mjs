import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 测试逃生口（brief Step 2 注）：跳过迁移守卫与真实心跳。守卫尤其必须跳过 ——
// 开发机上常有活 daemon 监听 30142，否则测试进程会被 refuseIfLegacyDaemonAlive
// 直接 exit(1)。显式注入的假 spawner（createSpawner）不受此旗影响 —— 注入
// 本来就是给测试用的（见 background.ts 的 PI_TEST_NO_BACKGROUND 分支）。
process.env.PI_TEST_NO_BACKGROUND = "1";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const background = await jiti.import("./background.ts");

test("active round marks are add/list/clear", () => {
  background.markRoundActive("r1", { loopName: "dev-loop", workspacePath: "/tmp/ws", dir: "/tmp/ws/.pi/loops/dev-loop", startedAt: Date.now() });
  assert.equal(background.listActiveRounds().length >= 1, true);
  background.clearRoundMark("r1");
  assert.equal(background.listActiveRounds().some((r) => r.sessionId === "r1"), false);
});

test("ensureHostBooted is idempotent across repeated module loads", async () => {
  const jiti2 = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const b1 = await jiti2.import("./background.ts");
  const b2 = await jiti2.import("./background.ts");
  // moduleCache:false 两个独立模块实例 = 模拟 dev HMR 双实例。globalThis 守卫必须
  // 保证 spawner 只 start 一次、只挂一个定时器引用。
  const starts = [];
  const fakeSpawner = () => ({
    start() { starts.push("start"); },
    stop() {},
    timer: { fake: "loop-timer" },
  });
  b1.ensureHostBooted({ createSpawner: fakeSpawner });
  b2.ensureHostBooted({ createSpawner: fakeSpawner });  // 第二次必须 no-op：不得出现两个 spawner 定时器
  const g = globalThis;
  assert.ok(g.__piHostBooted === true);
  // spawner 经动态 import 异步启动 —— 轮询等 timer 落到 globalThis。
  const deadline = Date.now() + 5_000;
  while (g.__piLoopSpawnerTimer == null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(g.__piLoopSpawnerTimer != null);
  assert.equal(starts.length, 1);
});

test("PI_TEST_NO_BACKGROUND skips the default spawner (no real heartbeat in tests)", async () => {
  const g = globalThis;
  const prevBooted = g.__piHostBooted;
  const prevTimer = g.__piLoopSpawnerTimer;
  g.__piHostBooted = undefined; // 重置守卫，单独验证默认实现走测试逃生口
  try {
    const jiti3 = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const b3 = await jiti3.import("./background.ts");
    b3.ensureHostBooted(); // 默认实现 + PI_TEST_NO_BACKGROUND=1 → 不起任何 spawner
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(g.__piLoopSpawnerTimer, prevTimer); // 未被赋新值
  } finally {
    g.__piHostBooted = prevBooted;
  }
});
