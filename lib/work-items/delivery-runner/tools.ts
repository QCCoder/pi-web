// Phase-2 Task 5: designer 角色领取工具（spec 2026-10-24-phase-two §5.3）。
// 挂载在 buildWorkspaceExtensions（capabilities 含 work-items ∧ workflows，
// extensions.ts），只对被 dispatcher（T7）授予 designer 角色的会话可用：
// execute 第一步经 roleGrantOf(sessionId) 验身份——无 grant / grant 属他
// 工作区 → 400 文本（不抛异常）；凭证（ownerToken/attemptId/generation）
// 全程住在进程内 role grant（role-grants.ts），绝不出现在参数 schema。
//
// 工具面只有领取侧四件：list / claim / submit / fail。confirm-design、
// record-verification、release、block、unblock、cancel 等人工/动作面住在
// M2 delivery 路由（HTTP），刻意不做成 LLM 工具——确认与放行是人的手。
//
// 身份来源：ctx.sessionManager.getSessionId()（ExtensionAPI 本身不带
// sessionId；与 work-items extension 的 conversationId 同款通道）。
// requestId 刻意确定性（`claim:<sessionId>:<key>` 等）：工具调用在传输层
// 重试时命中 claim 服务的幂等重放分支，不产生第二次事务。
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { WorkItemConflictError, WorkItemValidationError } from "../errors.ts";
import {
  claimDesignerTask,
  failDesignerTask,
  submitDesignerResult,
} from "./claim.ts";
import { listDeliveryPool } from "./pool.ts";
import {
  grantRole,
  roleGrantOf,
  setGrantToken,
  type RoleGrant,
} from "./role-grants.ts";

/** T4 carried ruling：submit 冲突（领取窗口内人抢先 confirm-design / 输入
 *  摘要变化）的释放引导——释放走 fail（claim 仍活，须让出），然后结束。 */
const RELEASE_VIA_FAIL_GUIDANCE =
  "设计已由人确认/输入已变化，请调用 delivery_fail_task 释放本次领取后结束";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

function denied(message: string) {
  return result({ ok: false, error: "forbidden", message });
}

/** 身份门：无 grant / grant 绑定别的工作区 → 拒绝文本；通过 → 返回 grant。 */
function requireRoleGrant(sessionId: string, workspacePath: string): RoleGrant | string {
  const grant = roleGrantOf(sessionId);
  if (grant === null) {
    return "非角色执行会话（not a role execution session）：本会话未被授予 designer 角色，delivery_* 工具不可用";
  }
  if (grant.workspacePath !== workspacePath) {
    return `非角色执行会话（not a role execution session）：本会话的 designer 授权属于另一个工作区（${grant.workspacePath}），与当前挂载的工作区不符`;
  }
  return grant;
}

/** submit/fail 前置：本会话须持有 claim 服务核发的完整凭证（领取后才在场）。
 *  返回窄化后的凭证三元组；缺失 → null（调用方返回引导文本）。 */
function claimCredentialsOf(
  grant: RoleGrant,
): { attemptId: string; generation: number; ownerToken: string } | null {
  if (
    grant.attemptId === undefined || grant.generation === undefined
    || grant.ownerToken === undefined || grant.ownerToken === ""
  ) {
    return null;
  }
  return { attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken };
}

const NO_CLAIM_CREDENTIALS =
  "本会话没有进行中的领取凭证——先调用 delivery_claim_task 领取任务，再提交或释放";

/** 服务错误 → 结构化结果文本（LLM 可读可恢复）；未知错误原样上抛。 */
function errorResult(error: unknown, guidance?: string) {
  if (error instanceof WorkItemConflictError) {
    return result({
      ok: false,
      error: "conflict",
      message: error.message,
      ...(guidance !== undefined ? { guidance } : {}),
    });
  }
  if (error instanceof WorkItemValidationError) {
    return result({ ok: false, error: "validation", message: error.message });
  }
  throw error;
}

/** submit/fail 成功后把 grant 重置回裸授权——过期凭证不得复用到下一次领取。 */
function resetToBareGrant(sessionId: string, grant: RoleGrant): void {
  grantRole(sessionId, { role: grant.role, workspacePath: grant.workspacePath });
}

function itemSummary(item: {
  key: string;
  status: string;
  phase: string;
  revision: number;
}) {
  return { key: item.key, status: item.status, phase: item.phase, revision: item.revision };
}

/**
 * @param workspaceId   Workspace id（签名对称保留——claim/pool 服务收
 *                      workspacePath；id 不参与任何服务调用）。
 * @param workspacePath Absolute path of the workspace root（服务调用的钥匙）。
 */
export function createDeliveryRunnerExtension(
  workspaceId: string,
  workspacePath: string,
): InlineExtension {
  void workspaceId;
  return {
    name: "pi-delivery-runner",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "delivery_list_ready_tasks",
        label: "List Ready Delivery Tasks",
        description:
          "List the designer task pool of this workspace: ready tasks (claimable now, "
          + "sorted P0→P3) and blocked tasks with per-item reasons. No parameters.",
        promptSnippet: "List ready/blocked designer delivery tasks for this workspace",
        parameters: Type.Object({}),
        execute: async (_callId, _params, _signal, _update, ctx) => {
          const sessionId = ctx.sessionManager.getSessionId();
          const gate = requireRoleGrant(sessionId, workspacePath);
          if (typeof gate === "string") return denied(gate);
          try {
            const pool = await listDeliveryPool(workspacePath);
            return result({
              ok: true,
              ready: pool.ready.map((entry) => ({
                key: entry.key,
                title: entry.title,
                priority: entry.priority,
                role: entry.role,
              })),
              blocked: pool.blocked.map((entry) => ({
                key: entry.key,
                title: entry.title,
                priority: entry.priority,
                reasons: entry.reasons,
              })),
            });
          } catch (error) {
            return errorResult(error);
          }
        },
      });

      pi.registerTool({
        name: "delivery_claim_task",
        label: "Claim Delivery Task",
        description:
          "Claim a ready delivery task as the designer role (intake→design, seeds design.md). "
          + "Returns the input pack: requirement README, repository list, and the design.md path. "
          + "Idempotent: retrying the same key in the same session replays the original grant.",
        promptGuidelines: [
          "Pick from delivery_list_ready_tasks' ready list (highest priority first); claim exactly one task.",
          "Retry of a timed-out claim is safe — the same claim is replayed, no second transaction.",
        ],
        promptSnippet: "Claim a delivery task and receive its requirement input pack",
        parameters: Type.Object({
          key: Type.String({ description: "Human key such as REQ-0001" }),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => {
          const sessionId = ctx.sessionManager.getSessionId();
          const gate = requireRoleGrant(sessionId, workspacePath);
          if (typeof gate === "string") return denied(gate);
          try {
            const { grant, replayed } = await claimDesignerTask({
              workspacePath,
              key: params.key,
              sessionId,
              requestId: `claim:${sessionId}:${params.key}`,
            });
            // 明文 ownerToken 只在首次核发；重放为空串 → 不覆写已存凭证。
            let note: string | undefined;
            if (grant.ownerToken !== "") {
              setGrantToken(sessionId, grant.attemptId, grant.ownerToken, grant.generation);
            } else if ((roleGrantOf(sessionId)?.attemptId ?? null) !== grant.attemptId) {
              note = "领取幂等重放命中，但本进程未持有该领取的 ownerToken——本会话无法提交或释放，请直接结束本轮";
            }
            return result({
              ok: true,
              replayed,
              attemptId: grant.attemptId,
              generation: grant.generation,
              key: grant.key,
              title: grant.item.item.title,
              priority: grant.item.item.priority,
              repositories: grant.item.item.repositories,
              requirementReadme: grant.item.content,
              designDocPath: join(grant.item.path, "delivery", "artifacts", "design.md"),
              ...(note !== undefined ? { note } : {}),
            });
          } catch (error) {
            return errorResult(
              error,
              error instanceof WorkItemConflictError
                ? "任务已被其他会话领取——改选 ready 池中的其他任务，或结束本轮"
                : undefined,
            );
          }
        },
      });

      pi.registerTool({
        name: "delivery_submit_result",
        label: "Submit Delivery Design",
        description:
          "Submit the design result for the claimed task: writes design.md (your design plus a "
          + "synthesized acceptance-criteria section) and returns the item to awaiting-human-confirmation. "
          + "Credentials are held server-side — pass only key, design markdown, acceptance criteria. "
          + "After submitting, end the turn: confirmation (confirm-design) is the human's move.",
        promptGuidelines: [
          "Write the full design into design_markdown; list concrete, checkable acceptance_criteria (at least one).",
          "A conflict result means a human already confirmed or the input changed — follow its guidance (release via delivery_fail_task) and end.",
        ],
        promptSnippet: "Submit the claimed delivery task's design and wait for human confirmation",
        parameters: Type.Object({
          key: Type.String({ description: "Human key of the claimed task" }),
          design_markdown: Type.String({
            description: "Full design document body in Markdown (验收条件 section is appended automatically)",
          }),
          acceptance_criteria: Type.Array(Type.String(), {
            minItems: 1,
            description: "Checkable acceptance criteria; at least one is required",
          }),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => {
          const sessionId = ctx.sessionManager.getSessionId();
          const gate = requireRoleGrant(sessionId, workspacePath);
          if (typeof gate === "string") return denied(gate);
          const credentials = claimCredentialsOf(gate);
          if (credentials === null) return denied(NO_CLAIM_CREDENTIALS);
          try {
            const detail = await submitDesignerResult({
              workspacePath,
              key: params.key,
              attemptId: credentials.attemptId,
              generation: credentials.generation,
              ownerToken: credentials.ownerToken,
              designContent: params.design_markdown,
              acceptanceCriteria: [...params.acceptance_criteria],
              requestId: `submit:${sessionId}:${credentials.attemptId}`,
              conversationId: sessionId,
            });
            resetToBareGrant(sessionId, gate);
            return result({
              ok: true,
              message:
                `设计已提交（design.md 写入 ${params.key}），等待人工确认（confirm-design）——本轮到此结束，不要继续推进阶段`,
              item: itemSummary(detail.item),
            });
          } catch (error) {
            return errorResult(
              error,
              error instanceof WorkItemConflictError
                ? error.message.includes("no active claim")
                  ? "领取已不存在（可能已提交过或已被释放）——不要重复提交，结束本轮"
                  : RELEASE_VIA_FAIL_GUIDANCE
                : undefined,
            );
          }
        },
      });

      pi.registerTool({
        name: "delivery_fail_task",
        label: "Fail / Release Delivery Task",
        description:
          "Report failure and release the claimed task (design→intake; blocked=true marks the item "
          + "blocked — still claimable once unblocked). Also used to release a claim invalidated by a "
          + "human confirm-design, per the submit tool's conflict guidance. Credentials are server-held.",
        promptGuidelines: [
          "Give the real reason in reason; set blocked=true only for external/environmental blockers.",
          "After releasing, end the turn — do not immediately re-claim the same item.",
        ],
        promptSnippet: "Fail or release the claimed delivery task with a reason",
        parameters: Type.Object({
          key: Type.String({ description: "Human key of the claimed task" }),
          reason: Type.String({ description: "Why the attempt failed (human-readable, concrete)" }),
          blocked: Type.Optional(Type.Boolean({
            description: "Mark the item blocked (environment/dependency); default false",
          })),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => {
          const sessionId = ctx.sessionManager.getSessionId();
          const gate = requireRoleGrant(sessionId, workspacePath);
          if (typeof gate === "string") return denied(gate);
          const credentials = claimCredentialsOf(gate);
          if (credentials === null) return denied(NO_CLAIM_CREDENTIALS);
          try {
            const detail = await failDesignerTask({
              workspacePath,
              key: params.key,
              attemptId: credentials.attemptId,
              generation: credentials.generation,
              ownerToken: credentials.ownerToken,
              reason: params.reason,
              ...(params.blocked !== undefined ? { blocked: params.blocked } : {}),
            });
            resetToBareGrant(sessionId, gate);
            return result({
              ok: true,
              message: `已释放领取（${params.key}）——${params.reason}`,
              item: itemSummary(detail.item),
            });
          } catch (error) {
            return errorResult(
              error,
              error instanceof WorkItemConflictError
                ? "领取凭证已失效（他方领取、人工处理或已释放）——结束本轮即可"
                : undefined,
            );
          }
        },
      });
    },
  };
}
