/** pi-loop kit 心跳 spawner（design: docs/pi-loop-kit-design.md §5/§9）。
 *  一轮 = 一次性 AgentSession：开场合同（含 /skill: 展开）→ settle → 事后钩子。
 *  无 RUNS.jsonl、无 orchestrator 索引 — 运行记录 = STATE.md + workspace git log。 */
import { creationTimeoutSignal } from "../abort-race.ts";
import { reapOrphanedRoundProcesses } from "../loop/process-cleanup.ts";
import { startRpcSession, type AgentSessionWrapper } from "../rpc-manager.ts";
import type { LoopDeclaration } from "./loop-kit.ts";

/** 开场合同：LOOP.md 正文 + spawner 注入的硬规则（含会话 id，供 agent 自行挂
 *  conversations；D9 的事后钩子会兜底回填）。 */
export function buildRoundPrompt(declaration: LoopDeclaration, sessionId: string): string {
  return [
    `你是 loop「${declaration.loopName}」的一次性心跳轮（level ${declaration.level}）。本轮完全由文件协议驱动。`,
    "",
    declaration.body,
    "",
    "## 心跳轮规则（spawner 注入，优先于上文一切表述）",
    `1. 先读 loop-constraints.md、loop-budget.md、loop-ledger.json（宪法文件，你禁改），再读 ${declaration.dir}/STATE.md 恢复上下文。`,
    `2. 执行 /skill:${declaration.pattern} —— 合同本体在 SKILL.md，/skill: 展开会注入全文。`,
    `3. 你的会话 id（sessionId）：${sessionId} —— 需要把本会话挂到工作项 conversations 字段时用这个值。`,
    "4. 你的 cwd 是工作区根目录；所有相对路径相对这里解析。",
    `5. 纪律：L1 只读 + 只写 STATE.md/ledger，不动代码不做 git 操作；L2 允许 worktree + draft 分支，禁止合并主分支；宪法文件（LOOP.md 的 level/cron、loop-constraints.md、loop-budget.md）一律禁改。`,
    `6. 若发现 ${declaration.dir}/PAUSED 或根目录 loop-pause-all 存在，立即收尾退出本轮。`,
    `7. 结束前：更新 ${declaration.dir}/STATE.md（Last run / outcome / 复盘节必填）并按断路器规则追加 loop-ledger.json。`,
  ].join("\n");
}

/** 跑一条 prompt 并等它 settle（prompt_done）。超时 / prompt_error / destroy 均 reject。
 *  模式取自 v3 capturePrompt（lib/loop/pi-execution.ts）。 */
export function waitForRoundSettle(
  session: AgentSessionWrapper,
  prompt: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("kit round timed out")), timeoutMs);
    timer.unref?.();
    // destroy 先于任何 prompt_done/error 事件触发 — 立即 reject 而非干等超时。
    const offDestroy = session.onDestroy(() => finish(new Error("session destroyed")));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offDestroy?.();
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    const unsubscribe = session.onEvent((event: { type: string; errorMessage?: string }) => {
      if (event.type === "prompt_error") {
        finish(new Error(event.errorMessage ?? "kit round prompt failed"));
      }
      if (event.type === "prompt_done") finish();
    });
    void session.send({ type: "prompt", message: prompt }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export interface RoundDeps {
  starter?: typeof startRpcSession;
  reaper?: typeof reapOrphanedRoundProcesses;
}

/** 起一轮：一次性会话（cwd=workspace 根 → rpc-manager 自动装 workspace 扩展 +
 *  extraAgentDirs 重推导，REQ-0027）→ 命名 → 开场合同 → settle → 事后钩子。 */
export async function runKitRound(declaration: LoopDeclaration, deps: RoundDeps = {}): Promise<string> {
  const starter = deps.starter ?? startRpcSession;
  const reaper = deps.reaper ?? reapOrphanedRoundProcesses;
  const creation = creationTimeoutSignal(5 * 60_000, "kit round session creation timed out");
  let session: AgentSessionWrapper;
  let realSessionId: string;
  try {
    ({ session, realSessionId } = await starter("", "", declaration.workspacePath, undefined, {
      signal: creation.signal,
    }));
  } finally {
    creation.dispose();
  }
  const slot = new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    await session.send({ type: "set_session_name", name: `${declaration.loopName} · ${slot}` });
  } catch {
    /* 命名是装饰性的 — 会话照常跑 */
  }
  try {
    await waitForRoundSettle(session, buildRoundPrompt(declaration, realSessionId), declaration.maxMinutes * 60_000);
  } catch (error) {
    // 超时/销毁/prompt 错误：中止在飞 prompt，并收割它遗留的 bash/npm 进程树
    //（cwd 收敛到本 workspace — v3 收割经验的唯一保留点）。
    try {
      session.destroy();
    } catch {
      /* 已销毁 */
    }
    await reaper(declaration.workspacePath);
    throw error;
  }
  await settleRoundBookkeeping(declaration.workspacePath, realSessionId);
  return realSessionId;
}

/** 事后钩子（D9）—— Task 5 填充真体。 */
export async function settleRoundBookkeeping(_workspacePath: string, _sessionId: string): Promise<void> {}
