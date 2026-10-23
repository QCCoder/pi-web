import { createHash } from "node:crypto";
import { WorkItemValidationError } from "./errors.ts";

export type DeliveryAction =
  | "start-design" | "confirm-design" | "start-development" | "submit-verification"
  | "record-verification" | "prepare-release" | "record-release"
  | "rework" | "block" | "unblock" | "cancel";

export interface DeliveryCandidate { repositoryId: string; commit: string }

export interface DeliveryDesignConfirmation {
  at: string;
  actor: "user";
  requirementDigest: string;
  designDigest: string;
}

export interface DeliveryVerificationRecord {
  at: string;
  actor: "user";
  requirementDigest: string;
  candidateDigest: string;
  checks: Array<{ name: string; outcome: "passed" | "failed" | "unverified"; note?: string }>;
}

export interface DeliveryReleaseRecord {
  at: string;
  actor: "user";
  version: string;
  candidates: DeliveryCandidate[];
  notes?: string;
  rollback?: string;
}

export interface DeliveryReleasePlan { notes?: string; rollback?: string }

export interface DeliveryMetadata {
  protocolVersion: 1;
  mode: "manual";
  designConfirmed?: DeliveryDesignConfirmation;
  candidates?: DeliveryCandidate[];
  verification?: DeliveryVerificationRecord;
  releasePlan?: DeliveryReleasePlan;
  release?: DeliveryReleaseRecord;
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
  return "user";
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

function parseVerification(value: unknown): DeliveryVerificationRecord {
  const record = requireObject(value, "delivery.verification");
  return {
    at: requireText(record.at, "delivery.verification.at"),
    actor: requireUserActor(record.actor, "delivery.verification.actor"),
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
        };
      });
    })(),
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

function parseLastRequest(value: unknown): { requestId: string; action: DeliveryAction; at: string } {
  const record = requireObject(value, "delivery.lastRequest");
  return {
    requestId: requireText(record.requestId, "delivery.lastRequest.requestId"),
    action: requireEnum(record.action, DELIVERY_ACTIONS, "delivery.lastRequest.action"),
    at: requireText(record.at, "delivery.lastRequest.at"),
  };
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
    ...(present(record.releasePlan) ? { releasePlan: parseReleasePlan(record.releasePlan) } : {}),
    ...(present(record.release) ? { release: parseRelease(record.release) } : {}),
    ...(present(record.lastRequest) ? { lastRequest: parseLastRequest(record.lastRequest) } : {}),
  };
}
