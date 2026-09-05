import test from "node:test";
import assert from "node:assert/strict";
import { buildRoundPrompt } from "./contract.ts";

const DECL = { workspacePath: "/ws", loopName: "dev-loop", dir: "/ws/loops/dev-loop",
  pattern: "dev-loop", cron: "0 8 * * 1-5", timezone: "Asia/Shanghai",
  level: "L2", maxMinutes: 45, body: "# 合同指针\n1. 读宪法文件" };

test("daemon 形态：含 sessionId，不再注入已退役的宪法三件/ledger", () => {
  const prompt = buildRoundPrompt(DECL, { sessionId: "sess-123" });
  assert.ok(prompt.includes("/skill:dev-loop"));
  assert.ok(prompt.includes("sess-123"));
  assert.ok(prompt.includes(".lastrun") && prompt.includes(".round.lock")); // 宿主文件禁改条款（spec §6）
  assert.ok(prompt.includes("/ws/loops/dev-loop/STATE.md")); // 恢复上下文指针
  assert.ok(!prompt.includes("loop-constraints"));
  assert.ok(!prompt.includes("loop-budget"));
  assert.ok(!prompt.includes("loop-ledger")); // 2026-09-04 退役：不再要求读/追加 ledger
  assert.ok(prompt.includes("L2"));
});

test("beat 形态：无 sessionId 行、无 ledger 引用", () => {
  const prompt = buildRoundPrompt(DECL);
  assert.ok(!prompt.includes("sess-"));
  assert.ok(!prompt.includes("loop-ledger"));
  assert.ok(prompt.includes("PAUSED"));
  assert.ok(prompt.includes(".lastrun") && prompt.includes(".round.lock")); // 宿主文件禁改条款（spec §6）
});

test("extraInstructions 进入规则尾部", () => {
  const prompt = buildRoundPrompt(DECL, { extraInstructions: "本轮优先处理 REQ-0042（工作项绑定触发）" });
  assert.ok(prompt.includes("REQ-0042"));
});

test("manual 形态（web 运行按钮 / pi-loop run）：PAUSED 收尾规则不适用", () => {
  const prompt = buildRoundPrompt(DECL, { sessionId: "sess-m", manual: true });
  assert.ok(prompt.includes("手动触发"));
  assert.ok(!prompt.includes("立即收尾退出本轮")); // 严格收尾条款被替换
  assert.ok(prompt.includes("/ws/loops/dev-loop/PAUSED")); // 仍提示旗存在，但本轮不据此收尾
  assert.ok(prompt.includes("loop-pause-all"));
  assert.ok(prompt.includes("不删不改旗")); // 旗继续压自动心跳，手动轮不动旗
  assert.ok(prompt.includes("sess-m"));
});

test("非 manual（自动心跳）：保留严格 PAUSED 收尾规则", () => {
  const prompt = buildRoundPrompt(DECL, { sessionId: "sess-a" });
  assert.ok(prompt.includes("立即收尾退出本轮"));
  assert.ok(!prompt.includes("手动触发"));
});
