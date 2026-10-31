// final-arch step-5（final-fix）：巡逻措辞退役断言依赖 contract.ts 的巡逻化改写
// （用户 WIP，尚未提交）——随该提交一起落地；在那之前只在工作树运行（工作树
// 的 contract.ts 已含改写，本文件全绿）。HEAD 上没有本文件，故 HEAD 保持全绿。
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildRoundPrompt } = await jiti.import("./contract.ts");
// 与 contract.test.mjs 同一本地 fixture（DECL 是测试装置，不是协议导出）。
const DECL = { workspacePath: "/ws", loopName: "dev-loop", dir: "/ws/loops/dev-loop",
  pattern: "dev-loop", cron: "0 8 * * 1-5", timezone: "Asia/Shanghai",
  level: "L2", maxMinutes: 45, body: "# 合同指针\n1. 读宪法文件" };

test("patrol 轮合同：退役编排词不再注入（Last run 叙事、无复盘节、无 dev-loop 流水线）", () => {
  for (const opts of [{ sessionId: "sess-p" }, { sessionId: "sess-p", manual: true }]) {
    const prompt = buildRoundPrompt(DECL, opts);
    assert.ok(prompt.includes("Last run"));
    assert.ok(!prompt.includes("复盘节")); // 复盘节已随 STATE 编排退役
    assert.ok(!prompt.includes("chandao")); // dev-loop 编排流水线叙事已退役（手动轮也不注入）
  }
});
