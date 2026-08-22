import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createWorkItem,
  listWorkItems,
  readWorkItem,
  recordWorkItemMilestone,
  updateWorkItem,
} from "./service.ts";
import type {
  WorkItemPhase,
  WorkItemPriority,
  WorkItemStatus,
  WorkItemType,
} from "./types.ts";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

export function createWorkspaceWorkItemExtension(
  workspaceId: string,
  workspacePath: string,
): InlineExtension {
  return {
    name: "pi-workspace-work-items",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "workspace_list_work_items",
        label: "List Workspace Work Items",
        description: "List Requirements and Bugs in the current Pi Workspace. Archived items are excluded unless archived=true.",
        promptSnippet: "List file-backed Requirements and Bugs for this Workspace",
        parameters: Type.Object({
          type: Type.Optional(Type.Union([
            Type.Literal("requirement"),
            Type.Literal("bug"),
          ])),
          archived: Type.Optional(Type.Boolean({
            description: "Return archived items instead of active ones. Default false.",
          })),
        }),
        execute: async (_callId, params) => {
          const data = await listWorkItems(workspacePath);
          const source = params.archived ? data.archivedItems : data.items;
          return result({
            items: params.type
              ? source.filter((item) => item.type === params.type)
              : source,
          });
        },
      });

      pi.registerTool({
        name: "workspace_get_work_item",
        label: "Read Workspace Work Item",
        description: "Read a Work Item's structured metadata, Markdown body, and execution timeline.",
        parameters: Type.Object({
          key: Type.String({ description: "Human key such as REQ-0001 or BUG-0001" }),
        }),
        execute: async (_callId, params) => result(await readWorkItem(workspacePath, params.key)),
      });

      pi.registerTool({
        name: "workspace_create_work_item",
        label: "Create Workspace Work Item",
        description: "Create a file-backed Requirement or Bug while preserving the user's original description.",
        promptGuidelines: [
          "Use workspace_create_work_item when the user explicitly asks to record a new Requirement or Bug.",
          "Do not rewrite original_description; preserve the user's wording.",
        ],
        parameters: Type.Object({
          type: Type.Union([Type.Literal("requirement"), Type.Literal("bug")]),
          title: Type.String(),
          original_description: Type.String(),
          priority: Type.Optional(Type.Union([
            Type.Literal("P0"),
            Type.Literal("P1"),
            Type.Literal("P2"),
            Type.Literal("P3"),
          ])),
          repositories: Type.Optional(Type.Array(Type.String())),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => result(
          await createWorkItem(workspaceId, {
            type: params.type as WorkItemType,
            title: params.title,
            originalDescription: params.original_description,
            ...(params.priority ? { priority: params.priority as WorkItemPriority } : {}),
            ...(params.repositories ? { repositories: params.repositories } : {}),
            ...(params.tags ? { tags: params.tags } : {}),
            actor: "agent",
            conversationId: ctx.sessionManager.getSessionId(),
          }),
        ),
      });

      pi.registerTool({
        name: "workspace_update_work_item",
        label: "Update Workspace Work Item",
        description: "Revision-safely update Work Item status, phase, priority, scope, or title.",
        promptGuidelines: [
          "Read the Work Item first and pass its current revision as expected_revision.",
          "Record only meaningful workflow changes; detailed reasoning belongs in README.md or the Conversation.",
        ],
        parameters: Type.Object({
          key: Type.String(),
          expected_revision: Type.Integer({ minimum: 1 }),
          title: Type.Optional(Type.String()),
          status: Type.Optional(Type.Union([
            Type.Literal("open"),
            Type.Literal("in_progress"),
            Type.Literal("blocked"),
            Type.Literal("done"),
            Type.Literal("cancelled"),
          ])),
          phase: Type.Optional(Type.Union([
            Type.Literal("intake"),
            Type.Literal("analysis"),
            Type.Literal("requirement_approval"),
            Type.Literal("design"),
            Type.Literal("plan_approval"),
            Type.Literal("implementation"),
            Type.Literal("verification"),
            Type.Literal("complete"),
          ])),
          priority: Type.Optional(Type.Union([
            Type.Literal("P0"),
            Type.Literal("P1"),
            Type.Literal("P2"),
            Type.Literal("P3"),
          ])),
          repositories: Type.Optional(Type.Array(Type.String())),
          tags: Type.Optional(Type.Array(Type.String())),
          archived: Type.Optional(Type.Boolean()),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => {
          const conversationId = ctx.sessionManager.getSessionId();
          const current = await readWorkItem(workspacePath, params.key);
          return result(await updateWorkItem(workspaceId, params.key, {
            expectedRevision: params.expected_revision,
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.status !== undefined ? { status: params.status as WorkItemStatus } : {}),
            ...(params.phase !== undefined ? { phase: params.phase as WorkItemPhase } : {}),
            ...(params.priority !== undefined ? { priority: params.priority as WorkItemPriority } : {}),
            ...(params.repositories !== undefined ? { repositories: params.repositories } : {}),
            ...(params.tags !== undefined ? { tags: params.tags } : {}),
            ...(params.archived !== undefined ? { archived: params.archived } : {}),
            conversations: [...new Set([...current.item.conversations, conversationId])],
            actor: "agent",
            conversationId,
          }));
        },
      });

      pi.registerTool({
        name: "workspace_record_milestone",
        label: "Record Workspace Milestone",
        description: "Append a concise execution milestone to a Work Item without changing its revision.",
        parameters: Type.Object({
          key: Type.String(),
          type: Type.String({ description: "Stable event type, for example analysis.completed" }),
          summary: Type.String(),
          expected_revision: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        execute: async (_callId, params, _signal, _update, ctx) => result(
          await recordWorkItemMilestone(workspaceId, params.key, {
            ...(params.expected_revision !== undefined
              ? { expectedRevision: params.expected_revision }
              : {}),
            type: params.type,
            actor: "agent",
            conversationId: ctx.sessionManager.getSessionId(),
            data: { summary: params.summary },
          }),
        ),
      });
    },
  };
}
