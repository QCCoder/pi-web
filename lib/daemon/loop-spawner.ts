/** pi-loop kit 心跳 spawner（design: docs/pi-loop-kit-design.md §5/§9）。
 *  一轮 = 一次性 AgentSession：开场合同（含 /skill: 展开）→ settle → 事后钩子。
 *  无 RUNS.jsonl、无 orchestrator 索引 — 运行记录 = STATE.md + workspace git log。 */
import { creationTimeoutSignal } from "../abort-race.ts";
import { startRpcSession, type AgentSessionWrapper } from "./rpc-manager.ts";
import type { DaemonJob } from "./jobs.ts";
import { listWorkItems, readWorkItem, updateWorkItem } from "../work-items/service.ts";
import { discoverWorkspaces, readWorkspaceManifest } from "../workspaces/service.ts";
import { archiveSession } from "../session-archive.ts";
import { discoverKitLoops, isWorkspaceHalted, type LoopDeclaration } from "../../packages/pi-loop/protocol.ts";
import { runDueRound } from "../../packages/pi-loop/fire.ts";
import { updateRoundLock } from "../../packages/pi-loop/round-lock.ts";
import { buildRoundPrompt } from "../../packages/pi-loop/contract.ts";
import { reapOrphanedRoundProcesses } from "../../packages/pi-loop/reap.ts";
import { hostname } from "node:os";

/** 跑一条 prompt 并等它 settle（prompt_done）。超时 / prompt_error / destroy 均 reject。
 *  模式承自 v3 引擎的 capturePrompt（随 v3 拆除迁入）。 */
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
  /** D9 事后钩子注入点（默认真实现）—— 成功与失败路径都会被调（见 runKitRound）。 */
  bookkeeper?: typeof settleRoundBookkeeping;
  /** startRpcSession 解构出 realSessionId 后立即回调（先于命名/开场合同）——
   *  tick 借此把 sessionId 回填进 .round.lock（供 stop 路由用）。 */
  onSessionStart?: (sessionId: string) => void;
}

/** 起一轮：一次性会话（cwd=workspace 根 → rpc-manager 自动装 workspace 扩展；
 *  内置 subagent 的 profile 发现按 `<cwd>/.pi/agents/` 自带）→ 命名 → 开场合同 → settle → 事后钩子。 */
export async function runKitRound(declaration: LoopDeclaration, deps: RoundDeps = {}): Promise<string> {
  const starter = deps.starter ?? startRpcSession;
  const reaper = deps.reaper ?? reapOrphanedRoundProcesses;
  const bookkeeper = deps.bookkeeper ?? settleRoundBookkeeping;
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
  deps.onSessionStart?.(realSessionId);
  const slot = new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    await session.send({ type: "set_session_name", name: `${declaration.loopName} · ${slot}` });
  } catch {
    /* 命名是装饰性的 — 会话照常跑 */
  }
  try {
    await waitForRoundSettle(session, buildRoundPrompt(declaration, { sessionId: realSessionId }), declaration.maxMinutes * 60_000);
  } catch (error) {
    // 超时/销毁/prompt 错误：中止在飞 prompt，并收割它遗留的 bash/npm 进程树
    //（cwd 收敛到本 workspace — v3 收割经验的唯一保留点）。
    try {
      session.destroy();
    } catch {
      /* 已销毁 */
    }
    try {
      await reaper(declaration.workspacePath);
    } catch (reapError) {
      // 收割失败不得掩盖原始轮错误
      console.error("[loop-kit] orphan reap failed:", reapError);
    }
    throw error;
  } finally {
    // D9 事后钩子在成功与失败路径都要跑：失败轮的会话同样要归档（防会话列表
    // 污染）、盖过 loop.started/loop.gate 的工作项同样要回填 conversations ——
    // 事件已落盘，从盘上回填对超时轮是正确语义；settleRoundBookkeeping 永不抛。
    await bookkeeper(declaration.workspacePath, realSessionId);
  }
  return realSessionId;
}

export interface RoundWorkItemImpact {
  itemsToLink: Array<{ key: string; revision: number; conversations: string[] }>;
  hasPendingGate: boolean;
}

/** 扫活动工作项的 events.jsonl：哪些项在本轮会话上盖过事件、是否有待决 gate。 */
export async function inspectRoundImpact(workspacePath: string, sessionId: string): Promise<RoundWorkItemImpact> {
  const { items } = await listWorkItems(workspacePath);
  const itemsToLink: RoundWorkItemImpact["itemsToLink"] = [];
  let hasPendingGate = false;
  for (const item of items) {
    let detail: Awaited<ReturnType<typeof readWorkItem>>;
    try {
      detail = await readWorkItem(workspacePath, item.key);
    } catch {
      continue;
    }
    const mine = detail.events.filter((event) => event.conversationId === sessionId);
    if (mine.length === 0) continue;
    itemsToLink.push({ key: item.key, revision: detail.item.revision, conversations: detail.item.conversations });
    if (mine.some((event) => event.type.startsWith("loop.gate"))) hasPendingGate = true;
  }
  return { itemsToLink, hasPendingGate };
}

export interface BookkeepingDeps {
  manifestReader?: typeof readWorkspaceManifest;
  updater?: typeof updateWorkItem;
  archiver?: typeof archiveSession;
}

/** D9 事后钩子：回填 conversations（待决 gate 会话从工作项详情可「继续对话」），
 *  无待决 gate 则归档轮会话（防会话列表污染）。永不抛 — 清理不得破坏轮流程。 */
export async function settleRoundBookkeeping(
  workspacePath: string,
  sessionId: string,
  deps: BookkeepingDeps = {},
): Promise<void> {
  const manifestReader = deps.manifestReader ?? readWorkspaceManifest;
  const updater = deps.updater ?? updateWorkItem;
  const archiver = deps.archiver ?? archiveSession;
  let impact: RoundWorkItemImpact;
  try {
    impact = await inspectRoundImpact(workspacePath, sessionId);
  } catch (error) {
    console.error("[loop-kit] inspect round impact failed:", error);
    return;
  }
  if (impact.itemsToLink.length > 0) {
    try {
      const manifest = await manifestReader(workspacePath);
      for (const entry of impact.itemsToLink) {
        if (entry.conversations.includes(sessionId)) continue;
        try {
          await updater(manifest.id, entry.key, {
            conversations: [...entry.conversations, sessionId],
            expectedRevision: entry.revision,
          });
        } catch (error) {
          console.error(`[loop-kit] conversations backfill failed for ${entry.key}:`, error);
        }
      }
    } catch (error) {
      console.error("[loop-kit] manifest read failed, skipping backfill:", error);
    }
  }
  if (!impact.hasPendingGate) {
    await archiver(sessionId).catch((error: unknown) =>
      console.error("[loop-kit] round session archive failed:", error));
  }
}

// --- 心跳 DaemonJob（Task 6/10）------------------------------------------

const SPAWNER_TICK_MS = 30_000;

export interface SpawnerDeps {
  discover?: typeof discoverWorkspaces;
  discoverLoops?: typeof discoverKitLoops;
  halted?: typeof isWorkspaceHalted;
  runRound?: (declaration: LoopDeclaration, hooks?: { onSessionStart?: (sessionId: string) => void }) => Promise<string>;
  now?: () => Date;
}

/** 心跳 job（DaemonJob）：每 30s 扫已注册 workspace 的 loops/<loopName>/LOOP.md；
 *  due（.lastrun 补跑判定）+ .round.lock 跨宿主互斥 → 起一轮 —— fire 序列与
 *  beat 共用（pi-loop/fire.ts），多 loop 各自独立 due/锁，不再整 workspace 串行。 */
export class LoopKitSpawner implements DaemonJob {
  readonly id = "loop-kit-heartbeats";
  private timer?: ReturnType<typeof setInterval>;
  private readonly deps: Required<SpawnerDeps>;

  constructor(deps: SpawnerDeps = {}) {
    this.deps = {
      discover: deps.discover ?? discoverWorkspaces,
      discoverLoops: deps.discoverLoops ?? discoverKitLoops,
      halted: deps.halted ?? isWorkspaceHalted,
      runRound: deps.runRound ?? ((declaration, hooks) => runKitRound(declaration, hooks)),
      now: deps.now ?? (() => new Date()),
    };
  }

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error) => console.error("[loop-kit] spawner tick failed:", error));
    tick();
    this.timer = setInterval(tick, SPAWNER_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    for (const workspace of await this.deps.discover()) {
      if (!workspace.available) continue;
      if (await Promise.resolve(this.deps.halted(workspace.path))) continue;
      for (const declaration of await this.deps.discoverLoops(workspace.path)) {
        const holder = { pid: process.pid, host: hostname(), kind: "daemon" as const };
        try {
          await runDueRound(
            declaration,
            holder,
            async () => {
              await this.deps.runRound(declaration, {
                onSessionStart: (sessionId) => updateRoundLock(declaration.dir, { sessionId }),
              });
            },
            { now: this.deps.now },
          );
        } catch (error) {
          console.error(`[loop-kit] round failed for ${workspace.id}/${declaration.loopName}:`, error);
        }
      }
    }
  }
}
