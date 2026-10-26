import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  commitWorkspaceChanges,
  getWorkspace,
  withWorkspaceWriteLock,
} from "../workspaces/service.ts";
import {
  candidatesDigest,
  contentDigest,
  type DeliveryAction,
  type DeliveryCandidate,
  type DeliveryMetadata,
} from "./delivery-types.ts";
// legalDeliveryActions moved to the client-safe pure module (M2 T9); the
// re-export keeps this module's public surface (tests, server consumers).
export { legalDeliveryActions } from "./legal-actions.ts";
// stages 配置读取（final-arch step-4：record-release 验收门）。方向安全无环：
// config.ts 只引 ../service.ts / ../errors.ts / ./roles.ts，绝不引本模块。
import { readDeliveryRunnerConfig } from "./delivery-runner/config.ts";
import {
  WorkItemConflictError,
  WorkItemNotFoundError,
  WorkItemValidationError,
} from "./errors.ts";
import {
  appendEvent,
  eventFor,
  readWorkItem,
  serializeWorkItem,
  writeAtomic,
} from "./service.ts";
import type {
  WorkItemActor,
  WorkItemDetail,
  WorkItemPhase,
  WorkItemRecord,
  WorkItemStatus,
} from "./types.ts";

/** Standard delivery flow (M2, spec §6–§7): pure transition planning +
 *  the locked apply orchestration. planDeliveryTransition is PURE (no fs);
 *  applyDeliveryAction owns locking, design.md seeding and record writes. */

export interface DeliveryTransitionPlan {
  phase: WorkItemPhase;
  status?: WorkItemStatus;
  delivery: DeliveryMetadata;
  eventType: string;
  eventData: Record<string, unknown>;
  /** start-design only: the seed template written by apply when design.md
   *  does not exist yet. */
  designContent?: string;
}

/** Content digests computed by applyDeliveryAction (real README/design.md
 *  bytes); plan stays pure and consumes them (controller Ruling 4). */
export interface DeliveryDigests {
  requirement?: string;
  design?: string;
}

export interface DeliveryActionInput {
  workspaceId: string;
  key: string;
  action: DeliveryAction;
  expectedRevision: number;
  /** Idempotency key (spec §9): a non-empty string. Replaying the same
   *  requestId+action returns the current state without re-applying. */
  requestId: string;
  actor?: "user";
  conversationId?: string;
  /** Action parameters: candidates/checks/version/notes/rollback/reason/releaseNotes. */
  payload?: Record<string, unknown>;
}

export interface DeliveryActionOutcome {
  detail: WorkItemDetail;
  /** requestId hit → the change was NOT replayed, current state returned. */
  replayed: boolean;
}

export interface UpdateDesignContentInput {
  expectedRevision: number;
  content: string;
  actor?: WorkItemActor;
  conversationId?: string;
}

const DELIVERY_ACTION_SET: ReadonlySet<string> = new Set([
  "start-design",
  "confirm-design",
  "start-development",
  "submit-verification",
  "record-verification",
  "prepare-release",
  "record-acceptance",
  "record-release",
  "rework",
  "block",
  "unblock",
  "cancel",
  // 词表与路由 slug 门同源（delivery-types DELIVERY_ACTIONS）；流转 case 见
  // switch 内 answer-clarification（final-arch step-2 Task 4 起实现）。
  "answer-clarification",
]);

/** Display-only actions that stay legal on a released baseline (spec §7.3). */
const RELEASED_ALLOWED_ACTIONS: ReadonlySet<DeliveryAction> = new Set([
  "block",
  "unblock",
  "cancel",
]);

/** design.md 播种模板（M2 start-design 与 Phase-2 领取事务共用同一串——
 *  claim.ts 的 designer 播种不得与人工动作路径漂移出两个模板）。 */
export const DESIGN_SEED = (title: string): string =>
  `# 设计：${title}\n\n## 方案\n\n## 验收条件\n- [ ] \n`;

/** 返工目标词（final-arch step-3 T2）：implementation = 打回开发；design = 打回设计。 */
export type ReworkTarget = "implementation" | "design";

/**
 * 共享返工过渡（final-arch step-3 T2——「回退 + 清全部下游证据」的唯一实现，
 * 不得存在第二份「清什么」清单）：返回调用方需施加的 {phase, status, delivery}
 * （纯函数——不改 next：delivery.ts 的 case 是纯 plan 组装，claim.ts 的
 * verifier 失败路径 / reviewer 打回由调用方 structuredClone 后施加）。下游证据
 * = designConfirmed / candidates / verification / acceptance / releasePlan——
 * 必须重新挣得（acceptance 为 final-arch step-4 增补：验收随候选集失效）；
 * review 判定刻意保留（人要看为什么打回），released 基线本就拒绝 rework。
 *
 * 落点（两处调用现状不同，最小参数化——各自现状由测试钉死）：
 *  - status 由调用方给：M2 人工 rework 落 in_progress（人工接手继续）；
 *    claim 侧 agent rework（verifier 失败 / reviewer 打回）落 open（回队列可领）。
 *  - target "design" → phase "design"；target "implementation" → 缺省落
 *    ready_for_implementation（developer 可领阶段——agent 侧语义）；M2 人工
 *    路径显式传 implementationPhase: "implementation"（历史语义——人工 rework
 *    直接落 implementation 阶段，delivery.test.mjs 钉死）。
 */
export function reworkTransition(
  next: WorkItemRecord,
  target: ReworkTarget,
  status: WorkItemStatus,
  implementationPhase: "implementation" | "ready_for_implementation" = "ready_for_implementation",
): { phase: WorkItemPhase; status: WorkItemStatus; delivery: DeliveryMetadata } {
  const base = next.delivery;
  if (base === undefined || base === null) {
    throw new WorkItemValidationError("rework requires a managed item (delivery block missing)");
  }
  return {
    phase: target === "design" ? "design" : implementationPhase,
    status,
    delivery: {
      ...base,
      designConfirmed: undefined,
      candidates: undefined,
      verification: undefined,
      acceptance: undefined,
      releasePlan: undefined,
    },
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkItemValidationError(`${field} is required`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireText(value, field);
}

function requireCandidates(value: unknown): DeliveryCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkItemValidationError(
      "candidates must contain at least one candidate ({ repositoryId, commit })",
    );
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WorkItemValidationError(
        `candidates[${index}] must be an object with repositoryId and commit`,
      );
    }
    const record = entry as Record<string, unknown>;
    return {
      repositoryId: requireText(record.repositoryId, `candidates[${index}].repositoryId`),
      commit: requireText(record.commit, `candidates[${index}].commit`),
    };
  });
}

type VerificationCheck = {
  name: string;
  outcome: "passed" | "failed" | "unverified";
  note?: string;
};

function requireChecks(value: unknown): VerificationCheck[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkItemValidationError("checks must contain at least one check");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WorkItemValidationError(`checks[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const outcome = record.outcome;
    if (outcome !== "passed" && outcome !== "failed" && outcome !== "unverified") {
      throw new WorkItemValidationError(
        `checks[${index}].outcome must be one of: passed, failed, unverified`,
      );
    }
    const note = optionalText(record.note, `checks[${index}].note`);
    return {
      name: requireText(record.name, `checks[${index}].name`),
      outcome,
      ...(note !== undefined ? { note } : {}),
    };
  });
}

function requirePhase(item: WorkItemRecord, action: DeliveryAction, phase: WorkItemPhase): void {
  if (item.phase !== phase) {
    throw new WorkItemValidationError(
      `${action} requires phase "${phase}" (current phase: "${item.phase}")`,
    );
  }
}

function requireReworkPhase(item: WorkItemRecord): void {
  const allowed: ReadonlySet<WorkItemPhase> = new Set([
    "ready_for_implementation",
    "implementation",
    "verification",
    "release_ready",
  ]);
  if (!allowed.has(item.phase)) {
    throw new WorkItemValidationError(
      `rework requires a post-design phase (current phase: "${item.phase}")`,
    );
  }
}

/** Pure transition planning. Illegal actions / missing evidence throw
 *  WorkItemValidationError (HTTP 400/422 via web.ts). Never touches the fs:
 *  README/design.md digests arrive via `digests`, computed by
 *  applyDeliveryAction. Workspace-config-dependent gates arrive via `options`
 *  (same injection idiom as digests — the plan stays pure and config-free;
 *  final-arch step-4: acceptanceRequired gates record-release). */
export function planDeliveryTransition(
  item: WorkItemRecord,
  action: DeliveryAction,
  payload: Record<string, unknown>,
  now: Date,
  digests?: DeliveryDigests,
  options?: { acceptanceRequired?: boolean },
): DeliveryTransitionPlan {
  if (!DELIVERY_ACTION_SET.has(action)) {
    throw new WorkItemValidationError(`Unknown delivery action: ${String(action)}`);
  }
  if (item.delivery?.protocolVersion !== 1) {
    throw new WorkItemValidationError("Standard delivery flow is not enabled on this item");
  }
  if (item.phase === "released" && !RELEASED_ALLOWED_ACTIONS.has(action)) {
    throw new WorkItemValidationError("已发布基线冻结，请创建关联后续项 (released baseline is frozen)");
  }
  const base: DeliveryMetadata = structuredClone(item.delivery);
  const at = now.toISOString();
  switch (action) {
    case "start-design": {
      requirePhase(item, action, "intake");
      return {
        phase: "design",
        status: "in_progress",
        delivery: base,
        eventType: "delivery.start-design",
        eventData: { phase: "design" },
        designContent: DESIGN_SEED(item.title),
      };
    }
    case "confirm-design": {
      requirePhase(item, action, "design");
      // digests.design is present only when design.md exists and is non-empty
      // (apply computes it from the real bytes).
      if (!digests?.design) {
        throw new WorkItemValidationError("先编写设计内容与验收条件");
      }
      if (!digests.requirement) {
        throw new WorkItemValidationError("requirement digest is required");
      }
      const designConfirmed = {
        at,
        actor: "user" as const,
        requirementDigest: digests.requirement,
        designDigest: digests.design,
      };
      // status 显式归一 "open"（final-arch step-4 Task 1，M2 死角修复）：人工
      // rework target=design 落 in_progress，plan 此前不写 status 会原样保留——
      // 项进了 developer 可领阶段却永远无法被 LLM 角色领取（领取谓词只要 open）。
      // 设计确认即设计阶段收工 → 回队列 open。
      return {
        phase: "ready_for_implementation",
        status: "open",
        delivery: { ...base, designConfirmed },
        eventType: "delivery.confirm-design",
        eventData: {
          phase: "ready_for_implementation",
          requirementDigest: digests.requirement,
          designDigest: digests.design,
        },
      };
    }
    case "start-development": {
      requirePhase(item, action, "ready_for_implementation");
      return {
        phase: "implementation",
        status: "in_progress",
        delivery: base,
        eventType: "delivery.start-development",
        eventData: { phase: "implementation" },
      };
    }
    case "submit-verification": {
      requirePhase(item, action, "implementation");
      const candidates = requireCandidates(payload.candidates);
      return {
        phase: "verification",
        // A previously recorded pass must not survive a new submission.
        delivery: { ...base, candidates, verification: undefined },
        eventType: "delivery.submit-verification",
        eventData: { phase: "verification", candidates },
      };
    }
    case "record-verification": {
      requirePhase(item, action, "verification");
      const checks = requireChecks(payload.checks);
      if (!checks.every((check) => check.outcome === "passed")) {
        throw new WorkItemValidationError("验证未通过：存在未通过的检查项，请返工（rework）");
      }
      if (!base.candidates || base.candidates.length === 0) {
        throw new WorkItemValidationError("no candidates submitted — submit-verification first");
      }
      if (!digests?.requirement) {
        throw new WorkItemValidationError("requirement digest is required");
      }
      const verification = {
        at,
        actor: "user" as const,
        requirementDigest: digests.requirement,
        candidateDigest: candidatesDigest(base.candidates),
        checks,
      };
      return {
        phase: "release_ready",
        delivery: { ...base, verification },
        eventType: "delivery.record-verification",
        eventData: { phase: "release_ready", checks },
      };
    }
    case "prepare-release": {
      requirePhase(item, action, "release_ready");
      const notes = optionalText(payload.notes, "notes");
      const rollback = optionalText(payload.rollback, "rollback");
      const delivery = notes === undefined && rollback === undefined
        ? base
        : {
          ...base,
          releasePlan: {
            ...(notes !== undefined ? { notes } : {}),
            ...(rollback !== undefined ? { rollback } : {}),
          },
        };
      return {
        phase: "release_ready",
        delivery,
        eventType: "delivery.prepare-release",
        eventData: {
          phase: "release_ready",
          ...(notes !== undefined ? { notes } : {}),
          ...(rollback !== undefined ? { rollback } : {}),
        },
      };
    }
    // 人工验收（final-arch step-4 Task 3）：release_ready 原地记账——phase/status
    // 一概不动（prepare-release 同款），只是把验收记录（notes + 当前候选摘要）
    // 落进 delivery.acceptance。fail 不是动作——不通过走 rework（重开下游）；
    // 重登记 = 覆写（last write wins，同 verification）。摘要绑定当前候选集：
    // 候选换过则记录失准（record-release 的验收门拒之，attention 的 acceptance
    // 待办重现）。与 confirm-design / record-release 同款「人的手」，刻意不做
    // LLM 工具；released 基线冻结（不在 RELEASED_ALLOWED_ACTIONS）。
    case "record-acceptance": {
      requirePhase(item, action, "release_ready");
      const notes = requireText(payload.notes, "notes");
      if (!base.candidates || base.candidates.length === 0) {
        throw new WorkItemValidationError("no candidates submitted — submit-verification first");
      }
      const candidateDigest = candidatesDigest(base.candidates);
      return {
        phase: "release_ready",
        delivery: { ...base, acceptance: { notes, candidateDigest, at } },
        eventType: "delivery.accepted",
        eventData: { phase: "release_ready", candidateDigest },
      };
    }
    case "record-release": {
      requirePhase(item, action, "release_ready");
      const version = requireText(payload.version, "version");
      if (!base.candidates || base.candidates.length === 0) {
        throw new WorkItemValidationError("no candidates submitted — submit-verification first");
      }
      // 验收门（final-arch step-4）：workspace 开了 stages.acceptance 后，放行
      // 必须先有人工验收记录且其摘要与当前候选集绑定（候选换过 → 记录失准 →
      // 拒）。开关未开（缺省）行为不变。plan 是纯函数——开关由 apply 读
      // workspace config 后经 options 注入（与 digests 同款）。
      if (options?.acceptanceRequired === true) {
        const acceptance = base.acceptance;
        if (!acceptance || acceptance.candidateDigest !== candidatesDigest(base.candidates)) {
          throw new WorkItemValidationError("先完成验收（record-acceptance）");
        }
      }
      const notes = optionalText(payload.notes, "notes")
        ?? optionalText(payload.releaseNotes, "releaseNotes");
      const rollback = optionalText(payload.rollback, "rollback");
      const release = {
        at,
        actor: "user" as const,
        version,
        candidates: structuredClone(base.candidates),
        ...(notes !== undefined ? { notes } : {}),
        ...(rollback !== undefined ? { rollback } : {}),
      };
      return {
        phase: "released",
        status: "done",
        delivery: { ...base, release },
        eventType: "delivery.record-release",
        eventData: { phase: "released", version },
      };
    }
    case "rework": {
      requireReworkPhase(item);
      const reason = requireText(payload.reason, "reason");
      const target = payload.target === undefined || payload.target === "implementation"
        ? "implementation"
        : payload.target === "design"
          ? "design"
          : undefined;
      if (target === undefined) {
        throw new WorkItemValidationError('rework target must be "design" or "implementation"');
      }
      // Rewinding invalidates ALL downstream evidence (design confirmation,
      // candidates, verification) — it must be re-earned on the next pass.
      // 清单归共享 reworkTransition（final-arch step-3 T2 唯一实现）；M2 人工
      // 落点：implementation 阶段 + in_progress（历史语义，测试钉死）。
      const transition = reworkTransition(item, target, "in_progress", "implementation");
      return {
        phase: transition.phase,
        status: transition.status,
        delivery: transition.delivery,
        eventType: "delivery.rework",
        eventData: { phase: target, reason, target },
      };
    }
    case "block": {
      const reason = requireText(payload.reason, "reason");
      return {
        phase: item.phase,
        status: "blocked",
        delivery: base,
        eventType: "delivery.block",
        eventData: { phase: item.phase, reason },
      };
    }
    case "unblock": {
      if (item.status !== "blocked") {
        throw new WorkItemValidationError("item is not blocked");
      }
      return {
        phase: item.phase,
        // Released baseline: block is a display/attention flag — unblock must
        // return the frozen baseline to its terminal status "done" (not
        // in_progress, which no other writer could repair on a managed item).
        status: item.phase === "released" ? "done" : "in_progress",
        delivery: base,
        eventType: "delivery.unblock",
        eventData: { phase: item.phase },
      };
    }
    case "cancel": {
      const reason = optionalText(payload.reason, "reason");
      return {
        phase: item.phase,
        status: "cancelled",
        delivery: base,
        eventType: "delivery.cancel",
        eventData: { phase: item.phase, ...(reason !== undefined ? { reason } : {}) },
      };
    }
    // 人工答复（final-arch step-2 Task 4）：与 confirm-design / record-release
    // 同款「人的手」，刻意不做 LLM 工具。phase/status 一概不动（答复只是补全
    // 输入——池谓词 awaiting-answer 解除后同阶段重新可领）；答案不可变（改主意
    // 是 agent 的新问题，不是改写历史条目）。
    case "answer-clarification": {
      const clarificationId = requireText(payload.clarificationId, "clarificationId");
      const clarifications = base.clarifications ?? [];
      const entry = clarifications.find((candidate) => candidate.id === clarificationId);
      if (entry === undefined) {
        throw new WorkItemValidationError(`clarification not found: ${clarificationId}`);
      }
      if (entry.answer !== undefined) {
        throw new WorkItemConflictError(`clarification already answered: ${clarificationId}`);
      }
      const answer = requireText(payload.answer, "answer");
      return {
        phase: item.phase,
        delivery: {
          ...base,
          clarifications: clarifications.map((candidate) =>
            candidate.id === clarificationId
              ? { ...candidate, answer, answeredAt: at }
              : candidate),
        },
        eventType: "delivery.answered",
        eventData: { clarificationId, phase: item.phase },
      };
    }
    // 词表与实现解耦的保险（controller ruling）：进词表但流转 case 未实现的
    // slug 必须是干净 400，而非 undefined 返回静默产出坏 plan。
    default:
      throw new WorkItemValidationError(`Unknown delivery action: ${String(action)}`);
  }
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

/** Apply one delivery action under the workspace write lock. Idempotent on
 *  requestId+action (returns the current detail, replayed: true, without
 *  bumping the revision or appending events). */
export async function applyDeliveryAction(input: DeliveryActionInput): Promise<DeliveryActionOutcome> {
  if (!input.requestId || typeof input.requestId !== "string") {
    throw new WorkItemValidationError("requestId is required");
  }
  const { path: workspacePath } = await getWorkspace(input.workspaceId);
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, input.key);
    // 幂等重放：同 requestId+action 直接返回现态（不 bump 不追加）
    if (current.item.delivery?.lastRequest?.requestId === input.requestId
      && current.item.delivery.lastRequest.action === input.action) {
      return { detail: current, replayed: true };
    }
    if (input.expectedRevision !== current.item.revision) {
      throw new WorkItemConflictError(
        `Expected revision ${input.expectedRevision}, current revision is ${current.item.revision}`);
    }
    const now = new Date();
    const designPath = designPathFor(current.path);
    const designContent = await readDesignFile(designPath);
    const digests: DeliveryDigests = {
      requirement: contentDigest(current.content),
      // Empty/whitespace-only design.md counts as "not written yet".
      ...(designContent !== undefined && designContent.trim() !== ""
        ? { design: contentDigest(designContent) }
        : {}),
    };
    // workspace 流程开关注入（final-arch step-4）：plan 保持纯函数——配置由
    // apply 读后经 options 传入（与 digests 同款）。文件缺失 → null = 全关。
    const runnerConfig = await readDeliveryRunnerConfig(workspacePath);
    const plan = planDeliveryTransition(current.item, input.action, input.payload ?? {}, now, digests, {
      acceptanceRequired: runnerConfig?.stages?.acceptance?.enabled === true,
    });
    // Seed design.md on start-design when the file does not exist yet.
    if (plan.designContent !== undefined && designContent === undefined) {
      await mkdir(dirname(designPath), { recursive: true });
      await writeAtomic(designPath, plan.designContent);
    }
    const next: WorkItemRecord = structuredClone(current.item);
    next.phase = plan.phase;
    if (plan.status !== undefined) next.status = plan.status;
    // 会话自链接（服务层不变式）：带 conversationId 的动作把该会话挂入 conversations。
    if (input.conversationId && !next.conversations.includes(input.conversationId)) {
      next.conversations = [...next.conversations, input.conversationId];
    }
    next.delivery = {
      ...plan.delivery,
      lastRequest: { requestId: input.requestId, action: input.action, at: now.toISOString() },
    };
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(current.path, "item.yaml"), serializeWorkItem(next));
    await appendEvent(current.path, eventFor(plan.eventType, input.actor ?? "user", input.conversationId,
      { ...plan.eventData, revision: next.revision, requestId: input.requestId }));
    await commitWorkspaceChanges(workspacePath, `workspace: delivery ${input.action} ${input.key}`);
    return { detail: await readWorkItem(workspacePath, input.key), replayed: false };
  });
}

/** Design document read for the editing surface. 404-shaped NotFound when
 *  design.md has not been seeded yet. */
export async function readDesign(
  workspaceId: string,
  key: string,
): Promise<{ content: string; digest: string }> {
  const { path: workspacePath } = await getWorkspace(workspaceId);
  const current = await readWorkItem(workspacePath, key);
  const content = await readDesignFile(designPathFor(current.path));
  if (content === undefined) {
    throw new WorkItemNotFoundError(`Design document not found for ${key} — run start-design first`);
  }
  return { content, digest: contentDigest(content) };
}

/** Edit design.md. When a confirmed design diverges (new digest ≠ the
 *  confirmed designDigest), the same invalidation rule as a requirement
 *  change applies: clear confirmation/candidates/verification, phase back to
 *  "design", append a delivery.invalidated event, bump the revision. */
export async function updateDesignContent(
  workspaceId: string,
  key: string,
  input: UpdateDesignContentInput,
): Promise<WorkItemDetail> {
  const { path: workspacePath } = await getWorkspace(workspaceId);
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    if (current.item.phase === "released") {
      throw new WorkItemValidationError("Released baseline is frozen — create a follow-up item instead");
    }
    if (input.expectedRevision !== current.item.revision) {
      throw new WorkItemConflictError(
        `Expected revision ${input.expectedRevision}, current revision is ${current.item.revision}`,
      );
    }
    // Same normalization as updateWorkItemContent: validate trimmed
    // non-emptiness, store trim + trailing newline.
    const content = requireText(input.content, "content") + "\n";
    const designPath = designPathFor(current.path);
    const previous = await readDesignFile(designPath);
    if (previous === content) return current;
    const confirmed = current.item.delivery?.designConfirmed;
    const invalidated = current.item.delivery?.protocolVersion === 1
      && confirmed !== undefined
      && contentDigest(content) !== confirmed.designDigest;
    const next: WorkItemRecord = structuredClone(current.item);
    if (invalidated && next.delivery) {
      next.delivery = {
        ...next.delivery,
        designConfirmed: undefined,
        candidates: undefined,
        verification: undefined,
      };
      next.phase = "design";
    }
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    await mkdir(dirname(designPath), { recursive: true });
    await writeAtomic(designPath, content);
    await writeAtomic(join(current.path, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      current.path,
      eventFor(
        "work_item.design_updated",
        input.actor ?? "user",
        input.conversationId,
        { revision: next.revision, before_length: previous?.length ?? 0, after_length: content.length },
      ),
    );
    if (invalidated) {
      await appendEvent(current.path, eventFor(
        "delivery.invalidated",
        input.actor ?? "user",
        input.conversationId,
        { reason: "design-changed", fromPhase: current.item.phase, revision: next.revision },
      ));
    }
    await commitWorkspaceChanges(workspacePath, `workspace: update ${key} design`);
    return readWorkItem(workspacePath, key);
  });
}
