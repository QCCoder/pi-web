// Phase-2 Task 5: designer 角色领取工具（spec 2026-10-24-phase-two §5.3）。
// Phase-3 Task 4: 双角色分派（spec 2026-10-24-phase-three §6）——claim/submit/
// fail 按 grant.role 调 designer/developer 对应服务；submit 参数是扁平可选
// 字段组（designer: design_markdown+acceptance_criteria | developer:
// candidates+notes——2026-10-24 smoke ruling：联合（any-of）形参数 schema 在
// 该 pi SDK 的调用侧解析不工作，永不回潮），服务端按 grant.role 校验形状
// （错形状 → validation 文本，不进服务）。
// 挂载在 buildWorkspaceExtensions（capabilities 含 work-items ∧ workflows，
// extensions.ts），只对被 dispatcher 授予角色（designer | developer）的会话可用：
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
  claimDeveloperTask,
  failDesignerTask,
  failDeveloperTask,
  submitDesignerResult,
  submitDeveloperResult,
} from "./claim.ts";
import { listDeliveryPool } from "./pool.ts";
import { readClaim } from "./attempts.ts";
import {
  grantRole,
  roleGrantOf,
  setGrantToken,
  type RoleGrant,
} from "./role-grants.ts";

/** submit 冲突的释放引导（T4 carried ruling——释放走 fail，claim 仍活须让出，
 *  然后结束）；designer 与 developer 各自的漂移语义。 */
const RELEASE_VIA_FAIL_GUIDANCE_DESIGNER =
  "设计已由人确认/输入已变化，请调用 delivery_fail_task 释放本次领取后结束";
const RELEASE_VIA_FAIL_GUIDANCE_DEVELOPER =
  "输入已变化/设计已推进，请调用 delivery_fail_task 释放本次领取后结束";

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
    return "非角色执行会话（not a role execution session）：本会话未被授予交付执行角色（designer/developer），delivery_* 工具不可用";
  }
  if (grant.workspacePath !== workspacePath) {
    return `非角色执行会话（not a role execution session）：本会话的角色授权属于另一个工作区（${grant.workspacePath}），与当前挂载的工作区不符`;
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
          "List the delivery task pool of this workspace, both roles (designer: "
          + "intake→design; developer: ready_for_implementation→implementation): "
          + "ready tasks (claimable now, merged queue sorted P0→P3 then key, each "
          + "entry carrying its role) and blocked tasks with per-item reasons and role. "
          + "No parameters.",
        promptSnippet: "List ready/blocked delivery tasks (designer + developer) for this workspace",
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
                role: entry.role,
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
          "Claim a ready delivery task in YOUR granted role, exactly the task your role "
          + "contract assigns (designer: intake→design, seeds design.md; developer: "
          + "ready_for_implementation→implementation, prepares isolated worktrees). "
          + "Returns the input pack: requirement README, repository list, the design.md "
          + "path, and — for the developer role — the worktree list (path+branch per "
          + "repository; the ONLY places you may write code). Idempotent: retrying the "
          + "same key in the same session replays the original grant.",
        promptGuidelines: [
          "Pick from delivery_list_ready_tasks' ready list, respecting your role contract — claim exactly the assigned task.",
          "Retry of a timed-out claim is safe — the same claim is replayed, no second transaction.",
        ],
        promptSnippet: "Claim the assigned delivery task in your role and receive its input pack",
        parameters: Type.Object({
          key: Type.String({ description: "Human key such as REQ-0001" }),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => {
          const sessionId = ctx.sessionManager.getSessionId();
          const gate = requireRoleGrant(sessionId, workspacePath);
          if (typeof gate === "string") return denied(gate);
          try {
            const claimed = gate.role === "developer"
              ? await claimDeveloperTask({
                workspacePath,
                key: params.key,
                sessionId,
                requestId: `claim:${sessionId}:${params.key}`,
              })
              : await claimDesignerTask({
                workspacePath,
                key: params.key,
                sessionId,
                requestId: `claim:${sessionId}:${params.key}`,
              });
            const { grant, replayed } = claimed;
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
              role: gate.role,
              attemptId: grant.attemptId,
              generation: grant.generation,
              key: grant.key,
              title: grant.item.item.title,
              priority: grant.item.item.priority,
              repositories: grant.item.item.repositories,
              requirementReadme: grant.item.content,
              designDocPath: join(grant.item.path, "delivery", "artifacts", "design.md"),
              // developer 专属：worktree 清单（claim.json 随领取落盘——重放同样在场）。
              ...(gate.role === "developer"
                ? { worktrees: readClaim(grant.item.path)?.worktrees ?? [] }
                : {}),
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
        label: "Submit Delivery Result",
        description:
          "Submit the result for the claimed task, providing the field group YOUR "
          + "role requires (all fields are listed here; provide only your role's "
          + "group). designer: design_markdown (full design body) + "
          + "acceptance_criteria (checkable, at least one) — writes design.md and "
          + "returns the item to awaiting-human-confirmation. developer: candidates "
          + "(one {repositoryId, commit} per repository, commits on your worktree "
          + "branches) + optional notes (change summary / self-test) — submits the "
          + "implementation candidates and moves the item to verification. "
          + "Credentials are held server-side. After submitting, end the turn: "
          + "confirmation and verification are the human's moves.",
        promptGuidelines: [
          "designer: write the full design into design_markdown; list concrete, checkable acceptance_criteria (at least one).",
          "developer: commit your work on the worktree branches, then submit one candidate {repositoryId, commit} per repository plus notes.",
          "A conflict result means the input changed or a human already advanced the item — follow its guidance (release via delivery_fail_task) and end.",
        ],
        promptSnippet: "Submit the claimed task's result (design or candidates) and wait for the human's move",
        // 参数扁平可选字段组（2026-10-24 Phase-3 smoke ruling）：联合
        // （designer 形 | developer 形）schema 在该 pi SDK 版本的调用侧解析
        // 不工作（真 LLM 会话参数全落 {}，schema 校验全拒）。单个对象 +
        // 可选字段；提供哪一组由角色决定，形状权威在服务端按 grant.role
        // 校验（见 execute 内）。
        parameters: Type.Object({
          key: Type.String({ description: "Human key of the claimed task" }),
          design_markdown: Type.Optional(Type.String({
            description: "(designer) Full design document body in Markdown (验收条件 section is appended automatically)",
          })),
          acceptance_criteria: Type.Optional(Type.Array(Type.String(), {
            description: "(designer) Checkable acceptance criteria; at least one is required",
          })),
          candidates: Type.Optional(Type.Array(
            Type.Object({
              repositoryId: Type.String({
                description: "(developer) Repository id from your claim's worktree list",
              }),
              commit: Type.String({
                description: "(developer) Commit sha on the worktree branch (one per repository)",
              }),
            }),
            {
              description: "(developer) Candidate commits; at least one is required",
            },
          )),
          notes: Type.Optional(Type.String({
            description: "(developer) Change summary and self-test notes",
          })),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => {
          const sessionId = ctx.sessionManager.getSessionId();
          const gate = requireRoleGrant(sessionId, workspacePath);
          if (typeof gate === "string") return denied(gate);
          const credentials = claimCredentialsOf(gate);
          if (credentials === null) return denied(NO_CLAIM_CREDENTIALS);
          // 形状按 grant.role 校验（schema 扁平可选字段是提示，服务端校验是
          // 权威——union schema 在该 pi SDK 的调用侧解析不工作，见参数注释）：
          // 错形状 → validation 文本，不进服务。
          const raw = params as Record<string, unknown>;
          if (gate.role === "developer") {
            if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) {
              return result({
                ok: false,
                error: "validation",
                message:
                  "developer 提交需要 candidates（至少一个 {repositoryId, commit}，取自领取返回的 worktree 清单）"
                  + (raw.design_markdown !== undefined || raw.acceptance_criteria !== undefined
                    ? "——design_markdown/acceptance_criteria 是 designer 角色的形状"
                    : ""),
              });
            }
          } else {
            if (typeof raw.design_markdown !== "string" || raw.design_markdown.trim() === ""
              || !Array.isArray(raw.acceptance_criteria) || raw.acceptance_criteria.length === 0) {
              return result({
                ok: false,
                error: "validation",
                message:
                  "designer 提交需要 design_markdown（设计正文）与 acceptance_criteria（至少一条）"
                  + (raw.candidates !== undefined
                    ? "——candidates 是 developer 角色的形状"
                    : ""),
              });
            }
          }
          try {
            if (gate.role === "developer") {
              const detail = await submitDeveloperResult({
                workspacePath,
                key: raw.key as string,
                attemptId: credentials.attemptId,
                generation: credentials.generation,
                ownerToken: credentials.ownerToken,
                candidates: raw.candidates as Array<{ repositoryId: string; commit: string }>,
                ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
                conversationId: sessionId,
              });
              resetToBareGrant(sessionId, gate);
              return result({
                ok: true,
                message:
                  `候选已提交（${(raw.candidates as unknown[]).length} 个 commit，工作项 ${raw.key}），`
                  + "等待人工验证（record-verification 是人的动作）——本轮到此结束，不要继续推进阶段",
                item: itemSummary(detail.item),
              });
            }
            const detail = await submitDesignerResult({
              workspacePath,
              key: raw.key as string,
              attemptId: credentials.attemptId,
              generation: credentials.generation,
              ownerToken: credentials.ownerToken,
              designContent: raw.design_markdown as string,
              acceptanceCriteria: [...(raw.acceptance_criteria as string[])],
              requestId: `submit:${sessionId}:${credentials.attemptId}`,
              conversationId: sessionId,
            });
            resetToBareGrant(sessionId, gate);
            return result({
              ok: true,
              message:
                `设计已提交（design.md 写入 ${raw.key}），等待人工确认（confirm-design）——本轮到此结束，不要继续推进阶段`,
              item: itemSummary(detail.item),
            });
          } catch (error) {
            const guidance = error instanceof WorkItemConflictError
              ? error.message.includes("no active claim")
                ? "领取已不存在（可能已提交过或已被释放）——不要重复提交，结束本轮"
                : gate.role === "developer"
                  ? RELEASE_VIA_FAIL_GUIDANCE_DEVELOPER
                  : RELEASE_VIA_FAIL_GUIDANCE_DESIGNER
              : undefined;
            return errorResult(error, guidance);
          }
        },
      });

      pi.registerTool({
        name: "delivery_fail_task",
        label: "Fail / Release Delivery Task",
        description:
          "Report failure and release the claimed task in your role (designer: design→intake; "
          + "developer: implementation→ready_for_implementation; blocked=true marks the item "
          + "blocked — still claimable once unblocked). Also used to release a claim invalidated "
          + "by a human action, per the submit tool's conflict guidance. Credentials are server-held.",
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
            const failInput = {
              workspacePath,
              key: params.key,
              attemptId: credentials.attemptId,
              generation: credentials.generation,
              ownerToken: credentials.ownerToken,
              reason: params.reason,
              ...(params.blocked !== undefined ? { blocked: params.blocked } : {}),
            };
            const detail = gate.role === "developer"
              ? await failDeveloperTask(failInput)
              : await failDesignerTask(failInput);
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
