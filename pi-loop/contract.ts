/** 开场合同组装（design: docs/pi-loop-host-design.md）。
 *  纯函数、无 daemon 依赖 —— daemon spawner 与 beat 宿主共用：
 *  - daemon 形态：传 { sessionId }（agent 自行挂 conversations；D9 事后钩子兜底回填）。
 *  - beat 形态：不传 sessionId —— 不输出会话 id 规则行，规则序号动态编排。
 *  - D13：ledger 路径为 per-loop（`${declaration.dir}/loop-ledger.json`）。
 *  - extraInstructions：附加规则行（`pi-loop run --item` 的「本轮优先处理 <KEY>」）。 */
import type { LoopDeclaration } from "./protocol.ts";

export function buildRoundPrompt(
  declaration: LoopDeclaration,
  opts: { sessionId?: string; extraInstructions?: string } = {},
): string {
  const rules: string[] = [
    `先读 loop-constraints.md、loop-budget.md、${declaration.dir}/loop-ledger.json（宪法文件，你禁改），再读 ${declaration.dir}/STATE.md 恢复上下文。`,
    `执行 /skill:${declaration.pattern} —— 合同本体在 SKILL.md，/skill: 展开会注入全文。`,
  ];
  if (opts.sessionId) {
    rules.push(`你的会话 id（sessionId）：${opts.sessionId} —— 需要把本会话挂到工作项 conversations 字段时用这个值。`);
  }
  rules.push(`你的 cwd 是工作区根目录；所有相对路径相对这里解析。`);
  rules.push(`纪律：L1 只读 + 只写 STATE.md/ledger，不动代码不做 git 操作；L2 允许 worktree + draft 分支，禁止合并主分支；宪法文件（LOOP.md 的 level/cron、loop-constraints.md、loop-budget.md）一律禁改。`);
  rules.push(`若发现 ${declaration.dir}/PAUSED 或根目录 loop-pause-all 存在，立即收尾退出本轮。`);
  rules.push(`结束前：更新 ${declaration.dir}/STATE.md（Last run / outcome / 复盘节必填）并按断路器规则追加 ${declaration.dir}/loop-ledger.json。`);
  if (opts.extraInstructions) rules.push(opts.extraInstructions);
  return [
    `你是 loop「${declaration.loopName}」的一次性心跳轮（level ${declaration.level}）。本轮完全由文件协议驱动。`,
    "",
    declaration.body,
    "",
    "## 心跳轮规则（宿主注入，优先于上文一切表述）",
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
  ].join("\n");
}
