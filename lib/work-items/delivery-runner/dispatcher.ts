// Phase-2 Task 7: DeliveryDispatcher——交付自动化的宿主心跳（HostJob，对照
// LoopKitSpawner 形态）：每 30s 一拍（首拍立即，timer unref），每拍对每个可用
// 工作区做三件事：
//
//   ① 超时清道夫：活动 delivery claim（listWorkItems + readClaim 扫描——与
//      role-session 结束钩子同一 scanActiveItemClaims 习语）按 claim.claimedAt
//      起算（裁定：执行上限从领取起算，lastSeenAt 只是续约心跳不重置上限，
//      spec §5.3「达到执行时限必须停止会话」）超过 budget.maxExecutionMinutes
//      → probeSession 仍活 → 定向 destroySession → recordInterruption(
//      "execution timeout")。记录幂等（destroy 触发的结束钩子也会竞写，先到者
//      清 claim 后到者 no-op）；会话已死（宿主重启遗留）→ 跳过 destroy 仍记录
//      ——否则陈旧 claim 会经 activeExecution 永久占死单槽位。清道夫 role 无关
//      （Phase-3 T4：developer claim 同样适用——claimedAt 起算不变，
//      recordInterruption 已随 ClaimState.role 泛化）。
//
//   ② 单槽位派发（Phase-3 T4：合并队列取首、按条目角色分派；Phase-4 T4：
//      verifier 为第三角色经同一分派——零机制变化，role 由池子投影自带）：
//      activeExecution（内存 role-grant 登记表 ∪ claim 扫描——跨角色共享单槽位）
//      在场 → 跳过；池子 ready 空 → 跳过；否则按 ready[0].role 起
//      launchRoleSession（fire-and-forget，catch 记日志——launch 的 grantRole
//      即时占槽，同 tick 内多余 ready 与下一拍都被 activeExecution 拦住，无双
//      派发窗口）。角色由条目所处阶段决定（pool 投影），dispatcher 只透传——
//      消除 T1 的过渡窗口（developer-ready 项不再被当 designer 起会话后领取即拒）。
//
//   ③ attention 催办/泊车（final-arch step-2 Task 5，2026-10-26，spec §8——
//      唯一人工待办队列的维护步）：collectAttention 投影（与 GET …/attention
//      路由共用装配器）后按 config.attention 阈值逐条处理——过泊车线未泊 →
//      writePaused(attention-parked) + delivery.parked；过催办线未催未泊 →
//      delivery.nudged。幂等由构造保证（事件只进 events.jsonl——不动 item.yaml
//      不 bump revision——下一拍投影翻位不再命中）；泊车复用 automation-paused
//      机制，人经既有 resumeAutomation 恢复。 attend 在派发之后（本轮新派发的
//      会话立即可见，不该当轮就被催/泊）。
//
// 装配在 background.ts（guard 链后的第二个 HostJob，懒加载——work-item 服务
// 不进 resident bundle）；关停序列 stopBackgroundSafely 同时停两个 job。
import type { HostJob } from "../../session-host/jobs.ts";
import { destroySession, probeSession } from "../../session-host/facade.ts";
import { discoverWorkspaces, readWorkspaceManifest } from "../../workspaces/service.ts";
import { assertAutomationCapable, readDeliveryRunnerConfig, DEFAULT_DELIVERY_RUNNER_CONFIG, type DeliveryRunnerConfig } from "./config.ts";
import { listDeliveryPool } from "./pool.ts";
import { hasAnyActiveExecution } from "./role-grants.ts";
import { launchRoleSession, scanActiveItemClaims } from "./role-session.ts";
import { recordInterruption } from "./claim.ts";
import { writePaused } from "./attempts.ts";
import { collectAttention } from "../attention.ts";
import { appendEvent, eventFor, readWorkItem } from "../service.ts";

const DISPATCHER_TICK_MS = 30_000;

export interface DispatcherDeps {
  discover?: typeof discoverWorkspaces;
  /** manifest 复验数据源（capability 门 = assertAutomationCapable：缺
   *  work-items/workflows 抛 → 该 workspace 整分支跳过）。 */
  readManifest?: typeof readWorkspaceManifest;
  readConfig?: typeof readDeliveryRunnerConfig;
  pool?: typeof listDeliveryPool;
  launch?: typeof launchRoleSession;
  /** 单槽位互斥（默认 hasAnyActiveExecution ∪ claim 扫描：内存登记或持久
   *  claim 任一在场都占槽——跨角色共享；授予到领取的窗口与宿主重启后的陈旧
   *  claim 都不允许双派发；后者由超时清道夫到时限后释放）。 */
  activeExecution?: (workspacePath: string) => boolean | Promise<boolean>;
  /** 活动领取扫描（清道夫数据源；默认 role-session 结束钩子同一扫描习语）。 */
  scanClaims?: typeof scanActiveItemClaims;
  probeSession?: typeof probeSession;
  destroySession?: typeof destroySession;
  recordInterruption?: typeof recordInterruption;
  /** attention 投影数据源（final-arch step-2 Task 5；默认 collectAttention——
   *  与 GET …/attention 路由共用同一装配器）。 */
  collectAttention?: typeof collectAttention;
  /** nudge/parked 事件追加（默认 service.appendEvent——只进 events.jsonl，
   *  不动 item.yaml、不 bump revision）。 */
  appendEvent?: typeof appendEvent;
  /** 泊车写标记（默认 attempts.writePaused——复用 automation-paused 机制，
   *  人经 resumeAutomation 恢复）。 */
  writePaused?: typeof writePaused;
  /** key → 工作项目录（默认 readWorkItem().path——泊车/事件都要 itemPath）。 */
  readItemPath?: (workspacePath: string, key: string) => Promise<string>;
  /** 默认 Date.now（ms——与 Date.parse(claim.claimedAt) 同单位）。 */
  now?: () => number;
}

export class DeliveryDispatcher implements HostJob {
  readonly id = "delivery-dispatcher";
  private timer?: ReturnType<typeof setInterval>;
  private readonly deps: Required<DispatcherDeps>;

  constructor(deps: DispatcherDeps = {}) {
    this.deps = {
      discover: deps.discover ?? discoverWorkspaces,
      readManifest: deps.readManifest ?? readWorkspaceManifest,
      readConfig: deps.readConfig ?? readDeliveryRunnerConfig,
      pool: deps.pool ?? listDeliveryPool,
      launch: deps.launch ?? launchRoleSession,
      activeExecution:
        deps.activeExecution
        ?? (async (workspacePath: string) => {
          if (hasAnyActiveExecution(workspacePath)) return true;
          return (await scanActiveItemClaims(workspacePath)).some((entry) => entry.claim !== null);
        }),
      scanClaims: deps.scanClaims ?? scanActiveItemClaims,
      probeSession: deps.probeSession ?? probeSession,
      destroySession: deps.destroySession ?? destroySession,
      recordInterruption: deps.recordInterruption ?? recordInterruption,
      collectAttention: deps.collectAttention ?? collectAttention,
      appendEvent: deps.appendEvent ?? appendEvent,
      writePaused: deps.writePaused ?? writePaused,
      readItemPath:
        deps.readItemPath
        ?? (async (workspacePath: string, key: string) => (await readWorkItem(workspacePath, key)).path),
      now: deps.now ?? Date.now,
    };
  }

  start(): void {
    if (this.timer) return;
    // tick 自身全程 try/catch 永不抛；外层 catch 是与 LoopKitSpawner 同型的双保险。
    const tick = () => void this.tick().catch((error) => console.error("[delivery-runner] dispatcher tick failed:", error));
    tick();
    this.timer = setInterval(tick, DISPATCHER_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 一拍：永不抛（discover 失败记日志返回；单 workspace 失败只跳过自己）。 */
  async tick(): Promise<void> {
    let workspaces: Awaited<ReturnType<typeof discoverWorkspaces>>;
    try {
      workspaces = await this.deps.discover();
    } catch (error) {
      console.error("[delivery-runner] dispatcher workspace discovery failed:", error);
      return;
    }
    for (const workspace of workspaces) {
      if (!workspace.available) continue;
      try {
        await this.tickWorkspace(workspace);
      } catch (error) {
        console.error(`[delivery-runner] dispatcher tick failed for ${workspace.id}:`, error);
      }
    }
  }

  private async tickWorkspace(workspace: { id: string; path: string }): Promise<void> {
    const config = await this.deps.readConfig(workspace.path);
    if (config === null || !config.enabled) return;
    // capability 复验（缺项/manifest 坏 → 抛 → tick 的 per-workspace catch 跳过）。
    assertAutomationCapable(await this.deps.readManifest(workspace.path));
    await this.reapTimedOutClaims(workspace.path, config);
    await this.dispatch(workspace, config);
    // ③ attention 催办/泊车（final-arch step-2 Task 5）——在派发之后（新派发
    // 的会话立即可见，不该当轮就被催/泊）。
    await this.attend(workspace, config);
  }

  private async reapTimedOutClaims(
    workspacePath: string,
    config: DeliveryRunnerConfig,
  ): Promise<void> {
    const timeoutMs = config.budget.maxExecutionMinutes * 60_000;
    const now = this.deps.now();
    for (const entry of await this.deps.scanClaims(workspacePath)) {
      const claim = entry.claim;
      if (claim === null) continue;
      if (!(now - Date.parse(claim.claimedAt) > timeoutMs)) continue;
      try {
        const live = await this.deps.probeSession(claim.sessionId);
        if (live !== null) this.deps.destroySession(claim.sessionId);
        await this.deps.recordInterruption(workspacePath, entry.key, claim.sessionId, "execution timeout");
      } catch (error) {
        console.error(`[delivery-runner] reap timed-out claim failed for ${entry.key}:`, error);
      }
    }
  }

  private async dispatch(
    workspace: { id: string; path: string },
    config: DeliveryRunnerConfig,
  ): Promise<void> {
    if (await Promise.resolve(this.deps.activeExecution(workspace.path))) return;
    const { ready } = await this.deps.pool(workspace.path);
    if (ready.length === 0) return;
    const entry = ready[0];
    // fire-and-forget：只领首条（单槽位互斥由 activeExecution 承担）；角色随
    // 条目流动（pool 投影自带 role——launchRoleSession 按它分派合同/授权）；
    // launch 时领取未发生，claim 传空对象（worktree 清单以领取返回为准）。
    // 上一轮 ask 的已答澄清随任务包进下一轮开场 prompt（final-arch step-2
    // Task 3——只透传已答条目：未答项本被池谓词 awaiting-answer 挡在 ready 外，
    // 此过滤是防御性钉子）。失败记日志不进 tick——下一拍池子复评自然重试
    //（失败预算在 claim/fail 服务侧管）。
    void this.deps.launch({
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      role: entry.role,
      task: { key: entry.key, title: entry.title },
      claim: {},
      clarifications: (entry.clarifications ?? []).filter((c) => c.answer !== undefined),
      config,
    }).catch((error) => {
      console.error(`[delivery-runner] ${entry.role} launch failed for ${entry.key}:`, error);
    });
  }

  /**
   * ③ attention 催办/泊车（final-arch step-2 Task 5，spec §8）：对人工待办投影
   *  逐条按 config.attention 阈值处理——
   *    ageDays ≥ parkAfterDays 且未泊 → writePaused(reason=attention-parked,
   *    count=0) + delivery.parked 事件（复用 automation-paused 机制，人经
   *    resumeAutomation 恢复）；
   *    否则 ageDays ≥ nudgeAfterDays 且未催未泊 → delivery.nudged 事件。
   *  幂等由构造保证：事件进 events.jsonl 后投影翻起 nudged/parked 位，下一拍
   *  不再命中；泊过的不催。单条失败记日志跳过（下拍重试），整体异常交 tick 的
   *  per-workspace catch——永不抛出 tick。
   */
  private async attend(
    workspace: { id: string; path: string },
    config: DeliveryRunnerConfig,
  ): Promise<void> {
    // 配置解析后 attention 必有（config.ts 缺块回填默认 3/7）；测试假 config
    // 可能缺块 → 同一默认兜底。
    const attention = config.attention ?? DEFAULT_DELIVERY_RUNNER_CONFIG.attention;
    const now = new Date(this.deps.now());
    for (const entry of await this.deps.collectAttention(workspace.path, now)) {
      try {
        if (!entry.parked && entry.ageDays >= attention.parkAfterDays) {
          const itemPath = await this.deps.readItemPath(workspace.path, entry.key);
          this.deps.writePaused(itemPath, {
            at: now.toISOString(),
            reason: "attention-parked",
            count: 0,
          });
          await this.deps.appendEvent(
            itemPath,
            eventFor("delivery.parked", "agent", undefined, {
              kind: entry.kind,
              ageDays: entry.ageDays,
              since: entry.since,
            }),
          );
        } else if (
          !entry.nudged && !entry.parked && entry.ageDays >= attention.nudgeAfterDays
        ) {
          const itemPath = await this.deps.readItemPath(workspace.path, entry.key);
          await this.deps.appendEvent(
            itemPath,
            eventFor("delivery.nudged", "agent", undefined, {
              kind: entry.kind,
              ageDays: entry.ageDays,
              since: entry.since,
            }),
          );
        }
      } catch (error) {
        console.error(`[delivery-runner] attend failed for ${entry.key} (${entry.kind}):`, error);
      }
    }
  }
}
