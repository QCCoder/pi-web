/**
 * Workspace extension that registers the `subagent` tool.
 *
 * The tool delegates a task to a specialized subagent running as its OWN
 * first-class session (own context window, own model/tools), linked to this
 * conversation as a child. Internal steps stay isolated in that child session;
 * only streamed status + the final result return here. The child session is
 * fully viewable — open it from the tool result to inspect the whole run live.
 *
 * Modes:
 *   - single:  { agent, task }
 *   - parallel:{ tasks: [{ agent, task, cwd? }] }
 *
 * This is the reusable "real subagent" capability. The Loop runtime (and any
 * workspace with the `subagent` capability) consumes it; nothing here is
 * loop-specific.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import {
  isFailedResult,
  runParallel,
  runWorker,
  type ModelSpec,
  type WorkerDetails,
  type WorkerResult,
} from "./worker.ts";

const MAX_PARALLEL = 8;
const CONCURRENCY = 4;
const PER_TASK_CAP = 50 * 1024;

function truncateOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PER_TASK_CAP) return text;
  return `${text.slice(0, PER_TASK_CAP)}\n\n[output truncated; open the child session to see the full run]`;
}

function workerOutput(result: WorkerResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.output || "(no output)";
  }
  return result.output || "(no output)";
}

function agentLine(agent: AgentConfig): string {
  return `- "${agent.name}" (${agent.source}): ${agent.description}`;
}

function availableAgentsText(agents: AgentConfig[]): string {
  return `Available agents:\n${agents.map(agentLine).join("\n")}`;
}

export function createSubagentExtension(_workspaceId: string, workspacePath: string): InlineExtension {
  return {
    name: "pi-subagent",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
          "Delegate a task to a specialized subagent that runs as its OWN session with a fresh context window, linked to this conversation as a child.",
          "Modes: single {agent, task} or parallel {tasks:[{agent,task,cwd?}]}.",
          "Each subagent's full run is viewable: open its child session from the result. Internal steps stay isolated from this conversation.",
        ].join(" "),
        promptGuidelines: [
          "Use the subagent tool to isolate a self-contained sub-task so it does not pollute this conversation's context.",
          "The subagent has NOT seen this conversation — pass a concrete, fully-specified task.",
          "Prefer parallel mode for independent sub-tasks; use single mode when tasks depend on each other.",
        ],
        parameters: Type.Object({
          agent: Type.Optional(Type.String({ description: "Name of the subagent to invoke (single mode)" })),
          task: Type.Optional(Type.String({ description: "Self-contained task to delegate (single mode)" })),
          tasks: Type.Optional(
            Type.Array(
              Type.Object({
                agent: Type.String({ description: "Name of the subagent to invoke" }),
                task: Type.String({ description: "Self-contained task to delegate" }),
                cwd: Type.Optional(Type.String({ description: "Working directory (defaults to this workspace)" })),
              }),
              { description: "Multiple {agent,task} to run concurrently (parallel mode)" },
            ),
          ),
          cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to this workspace)" })),
        }),

        execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
          const agents = discoverAgents(workspacePath);
          const findAgent = (name: string): AgentConfig | undefined => agents.find((a) => a.name === name);
          const defaultCwd = params.cwd ?? ctx.cwd;
          const parentSessionFile = ctx.sessionManager.getSessionFile() ?? "";
          const parentModel: ModelSpec | undefined = ctx.model
            ? { provider: ctx.model.provider, modelId: ctx.model.id }
            : undefined;

          const streamSingle = onUpdate
            ? (partial: { text: string; details: WorkerDetails }) =>
                onUpdate({
                  content: [{ type: "text" as const, text: partial.text }],
                  details: { mode: "single" as const, childSessionId: partial.details.childSessionId },
                })
            : undefined;

          const streamParallel = onUpdate
            ? (partial: { text: string; details: { mode: "parallel"; results: WorkerResult[] } }) =>
                onUpdate({
                  content: [{ type: "text" as const, text: partial.text }],
                  details: {
                    mode: "parallel" as const,
                    results: partial.details.results.map((r) => ({ agent: r.agent, childSessionId: r.childSessionId })),
                  },
                })
            : undefined;

          // ---- parallel mode ----
          if (params.tasks && params.tasks.length > 0) {
            if (params.tasks.length > MAX_PARALLEL) {
              return {
                content: [{ type: "text" as const, text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL}.` }],
                details: { mode: "parallel" as const, results: [] },
              };
            }
            const missing = params.tasks.filter((t) => !findAgent(t.agent));
            if (missing.length > 0) {
              return {
                content: [{ type: "text" as const, text: `Unknown agent(s): ${missing.map((m) => m.agent).join(", ")}.\n${availableAgentsText(agents)}` }],
                details: { mode: "parallel" as const, results: [] },
              };
            }

            const results = await runParallel(
              params.tasks.map((t) => ({ agent: findAgent(t.agent) as AgentConfig, task: t.task, cwd: t.cwd ?? defaultCwd })),
              CONCURRENCY,
              { parentSessionFile, parentModel, signal },
              streamParallel,
            );

            const succeeded = results.filter((r) => !isFailedResult(r)).length;
            const summary = results
              .map((r) => {
                const status = isFailedResult(r)
                  ? `failed${r.stopReason && r.stopReason !== "error" ? ` (${r.stopReason})` : ""}`
                  : "completed";
                return `### [${r.agent}] ${status} — session ${r.childSessionId}\n\n${truncateOutput(workerOutput(r))}`;
              })
              .join("\n\n---\n\n");

            return {
              content: [{ type: "text" as const, text: `Parallel: ${succeeded}/${results.length} succeeded\n\n${summary}` }],
              details: {
                mode: "parallel" as const,
                results: results.map((r) => ({ agent: r.agent, childSessionId: r.childSessionId })),
              },
            };
          }

          // ---- single mode ----
          if (params.agent && params.task) {
            const agent = findAgent(params.agent);
            if (!agent) {
              return {
                content: [{ type: "text" as const, text: `Unknown agent "${params.agent}".\n${availableAgentsText(agents)}` }],
                details: { mode: "single" as const, results: [] },
              };
            }
            const result = await runWorker({
              agent,
              task: params.task,
              cwd: defaultCwd,
              parentSessionFile,
              parentModel,
              signal,
              onUpdate: streamSingle,
            });
            if (isFailedResult(result)) {
              return {
                content: [{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${workerOutput(result)}` }],
                details: { mode: "single" as const, childSessionId: result.childSessionId },
                isError: true,
              };
            }
            return {
              content: [{ type: "text" as const, text: `${result.output || "(no output)"}\n\n_Subagent session: ${result.childSessionId}_` }],
              details: { mode: "single" as const, childSessionId: result.childSessionId },
            };
          }

          // ---- no/invalid params ----
          return {
            content: [
              {
                type: "text" as const,
                text: `Provide {agent, task} for a single subagent, or {tasks:[...]} for parallel.\n${availableAgentsText(agents)}`,
              },
            ],
            details: { mode: "single" as const },
          };
        },
      });
    },
  };
}
