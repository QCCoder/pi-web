import { createHash } from "node:crypto";
import { WorkItemValidationError } from "./errors.ts";
// 词表守卫：clarification role 走 AnyDeliveryRole（活值 ∪ legacy verifier）——
// 旧 verifier 澄清记录在 verifier 正式退役（Task 4）后仍永可解析。
import {
  isAnyDeliveryRole,
  type AnyDeliveryRole,
} from "./delivery-runner/roles.ts";

export type DeliveryAction =
  | "start-design" | "confirm-design" | "start-development" | "submit-verification"
  | "record-verification" | "prepare-release" | "record-release"
  | "rework" | "block" | "unblock" | "cancel"
  // final-arch step-2：ask-a-human 升为一等轮次终局——词表先进（路由 slug 门与
  // lastRequest 校验即刻合法），流转 case 由 Task 4 实现（此前 default 分支 400）。
  | "answer-clarification";

export interface DeliveryCandidate { repositoryId: string; commit: string }

export interface DeliveryDesignConfirmation {
  at: string;
  actor: "user";
  requirementDigest: string;
  designDigest: string;
}

/** 服务端产出的检查执行证据（Phase-4 verifier：delivery.verification.checks[].evidence）。
 *  由 claim.ts 从 claim.checkContexts（冻结命令）+ claim.checkResults（服务端
 *  执行器产物）组装——LLM 自述不构成证据。人工 record-verification 可不带。 */
export interface DeliveryCheckEvidence {
  command: string;
  /** null = 进程未跑完（超时/启动失败）——unverified 的真实退出码不存在。 */
  exitCode: number | null;
  durationMs: number;
  /** 相对工作项根的 POSIX 日志路径。 */
  logRef: string;
}

export interface DeliveryVerificationCheck {
  name: string;
  outcome: "passed" | "failed" | "unverified";
  note?: string;
  /** Phase-4 verifier 自动验证携带；人工登记缺省无。 */
  evidence?: DeliveryCheckEvidence;
}

export interface DeliveryVerificationRecord {
  at: string;
  /** 落块者：user = 人工 record-verification；agent = 旧 verifier 会话自动验证
   *  （final-arch step-3 T3 起 verifier 已退役——存量 agent 块永可读）；
   *  system = 引擎 system 检查步（checks-step 的 finalizeChecks 结算）。
   *  三者同块同 digest 绑定规则，最后写入者生效。confirm-design /
   *  record-release 永远 user，不放宽。 */
  actor: "user" | "agent" | "system";
  requirementDigest: string;
  candidateDigest: string;
  checks: DeliveryVerificationCheck[];
}

export interface DeliveryReleaseRecord {
  at: string;
  actor: "user";
  version: string;
  candidates: DeliveryCandidate[];
  notes?: string;
  rollback?: string;
}

/** 人工验收记录（final-arch step-4：record-release 验收门的数据面）。structure
 *  对齐 review/verification 的 digest 绑定纪律——candidateDigest 锁定验收时的
 *  候选集，候选被换则记录失准（release 门拒）。写入口 record-acceptance 由
 *  Task 3 落（与 confirm-design / record-release 同款「人的手」）。 */
export interface DeliveryAcceptanceRecord {
  notes: string;
  candidateDigest: string;
  at: string;
}

export interface DeliveryReleasePlan { notes?: string; rollback?: string }

/** 审查记录（final-arch step-3 Task 1，2026-10-26：先审后跑）。reviewer 人工
 *  审查轮的判定落块（结构对齐 DeliveryVerificationRecord 的 digest 绑定纪律）：
 *  - outcome pass = 审查通过（放行进 system 检查步/后续阶段）；rework = 打回 developer
 *    重做（source 必填——指认问题出在实现 code 还是设计 spec，rework 路由据此
 *    回退阶段）。
 *  - pass 刻意不得携带 source（无源可指）；rework 的 notes 必填非空（重做必须
 *    说明缺什么）；pass 的 notes 允许空串（通过可以不附说明）。 */
export interface DeliveryReviewRecord {
  outcome: "pass" | "rework";
  /** 仅 rework 携带：code = 实现缺陷（打回开发）；spec = 设计缺陷（打回设计）。 */
  source?: "code" | "spec";
  notes: string;
  /** 审查时候选集摘要（candidatesDigest）——判定与候选绑定，候选被换则记录失准。 */
  candidateDigest: string;
  at: string;
  /** 产生本判定的 attempt（reviewer 领取轮次）——审计可溯。 */
  attemptId: string;
}

/** 澄清问答（final-arch step-2：agent 的 ask-a-human 轮次产物，数据面）。
 *  id 是写方（Task 2 claim 事务）的 ULID 约定——parse 只要求非空字串；
 *  answer/answeredAt 同在同缺（未答 / 已答两态，半对即坏形）。 */
export interface DeliveryClarification {
  id: string;
  /** AnyDeliveryRole（final-arch step-3）：活值 ∪ legacy verifier——旧 verifier
   *  澄清在角色退役后仍永可解析；新写入面（claim 输入）另由活值守卫把门。 */
  role: AnyDeliveryRole;
  question: string;
  options?: string[];
  recommended?: string;
  askedAt: string;
  attemptId: string;
  answer?: string;
  answeredAt?: string;
}

export interface DeliveryMetadata {
  protocolVersion: 1;
  mode: "manual";
  designConfirmed?: DeliveryDesignConfirmation;
  candidates?: DeliveryCandidate[];
  verification?: DeliveryVerificationRecord;
  /** reviewer 审查判定（final-arch step-3：先审后跑）——rework 打回时 source
   *  指认 code|spec；候选摘要绑定同 verification 的 digest 纪律。 */
  review?: DeliveryReviewRecord;
  /** 人工验收记录（final-arch step-4）：release_ready → released 的验收门证据
   *  （stages.acceptance.enabled 开启时 record-release 必须先有此块且摘要与
   *  当前候选绑定）；rework 一并失效（须重新挣得）。 */
  acceptance?: DeliveryAcceptanceRecord;
  releasePlan?: DeliveryReleasePlan;
  release?: DeliveryReleaseRecord;
  /** 澄清问答（追加式——answer 只补不删，历史保留审计）。 */
  clarifications?: DeliveryClarification[];
  /** 幂等指纹（spec §9）：最近一次已受理的动作。同 requestId+action 重放直接返回现态。 */
  lastRequest?: { requestId: string; action: DeliveryAction; at: string };
}

/** Canonical action slug list (single source of truth for the HTTP route's
 * slug gate — M2 Task 3; also backs lastRequest.action validation below). */
export const DELIVERY_ACTIONS: readonly DeliveryAction[] = [
  "start-design",
  "confirm-design",
  "start-development",
  "submit-verification",
  "record-verification",
  "prepare-release",
  "record-release",
  "rework",
  "block",
  "unblock",
  "cancel",
  "answer-clarification",
];

const VERIFICATION_OUTCOMES: readonly ("passed" | "failed" | "unverified")[] = [
  "passed",
  "failed",
  "unverified",
];

/** sha256 hex of the utf-8 content. */
export function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** sha256 hex over the canonical JSON of candidates sorted by repositoryId —
 *  order-insensitive so two lists naming the same candidates digest equally. */
export function candidatesDigest(candidates: DeliveryCandidate[]): string {
  const canonical = [...candidates]
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
    .map((candidate) => ({ repositoryId: candidate.repositoryId, commit: candidate.commit }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkItemValidationError(`${field} is required`);
  }
  return value.trim();
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new WorkItemValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkItemValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireUserActor(value: unknown, field: string): "user" {
  if (value !== "user") {
    throw new WorkItemValidationError(`${field} must be "user"`);
  }
  return value as "user";
}

/** verification 专属：user（人工登记）| agent（旧 verifier 自动验证，legacy 可读）
 *  | system（引擎 system 检查步落块，final-arch step-3 T3 起——verifier 自动验证
 *  已退役）。designConfirmed / release 不放宽——仍 requireUserActor。 */
function requireVerificationActor(value: unknown, field: string): "user" | "agent" | "system" {
  if (value !== "user" && value !== "agent" && value !== "system") {
    throw new WorkItemValidationError(`${field} must be "user", "agent" or "system"`);
  }
  return value;
}

/** Present means "the block exists"; null and undefined both mean absent
 *  (same convention parseWorkItem uses for `external`). */
function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (!present(value)) return undefined;
  return requireText(value, field);
}

function parseCandidate(value: unknown, field: string): DeliveryCandidate {
  const record = requireObject(value, field);
  return {
    repositoryId: requireText(record.repositoryId, `${field}.repositoryId`),
    commit: requireText(record.commit, `${field}.commit`),
  };
}

function parseCandidates(value: unknown, field: string): DeliveryCandidate[] {
  if (!Array.isArray(value)) {
    throw new WorkItemValidationError(`${field} must be an array`);
  }
  return value.map((entry, index) => parseCandidate(entry, `${field}[${index}]`));
}

function parseDesignConfirmation(value: unknown): DeliveryDesignConfirmation {
  const record = requireObject(value, "delivery.designConfirmed");
  return {
    at: requireText(record.at, "delivery.designConfirmed.at"),
    actor: requireUserActor(record.actor, "delivery.designConfirmed.actor"),
    requirementDigest: requireText(record.requirementDigest, "delivery.designConfirmed.requirementDigest"),
    designDigest: requireText(record.designDigest, "delivery.designConfirmed.designDigest"),
  };
}

function parseCheckEvidence(value: unknown, field: string): DeliveryCheckEvidence {
  const record = requireObject(value, field);
  const exitCode = record.exitCode;
  if (typeof exitCode !== "number" && exitCode !== null) {
    throw new WorkItemValidationError(`${field}.exitCode must be a number or null`);
  }
  const durationMs = record.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new WorkItemValidationError(`${field}.durationMs must be a non-negative number`);
  }
  return {
    command: requireText(record.command, `${field}.command`),
    exitCode,
    durationMs,
    logRef: requireText(record.logRef, `${field}.logRef`),
  };
}

function parseVerification(value: unknown): DeliveryVerificationRecord {
  const record = requireObject(value, "delivery.verification");
  return {
    at: requireText(record.at, "delivery.verification.at"),
    actor: requireVerificationActor(record.actor, "delivery.verification.actor"),
    requirementDigest: requireText(record.requirementDigest, "delivery.verification.requirementDigest"),
    candidateDigest: requireText(record.candidateDigest, "delivery.verification.candidateDigest"),
    checks: (() => {
      const field = "delivery.verification.checks";
      if (!Array.isArray(record.checks)) {
        throw new WorkItemValidationError(`${field} must be an array`);
      }
      return record.checks.map((entry, index) => {
        const check = requireObject(entry, `${field}[${index}]`);
        const note = optionalText(check.note, `${field}[${index}].note`);
        return {
          name: requireText(check.name, `${field}[${index}].name`),
          outcome: requireEnum(check.outcome, VERIFICATION_OUTCOMES, `${field}[${index}].outcome`),
          ...(note !== undefined ? { note } : {}),
          ...(present(check.evidence)
            ? { evidence: parseCheckEvidence(check.evidence, `${field}[${index}].evidence`) }
            : {}),
        };
      });
    })(),
  };
}

const REVIEW_OUTCOMES: readonly ("pass" | "rework")[] = ["pass", "rework"];

const REVIEW_SOURCES: readonly ("code" | "spec")[] = ["code", "spec"];

/** review 记录（final-arch step-3 Task 1）：outcome ∈ {pass, rework}；rework
 *  必带 source ∈ {code, spec}、pass 不得带 source（在场即校验，null 同拒）；
 *  notes 两种 outcome 都必填且为字符串——rework 非空（重做必须说明缺什么），
 *  pass 允许空串；candidateDigest/at/attemptId 非空。 */
function parseReview(value: unknown): DeliveryReviewRecord {
  const record = requireObject(value, "delivery.review");
  const outcome = requireEnum(record.outcome, REVIEW_OUTCOMES, "delivery.review.outcome");
  let source: "code" | "spec" | undefined;
  if (present(record.source)) {
    source = requireEnum(record.source, REVIEW_SOURCES, "delivery.review.source");
  }
  if (outcome === "rework" && source === undefined) {
    throw new WorkItemValidationError(
      "delivery.review.source is required when outcome is rework (code | spec)",
    );
  }
  if (outcome === "pass" && source !== undefined) {
    throw new WorkItemValidationError(
      "delivery.review.source must not be present when outcome is pass",
    );
  }
  // notes：字符串必填；rework 非空（requireText 习语）；pass 允许空串（trim
  // 与 requireText 同规——纯空白视作空）。
  if (typeof record.notes !== "string") {
    throw new WorkItemValidationError("delivery.review.notes is required");
  }
  const notes = record.notes.trim();
  if (outcome === "rework" && !notes) {
    throw new WorkItemValidationError("delivery.review.notes is required");
  }
  return {
    outcome,
    ...(source !== undefined ? { source } : {}),
    notes,
    candidateDigest: requireText(record.candidateDigest, "delivery.review.candidateDigest"),
    at: requireText(record.at, "delivery.review.at"),
    attemptId: requireText(record.attemptId, "delivery.review.attemptId"),
  };
}

function parseReleasePlan(value: unknown): DeliveryReleasePlan {
  const record = requireObject(value, "delivery.releasePlan");
  const notes = optionalText(record.notes, "delivery.releasePlan.notes");
  const rollback = optionalText(record.rollback, "delivery.releasePlan.rollback");
  return {
    ...(notes !== undefined ? { notes } : {}),
    ...(rollback !== undefined ? { rollback } : {}),
  };
}

function parseRelease(value: unknown): DeliveryReleaseRecord {
  const record = requireObject(value, "delivery.release");
  const notes = optionalText(record.notes, "delivery.release.notes");
  const rollback = optionalText(record.rollback, "delivery.release.rollback");
  return {
    at: requireText(record.at, "delivery.release.at"),
    actor: requireUserActor(record.actor, "delivery.release.actor"),
    version: requireText(record.version, "delivery.release.version"),
    candidates: parseCandidates(record.candidates, "delivery.release.candidates"),
    ...(notes !== undefined ? { notes } : {}),
    ...(rollback !== undefined ? { rollback } : {}),
  };
}

/** acceptance 记录（final-arch step-4 Task 1）：notes 非空（trim 后——验收必须
 *  说明验了什么）；candidateDigest/at 非空。candidateDigest 与当前候选集的绑定
 *  由消费侧（record-release 门）校验，parse 只管形状。 */
function parseAcceptance(value: unknown): DeliveryAcceptanceRecord {
  const record = requireObject(value, "delivery.acceptance");
  return {
    notes: requireText(record.notes, "delivery.acceptance.notes"),
    candidateDigest: requireText(record.candidateDigest, "delivery.acceptance.candidateDigest"),
    at: requireText(record.at, "delivery.acceptance.at"),
  };
}

function parseLastRequest(value: unknown): { requestId: string; action: DeliveryAction; at: string } {
  const record = requireObject(value, "delivery.lastRequest");
  return {
    requestId: requireText(record.requestId, "delivery.lastRequest.requestId"),
    action: requireEnum(record.action, DELIVERY_ACTIONS, "delivery.lastRequest.action"),
    at: requireText(record.at, "delivery.lastRequest.at"),
  };
}

/** 单条澄清：id/role/question/askedAt/attemptId 必填非空（role 走 roles.ts
 *  的 AnyDeliveryRole 守卫——活值 ∪ legacy verifier，旧数据永可解析）；
 *  options 可选非空字串数组；recommended 可选非空字串（刻意不与 options 交叉
 *  校验——parse 不掐语义，推荐值自由）；answer/answeredAt 同在同缺。 */
function parseClarification(entry: unknown, field: string): DeliveryClarification {
  const record = requireObject(entry, field);
  const role = record.role;
  if (!isAnyDeliveryRole(role)) {
    throw new WorkItemValidationError(`${field}.role is not a delivery role`);
  }
  const hasAnswer = present(record.answer);
  const hasAnsweredAt = present(record.answeredAt);
  if (hasAnswer !== hasAnsweredAt) {
    throw new WorkItemValidationError(
      `${field}.answer and ${field}.answeredAt must be both present or both absent`,
    );
  }
  const options = (() => {
    if (!present(record.options)) return undefined;
    if (!Array.isArray(record.options)) {
      throw new WorkItemValidationError(`${field}.options must be an array of strings`);
    }
    return record.options.map((option, index) => requireText(option, `${field}.options[${index}]`));
  })();
  return {
    id: requireText(record.id, `${field}.id`),
    role,
    question: requireText(record.question, `${field}.question`),
    ...(options !== undefined ? { options } : {}),
    ...(present(record.recommended)
      ? { recommended: requireText(record.recommended, `${field}.recommended`) }
      : {}),
    askedAt: requireText(record.askedAt, `${field}.askedAt`),
    attemptId: requireText(record.attemptId, `${field}.attemptId`),
    ...(hasAnswer ? { answer: requireText(record.answer, `${field}.answer`) } : {}),
    ...(hasAnsweredAt ? { answeredAt: requireText(record.answeredAt, `${field}.answeredAt`) } : {}),
  };
}

function parseClarifications(value: unknown, field: string): DeliveryClarification[] {
  if (!Array.isArray(value)) {
    throw new WorkItemValidationError(`${field} must be an array`);
  }
  return value.map((entry, index) => parseClarification(entry, `${field}[${index}]`));
}

/** Validate an unknown value as protocol-v1 manual DeliveryMetadata. Every
 *  nested block is field-by-field checked (same idioms as parseWorkItem);
 *  unknown protocolVersion / non-manual mode are hard errors so a future
 *  writer's items stay visibly unreadable rather than silently lossy. */
export function parseDelivery(value: unknown): DeliveryMetadata {
  const record = requireObject(value, "delivery");
  if (record.protocolVersion !== 1) {
    throw new WorkItemValidationError(`Unknown delivery protocolVersion: ${String(record.protocolVersion)}`);
  }
  if (record.mode !== "manual") {
    throw new WorkItemValidationError(`Unsupported delivery mode: ${String(record.mode)} (expected "manual")`);
  }
  return {
    protocolVersion: 1,
    mode: "manual",
    ...(present(record.designConfirmed)
      ? { designConfirmed: parseDesignConfirmation(record.designConfirmed) }
      : {}),
    ...(present(record.candidates)
      ? { candidates: parseCandidates(record.candidates, "delivery.candidates") }
      : {}),
    ...(present(record.verification) ? { verification: parseVerification(record.verification) } : {}),
    ...(present(record.review) ? { review: parseReview(record.review) } : {}),
    ...(present(record.acceptance) ? { acceptance: parseAcceptance(record.acceptance) } : {}),
    ...(present(record.releasePlan) ? { releasePlan: parseReleasePlan(record.releasePlan) } : {}),
    ...(present(record.release) ? { release: parseRelease(record.release) } : {}),
    ...(present(record.clarifications)
      ? { clarifications: parseClarifications(record.clarifications, "delivery.clarifications") }
      : {}),
    ...(present(record.lastRequest) ? { lastRequest: parseLastRequest(record.lastRequest) } : {}),
  };
}
