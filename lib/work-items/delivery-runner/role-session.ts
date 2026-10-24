// Phase-2 Task 6: designer 角色会话装配（spec 2026-10-24-phase-two §5.4）。
//
// dispatcher（T7）判定该起 designer 时调 launchDesignerSession：两步创建序
// （sessionId 到手 → grantRole → delivery 执行登记 → 命名 → 开场 prompt），
// 会话本身 fire-and-forget——不 await 轮结束，结束钩子（wrapper onDestroy）+
// 心跳续约兜底。开场合同（appendSystemPrompt）约束职责与硬规则；模型覆写来自
// Task 1 的 `.pi/delivery.yaml`（config.roles.designer.model）。
//
// 结束钩子（onDestroy）：claim 未清且 sessionId 匹配 → recordInterruption
// （"session ended with active claim"，5.1 的中断门禁据此挡住重领）；随后
// revokeRole + 清 delivery 执行登记 + 停心跳。幂等：claim 已清 / 他人会话 /
// 二次触发都只做无条件的 revoke/clear，不动记录。
//
// 心跳：20s 一拍续约 claim.lastSeenAt（heartbeatActiveClaim——sessionId 匹配
// 才写，不 bump revision、不产生事件、不进 git），interval unref 且随会话结束
// 清零。宿主关停路径另有兜底：background.ts 对 kind="delivery" 的登记写
// claim.recordInterruption("host shutdown")（与本钩子竞写安全——服务幂等）。
import type { CreateSessionInput, CreateSessionResult } from "../../session-host/facade.ts";
import { createSession, destroySession, sendCommand } from "../../session-host/facade.ts";
import { getRpcSession } from "../../session-host/registry.ts";
import {
  clearDeliveryExecutionMark,
  markDeliveryExecutionActive,
} from "../../session-host/background.ts";
import { heartbeatActiveClaim, recordInterruption } from "./claim.ts";
import { readClaim, type ClaimState } from "./attempts.ts";
import { grantRole, revokeRole } from "./role-grants.ts";
import { readWorkItem } from "../service.ts";
import type { DeliveryRunnerConfig } from "./config.ts";

/** designer 开场合同：职责 / 硬规则 / 结束条件（随 appendSystemPrompt 注入）。 */
export const DESIGNER_CONTRACT = (task: { key: string; title: string }) => `# designer 角色合同（${task.key}）

## 职责
把工作项 ${task.key}（${task.title}）的需求梳理成设计与验收条件：通读需求 README 与涉及仓库，产出可执行的 design.md（方案、影响面、步骤拆解）与逐条可核验的验收条件。

## 硬规则
1. 先 delivery_list_ready_tasks 看池子，再 delivery_claim_task 领取成功后才动手——领取失败/冲突不得绕过或强写。
2. 只允许操作本工作项：禁改工作区宪法（.pi/loop/constraints.md、.pi/loop/budget.md）、AGENTS.md、其他工作项与无关文件。
3. 设计与验收条件写好后经 delivery_submit_result 提交即结束本轮——不推进确认或后续阶段。
4. 无法推进（需求不清、外部阻塞）时用 delivery_fail_task 说明原因后结束；环境/依赖类阻塞带 blocked=true。
5. 设计与验收的确认由人完成（confirm-design 是人的动作），你没有确认动作。

## 结束条件
以下任一即结束本轮：submit 成功；fail 释放成功；池中无可领项。结束时不得留进行中的领取。`;

/** 开场指令：列出池子 → 领取最优先项 → 工作 → 提交。 */
function designerOpeningPrompt(task: { key: string; title: string }): string {
  return [
    "你是本工作区的交付 designer 会话，请开始本轮工作：",
    "1. 调用 delivery_list_ready_tasks 列出当前就绪池；",
    `2. 领取其中最优先的就绪项（本轮目标：${task.key} ${task.title}；若它已不可领取，按池内优先级领取当前最优先的就绪项）；`,
    "3. 依据领取返回的需求 README 与仓库清单梳理设计，撰写 design.md 与逐条可核验的验收条件；",
    "4. delivery_submit_result 提交后即结束本轮；无法推进时 delivery_fail_task 说明原因（环境/依赖阻塞带 blocked=true）后结束。",
  ].join("\n");
}

/** claim 心跳周期（spec §5.2 轻量续约）。 */
export const DESIGNER_HEARTBEAT_INTERVAL_MS = 20_000;

export interface LaunchDeps {
  createSession?: (input: CreateSessionInput) => Promise<CreateSessionResult>;
  sendCommand?: (sessionId: string, command: { type: string; [key: string]: unknown }) => Promise<unknown>;
  destroySession?: (sessionId: string) => void;
  /** 结束钩子注册（默认 getRpcSession(...).onDestroy）。返回 false = 会话已不在
   *  （武装前就消失了）——launch 立即走收尾而不是等一个永不到来的 destroy。 */
  onSessionDestroy?: (sessionId: string, cb: () => void | Promise<void>) => boolean;
  grantRole?: typeof grantRole;
  revokeRole?: typeof revokeRole;
  markActive?: typeof markDeliveryExecutionActive;
  clearActive?: typeof clearDeliveryExecutionMark;
  /** 读工作项目录与当前 claim（默认 readWorkItem + readClaim）；失败 = null。 */
  resolveItem?: (
    workspacePath: string,
    key: string,
  ) => Promise<{ path: string; claim: ClaimState | null } | null>;
  heartbeat?: typeof heartbeatActiveClaim;
  record?: typeof recordInterruption;
  now?: () => Date;
}

const defaultOnSessionDestroy = (sessionId: string, cb: () => void | Promise<void>): boolean => {
  const wrapper = getRpcSession(sessionId);
  if (!wrapper) return false;
  wrapper.onDestroy(() => void cb());
  return true;
};

const defaultResolveItem: NonNullable<LaunchDeps["resolveItem"]> = async (workspacePath, key) => {
  const detail = await readWorkItem(workspacePath, key);
  return { path: detail.path, claim: readClaim(detail.path) };
};

export interface LaunchDesignerOptions {
  workspaceId: string;
  workspacePath: string;
  task: { key: string; title: string };
  config: DeliveryRunnerConfig;
  deps?: LaunchDeps;
}

/**
 * 拉起一个 designer 角色会话并返回 sessionId（不 await 轮结束）。
 * 两步创建序：createSession 不带 command → grantRole → markDeliveryExecutionActive
 * → set_session_name → prompt；任何装配失败都会收尾（revoke/clear/destroy）后重抛。
 */
export async function launchDesignerSession(opts: LaunchDesignerOptions): Promise<string> {
  const d = {
    createSession: opts.deps?.createSession ?? createSession,
    sendCommand: opts.deps?.sendCommand ?? sendCommand,
    destroySession: opts.deps?.destroySession ?? destroySession,
    onSessionDestroy: opts.deps?.onSessionDestroy ?? defaultOnSessionDestroy,
    grantRole: opts.deps?.grantRole ?? grantRole,
    revokeRole: opts.deps?.revokeRole ?? revokeRole,
    markActive: opts.deps?.markActive ?? markDeliveryExecutionActive,
    clearActive: opts.deps?.clearActive ?? clearDeliveryExecutionMark,
    resolveItem: opts.deps?.resolveItem ?? defaultResolveItem,
    heartbeat: opts.deps?.heartbeat ?? heartbeatActiveClaim,
    record: opts.deps?.record ?? recordInterruption,
    now: opts.deps?.now ?? (() => new Date()),
  };
  const { workspacePath, task } = opts;
  const model = opts.config?.roles?.designer?.model;

  // 1. 建会话（不带 command——sessionId 到手才能 grant/登记/命名）；开场合同走
  //    appendSystemPrompt，模型覆写走 StartSessionOptions.model。
  const created = await d.createSession({
    cwd: workspacePath,
    appendSystemPrompt: DESIGNER_CONTRACT(task),
    ...(model ? { model } : {}),
  });
  const sessionId = created.sessionId;

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  // 结束钩子：幂等（单飞守卫），未清 claim 记中断，随后 revoke/clear/停心跳。
  let ended = false;
  const handleEnd = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    stopHeartbeat();
    let claim: ClaimState | null = null;
    try {
      claim = (await d.resolveItem(workspacePath, task.key))?.claim ?? null;
    } catch (error) {
      console.error(`[delivery-runner] read claim on session end failed for ${task.key}:`, error);
    }
    if (claim !== null && claim.sessionId === sessionId) {
      await d.record(workspacePath, task.key, sessionId, "session ended with active claim").catch((error) => {
        console.error(`[delivery-runner] record interruption failed for ${task.key}:`, error);
      });
    }
    d.revokeRole(sessionId);
    d.clearActive(sessionId);
  };

  try {
    // 2. 角色授权（delivery_* 工具的身份门）。
    d.grantRole(sessionId, { role: "designer", workspacePath });
    // 3. delivery 执行登记（宿主关停据此写 claim 中断）。
    d.markActive(sessionId, { workspacePath, itemKey: task.key });
    // 4. 命名（省略代次——generation 此刻未知，领取后才产生）。
    await d.sendCommand(sessionId, { type: "set_session_name", name: `designer · ${task.key}` });
  } catch (error) {
    // 装配失败：结束钩子可能尚未武装，显式收尾后销毁已建会话再抛。
    await handleEnd().catch(() => {});
    d.destroySession(sessionId);
    throw error;
  }

  // 6a. 结束钩子 + 心跳先于开场 prompt 武装——prompt 发送失败/会话在武装窗口内
  // 消失都由它们兜底。会话已不在（onSessionDestroy 返回 false）= 立即收尾。
  const registered = d.onSessionDestroy(sessionId, handleEnd);
  // 6b. 心跳续约：claim.sessionId 匹配才写 lastSeenAt（服务侧保证不 bump
  // revision/不产事件）；无 claim 的拍次是廉价 no-op。
  heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const item = await d.resolveItem(workspacePath, task.key);
        if (item !== null) await d.heartbeat(workspacePath, item.path, sessionId);
      } catch (error) {
        console.error(`[delivery-runner] claim heartbeat failed for ${task.key}:`, error);
      }
    })();
  }, DESIGNER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  if (!registered) {
    await handleEnd();
    return sessionId;
  }

  // 5. 开场指令。send 只等受理（fire-and-forget），轮结束由结束钩子兜底。
  try {
    await d.sendCommand(sessionId, { type: "prompt", message: designerOpeningPrompt(task) });
  } catch (error) {
    await handleEnd().catch(() => {});
    d.destroySession(sessionId);
    throw error;
  }
  return sessionId;
}
