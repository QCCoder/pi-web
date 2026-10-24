// Phase-2 Task 4: ClaimService 领取事务（spec 2026-10-24-phase-two §5.2）。
// claim / submit / fail 全部在 withWorkspaceWriteLock 窗口内（M2 双层写锁，
// 与 pi-loop CLI 等外部写者互斥）；heartbeat 无业务锁（原子写回 + 归属校验）。
//
// 服务函数收 workspacePath（T4 裁定——与 T2 读取端一致的测试缝；路由层做
// id→path 转换）。事务内双检：Dispatcher 的池子发现只是提示，领取才是权威
// ——capability（manifest 复验 assertAutomationCapable）+ 配置 + 纯投影谓词
// （复用 projectDesignerPool，claim 与池子永不漂移）逐条复验后才流转。
//
// 写入顺序（崩溃窗口语义）：
//   产物先落盘、状态后改——design.md 播种 → runtime/ gitignore 接线 →
//   claim.json（先于 item.yaml：窗口内崩溃时 active-claim 标记已在场，池子
//   不投影 ready；即便 claim.json 也没写进去，status=in_progress 已被白名单
//   谓词排除——双派发窗口两头都堵死）→ item.yaml → 事件 → workspace git。
//
// 与 M2 的关系：
//   - design.md 播种复用 delivery.ts 的 DESIGN_SEED（同一模板串，两个动作
//     路径不得漂移）；design.md 写入不走 updateDesignContent——它自取
//     withWorkspaceWriteLock（不可重入，会自锁死）且签名绑 workspaceId/
//     expectedRevision，故按其实现同构锁内直写 + 自记 design_updated 事件。
//     designer 提交时设计必未确认（claim 谓词要求 phase=intake，而
//     designConfirmed 只在 design 之后阶段存在）——M2「已确认设计变更失效」
//     规则天然不触发；若人在领取窗口内抢先 confirm-design（路径上可能，
//     播种模板即非空 design.md），submit 以 Conflict 拒绝，不让确认证据
//     静默过期。
//   - item.yaml 的 delivery.lastRequest 是 M2 动作幂等指纹（action 枚举不
//     含 claim）——claim 的幂等指纹存 claim.json 的 lastRequest（T3 契约）。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commitWorkspaceChanges,
  readWorkspaceManifest,
  withWorkspaceWriteLock,
} from "../../workspaces/service.ts";
import { createUlid } from "../../workspaces/id.ts";
import { DESIGN_SEED } from "../delivery.ts";
import { contentDigest } from "../delivery-types.ts";
import {
  WorkItemConflictError,
  WorkItemValidationError,
} from "../errors.ts";
import {
  appendEvent,
  eventFor,
  readWorkItem,
  serializeWorkItem,
  writeAtomic,
} from "../service.ts";
import type { WorkItemDetail, WorkItemRecord } from "../types.ts";
import {
  clearClaim,
  clearPaused,
  countRecentFailures,
  hashOwnerToken,
  listAttempts,
  listPendingInterruptions,
  readClaim,
  readPaused,
  writeAttempt,
  writeClaim,
  writeFailureWindow,
  writePaused,
  type ClaimState,
} from "./attempts.ts";
import {
  assertAutomationCapable,
  DEFAULT_DELIVERY_RUNNER_CONFIG,
  readDeliveryRunnerConfig,
} from "./config.ts";
import { projectDesignerPool, type DesignerPoolContext } from "./pool.ts";

export interface ClaimGrant {
  attemptId: string;
  generation: number;
  /** 明文 ownerToken 只在首次授予时返回一次（进程内 role grant 持有）；
   *  幂等重放无法重建明文 → 空串，调用方（工具层）对 replayed 不再核发。 */
  ownerToken: string;
  key: string;
  item: WorkItemDetail;
}

export interface ClaimInput {
  workspacePath: string;
  key: string;
  sessionId: string;
  requestId: string;
}

export interface SubmitDesignInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  designContent: string;
  acceptanceCriteria: string[];
  requestId: string;
  conversationId?: string;
}

export interface FailInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  reason: string;
  blocked?: boolean;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkItemValidationError(`${field} is required`);
  }
  return value.trim();
}

function designPathFor(itemPath: string): string {
  return join(itemPath, "delivery", "artifacts", "design.md");
}

async function readDesignFile(designPath: string): Promise<string | undefined> {
  try {
    return await readFile(designPath, "utf8");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------ runtime/ gitignore wiring

const RUNTIME_GITIGNORE_ENTRY = ".pi/work-items/**/delivery/runtime/";

/** T3 carried ruling：claim 首写 runtime/ 时把该路径幂等接进工作区 .gitignore
 *  （文件缺失则创建，已含则不动；attempts/ 审计目录是事实源，不入 ignore）。
 *  读-改-写发生在 claim 事务锁内，无并发压力。 */
async function ensureRuntimeGitignore(workspacePath: string): Promise<void> {
  const gitignorePath = join(workspacePath, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }
  if (current.split("\n").some((line) => line.trim() === RUNTIME_GITIGNORE_ENTRY)) return;
  const prefix = current === ""
    ? ""
    : `${current}${current.endsWith("\n") ? "" : "\n"}`;
  await writeAtomic(
    gitignorePath,
    `${prefix}\n# delivery automation runtime state (advisory — claim.json / heartbeat)\n${RUNTIME_GITIGNORE_ENTRY}\n`,
  );
}

// -------------------------------------------------------- shared verification

/** submit/fail 共用的锁内校验：claim 存在 ∧ attemptId/generation/ownerToken
 *  匹配 ∧ requirementDigest 与领取时一致（README 被人改过 → 409 要求重领）。
 *  凭证/状态过期一律 Conflict——迟到会话不得改动新代状态。 */
async function requireActiveClaim(
  workspacePath: string,
  key: string,
  credentials: { attemptId: string; generation: number; ownerToken: string },
): Promise<{ detail: WorkItemDetail; claim: ClaimState }> {
  const detail = await readWorkItem(workspacePath, key);
  const claim = readClaim(detail.path);
  if (claim === null) {
    throw new WorkItemConflictError(`no active claim on ${key} — claim it first`);
  }
  if (claim.attemptId !== credentials.attemptId || claim.generation !== credentials.generation) {
    throw new WorkItemConflictError(
      `claim credentials are stale (active claim: ${claim.attemptId} generation ${claim.generation})`,
    );
  }
  if (claim.ownerTokenHash !== hashOwnerToken(credentials.ownerToken)) {
    throw new WorkItemConflictError("ownerToken does not match the active claim");
  }
  const requirementDigest = contentDigest(detail.content);
  if (claim.requirementDigest !== requirementDigest) {
    throw new WorkItemConflictError(
      "requirement changed since the claim (digest mismatch) — re-claim the item",
    );
  }
  return { detail, claim };
}

async function maxAttemptsFor(workspacePath: string): Promise<number> {
  const config = await readDeliveryRunnerConfig(workspacePath);
  return config?.budget.maxAttemptsPerInput
    ?? DEFAULT_DELIVERY_RUNNER_CONFIG.budget.maxAttemptsPerInput;
}

// ------------------------------------------------------------------- claim

/**
 * 领取事务：幂等重放（同 requestId 的活动 claim → 现 grant，ownerToken 空串）
 * → capability/配置/谓词双检 → 同一事务内完成阶段流转（phase intake→design、
 * design.md 播种、status=in_progress、claim.json 落盘、delivery.claimed 事件）。
 * 前置不满足 → WorkItemValidationError（reason 串）；他人活动 claim →
 * WorkItemConflictError。
 */
export async function claimDesignerTask(
  input: ClaimInput,
): Promise<{ grant: ClaimGrant; replayed: boolean }> {
  const requestId = requireText(input.requestId, "requestId");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const current = await readWorkItem(input.workspacePath, input.key);
    const itemPath = current.path;

    // 幂等重放：claim.json 的 lastRequest 命中同 requestId → 返回现 grant
    // （不 bump revision、不追加事件、不写第二 attempt；明文 token 无法重建）。
    const existingClaim = readClaim(itemPath);
    if (existingClaim?.lastRequest?.requestId === requestId) {
      return {
        grant: {
          attemptId: existingClaim.attemptId,
          generation: existingClaim.generation,
          ownerToken: "",
          key: input.key,
          item: current,
        },
        replayed: true,
      };
    }
    if (existingClaim !== null) {
      throw new WorkItemConflictError(
        `item ${input.key} already has an active claim (attempt ${existingClaim.attemptId}, session ${existingClaim.sessionId})`,
      );
    }

    // 事务内双检（spec §5.2 step 1）：capability（manifest）→ 配置 → 纯投影
    // 谓词逐条复验（复用 projectDesignerPool——claim 与池子读同一套规则）。
    const manifest = await readWorkspaceManifest(input.workspacePath);
    assertAutomationCapable(manifest);
    const config = await readDeliveryRunnerConfig(input.workspacePath);
    const maxAttemptsPerInput = config?.budget.maxAttemptsPerInput
      ?? DEFAULT_DELIVERY_RUNNER_CONFIG.budget.maxAttemptsPerInput;
    const requirementDigest = contentDigest(current.content);
    const attempts = await listAttempts(itemPath);
    // fix-round 裁定 #1/#2：预算 = 单项自最近 resume 以来的尾随连续失败
    // （与 pool 读取端同一 helper，口径由构造保证一致）。
    const failureCountByKey = new Map<string, number>([
      [input.key, await countRecentFailures(itemPath, requirementDigest, maxAttemptsPerInput)],
    ]);
    const ctx: DesignerPoolContext = {
      enabled: config?.enabled ?? false,
      // 活动 claim 已在上方以 Conflict 处理，此处必为空集。
      activeClaims: new Set(),
      pendingInterruptions: (await listPendingInterruptions(itemPath)).length > 0
        ? new Set([input.key])
        : new Set<string>(),
      paused: readPaused(itemPath) !== null ? new Set([input.key]) : new Set<string>(),
      failureCountByKey,
      maxAttemptsPerInput,
    };
    const [entry] = projectDesignerPool(
      [{
        key: current.item.key,
        title: current.item.title,
        priority: current.item.priority,
        status: current.item.status,
        phase: current.item.phase,
        archivedAt: current.item.archivedAt,
        requirementDigest,
        delivery: current.item.delivery ?? null,
      }],
      ctx,
    );
    if (!entry.ready) {
      throw new WorkItemValidationError(
        `delivery claim preconditions failed: ${entry.reasons.join(", ")}`,
      );
    }

    // generation 从 attempt 审计推导（spec 的 item.delivery.claim 字段不在 M2
    // schema 中；attempt 记录追加式永不删除，是 generation 的持久账本）。
    const generation = attempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1;
    const attemptId = createUlid();
    const ownerToken = randomUUID();
    const now = new Date();

    // 产物先落盘：design.md 播种（缺失才播——与 M2 start-design 同构）→
    // gitignore 接线 → claim.json（先于 item.yaml，见文件头崩溃窗口说明）。
    const designPath = designPathFor(itemPath);
    if ((await readDesignFile(designPath)) === undefined) {
      await writeAtomic(designPath, DESIGN_SEED(current.item.title));
    }
    await ensureRuntimeGitignore(input.workspacePath);
    writeClaim(itemPath, {
      attemptId,
      generation,
      role: "designer",
      sessionId: input.sessionId,
      claimedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      requirementDigest,
      ownerTokenHash: hashOwnerToken(ownerToken),
      lastRequest: { requestId, at: now.toISOString() },
    });

    // 状态后改：phase intake→design + status=in_progress + revision+1。
    const next: WorkItemRecord = structuredClone(current.item);
    next.phase = "design";
    next.status = "in_progress";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.claimed", "agent", undefined, {
        phase: { from: current.item.phase, to: next.phase },
        generation,
        attemptId,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery claim ${input.key}`);
    return {
      grant: {
        attemptId,
        generation,
        ownerToken,
        key: input.key,
        item: await readWorkItem(input.workspacePath, input.key),
      },
      replayed: false,
    };
  });
}

// ------------------------------------------------------------------ submit

/**
 * Designer 提交：写 design.md（正文 + 由 acceptanceCriteria 合成的「验收条件」
 * 节）→ 清 claim → attempt submitted → work_item.design_updated +
 * delivery.submitted 事件 → status 回 open（phase 保持 design 等人工
 * confirm-design——提交即结束，designer 不推进确认）。凭证过期 / 需求摘要
 * 变化 → Conflict（409）。
 */
export async function submitDesignerResult(input: SubmitDesignInput): Promise<WorkItemDetail> {
  requireText(input.requestId, "requestId");
  const designContent = requireText(input.designContent, "designContent");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) {
    throw new WorkItemValidationError("acceptanceCriteria must contain at least one criterion");
  }
  const criteria = input.acceptanceCriteria.map((criterion, index) =>
    requireText(criterion, `acceptanceCriteria[${index}]`));

  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
    );
    // 人在领取窗口内抢先 confirm-design：确认证据绑定的是当时的 design.md
    // 摘要，迟到的 designer 提交会让其静默过期——拒绝，让 claim 过期重领。
    if (current.item.delivery?.designConfirmed !== undefined) {
      throw new WorkItemConflictError(
        "design was confirmed while the claim was active — the claim is stale, re-claim after rework",
      );
    }
    const itemPath = current.path;
    const now = new Date();
    const designPath = designPathFor(itemPath);
    const previous = await readDesignFile(designPath);
    const content = `${designContent}\n\n## 验收条件\n${
      criteria.map((criterion) => `- [ ] ${criterion}\n`).join("")}`;

    // 产物先落盘，状态后改（同 claim 事务顺序纪律）。
    await writeAtomic(designPath, content);
    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "designer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "submitted",
      requirementDigest: claim.requirementDigest,
    });

    const next: WorkItemRecord = structuredClone(current.item);
    next.status = "open";
    // 会话自链接（服务层不变式）：带 conversationId 的动作把会话挂入 conversations。
    if (input.conversationId && !next.conversations.includes(input.conversationId)) {
      next.conversations = [...next.conversations, input.conversationId];
    }
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("work_item.design_updated", "agent", input.conversationId, {
        revision: next.revision,
        before_length: previous?.length ?? 0,
        after_length: content.length,
      }),
    );
    await appendEvent(
      itemPath,
      eventFor("delivery.submitted", "agent", input.conversationId, {
        attemptId: claim.attemptId,
        generation: claim.generation,
        criteriaCount: criteria.length,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery submit ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

// -------------------------------------------------------------------- fail

/**
 * Designer 失败：清 claim → attempt failed → delivery.attempt_failed 事件 →
 * 归还领取（phase design→intake；blocked=true → status=blocked，可解阻塞仍
 * 在白名单内可领）→ 失败预算（同 digest failed ≥ max → writePaused +
 * delivery.automation_paused，自动领取停等人显式 resume）。
 */
export async function failDesignerTask(input: FailInput): Promise<WorkItemDetail> {
  const reason = requireText(input.reason, "reason");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
    );
    const itemPath = current.path;
    const now = new Date();

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "designer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "failed",
      reason,
      requirementDigest: claim.requirementDigest,
    });

    const next: WorkItemRecord = structuredClone(current.item);
    // 失败即归还：designer 让出 claim 带来的 design 阶段（仅当还停在该阶段），
    // 项回到 intake 可再领——重试节流由失败预算（同 digest 计数）承担，不靠
    // 阶段卡死；blocked 是给人看的环境/依赖标志（白名单内仍可领）。
    if (next.phase === "design") next.phase = "intake";
    next.status = input.blocked === true ? "blocked" : "open";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.attempt_failed", "agent", undefined, {
        reason,
        blocked: input.blocked === true,
        attemptId: claim.attemptId,
        generation: claim.generation,
        revision: next.revision,
      }),
    );

    // 失败预算（fix-round 裁定 #1）：自最近 resume 以来的尾随连续失败（含刚
    // 记的这条）≥ max → 暂停自动领取，等人显式 resumeAutomation（resume 会写
    // 失败窗口重置连胜）。reason 如实说窗口口径。
    const maxAttemptsPerInput = await maxAttemptsFor(input.workspacePath);
    const failedCount = await countRecentFailures(itemPath, claim.requirementDigest);
    if (failedCount >= maxAttemptsPerInput) {
      writePaused(itemPath, {
        at: now.toISOString(),
        reason: `consecutive failures (${failedCount} since last resume)`,
        count: failedCount,
      });
      await appendEvent(
        itemPath,
        eventFor("delivery.automation_paused", "agent", undefined, {
          count: failedCount,
          maxAttemptsPerInput,
          attemptId: claim.attemptId,
          revision: next.revision,
        }),
      );
    }
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery fail ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

// --------------------------------------------------------------- heartbeat

/** 轻量续约（无业务锁）：claim.sessionId 匹配 → 原子写回 lastSeenAt
 *  （attemptId/generation 原样）→ true；无 claim / 他人会话 → false。
 *  不 bump revision、不产生事件、不进 git（spec §5.2）。 */
export async function heartbeatActiveClaim(
  workspacePath: string,
  itemPath: string,
  sessionId: string,
): Promise<boolean> {
  void workspacePath; // 签名对称保留（brief 契约）；续约只动 claim.json
  const claim = readClaim(itemPath);
  if (claim === null || claim.sessionId !== sessionId) return false;
  writeClaim(itemPath, { ...claim, lastSeenAt: new Date().toISOString() });
  return true;
}

// ------------------------------------------------------------ interruption

/** 关停/停止路径的中断记录（锁内）：claim.sessionId 匹配才记——清 claim、
 *  写 needsAttention 的 interrupted attempt（5.1 的中断门禁据此挡住新领取，
 *  人经「重新检查并恢复」解除）、追加 delivery.exec_interrupted 事件。
 *  claim 已清（幂等）或不匹配 → no-op。不进 workspace git：中断写发生在
 *  宿主关停序列（M1 先例——loop 中断记录纯文件写，不在关停路径上 spawn git）；
 *  events.jsonl 落盘即持久，下一次 workspace 提交自然收编。 */
export async function recordInterruption(
  workspacePath: string,
  key: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  await withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    const itemPath = current.path;
    const claim = readClaim(itemPath);
    if (claim === null || claim.sessionId !== sessionId) return;
    const now = new Date();
    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "designer",
      sessionId: claim.sessionId,
      workspacePath,
      key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "interrupted",
      reason,
      requirementDigest: claim.requirementDigest,
      needsAttention: true,
    });
    await appendEvent(
      itemPath,
      eventFor("delivery.exec_interrupted", "system", undefined, {
        reason,
        attemptId: claim.attemptId,
        generation: claim.generation,
      }),
    );
  });
}

// ------------------------------------------------------------------ resume

/** 显式恢复自动领取（人处理完阻塞后，actor=user）：清 automation-paused +
 *  写失败预算窗口（since=now——fix-round 裁定 #1：resume 之后只数新的失败，
 *  旧连胜不再挡）+ delivery.resumed 事件。未暂停 → Validation（路由层映射
 *  400——plan T8）。 */
export async function resumeAutomation(
  workspacePath: string,
  key: string,
): Promise<WorkItemDetail> {
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    const paused = readPaused(current.path);
    if (paused === null) {
      throw new WorkItemValidationError(`automation is not paused for ${key}`);
    }
    const now = new Date().toISOString();
    clearPaused(current.path);
    writeFailureWindow(current.path, now);
    await appendEvent(
      current.path,
      eventFor("delivery.resumed", "user", undefined, {
        pausedSince: paused.at,
        pausedCount: paused.count,
      }),
    );
    await commitWorkspaceChanges(workspacePath, `workspace: delivery resume ${key}`);
    return readWorkItem(workspacePath, key);
  });
}
