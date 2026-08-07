/**
 * Workspace extension that registers the `subagent` tool.
 *
 * The tool delegates a task to a specialized subagent running in its OWN
 * isolated pi process with a fresh context window. Internal steps stay
 * isolated; only the worker's final result returns to this conversation.
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
  type WorkerDetails,
  type WorkerResult,
} from "./worker.ts";

const MAX_PARALLEL = 8;
const CONCURRENCY = 4;
const PER_TASK_CAP = 50 * 1024;

function truncateOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PER_TASK_CAP) return text;
  return `${text.slice(0, PER_TASK_CAP)}\n\n[output truncated: full text preserved in tool details]`;
}

function workerOutput(result: WorkerResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || result.output || "(no output)";
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
          "Delegate a task to a specialized subagent that runs in its OWN isolated pi process with a fresh context window.",
          "Modes: single {agent, task} or parallel {tasks:[{agent,task,cwd?}]}.",
          "Each subagent is a real independent agent; its internal steps are isolated, only its final result returns here.",
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

            const streamParallel = onUpdate
              ? (partial: { text: string; details: { mode: "parallel"; results: WorkerResult[] } }) =>
                  onUpdate({
                    content: [{ type: "text" as const, text: partial.text }],
                    details: partial.details,
                  })
              : undefined;

            const results = await runParallel(
              params.tasks.map((t) => ({ agent: findAgent(t.agent) as AgentConfig, task: t.task, cwd: t.cwd ?? defaultCwd })),
              CONCURRENCY,
              signal,
              streamParallel,
            );

            const succeeded = results.filter((r) => !isFailedResult(r)).length;
            const summary = results
              .map((r) => {
                const status = isFailedResult(r)
                  ? `failed${r.stopReason && r.stopReason !== "error" ? ` (${r.stopReason})` : ""}`
                  : "completed";
                return `### [${r.agent}] ${status}\n\n${truncateOutput(workerOutput(r))}`;
              })
              .join("\n\n---\n\n");

            return {
              content: [{ type: "text" as const, text: `Parallel: ${succeeded}/${results.length} succeeded\n\n${summary}` }],
              details: { mode: "parallel" as const, results },
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
            const streamSingle = onUpdate
              ? (partial: { text: string; details: WorkerDetails }) =>
                  onUpdate({
                    content: [{ type: "text" as const, text: partial.text }],
                    details: partial.details,
                  })
              : undefined;
            const result = await runWorker({ agent, task: params.task, cwd: defaultCwd, signal, onUpdate: streamSingle });
            if (isFailedResult(result)) {
              return {
                content: [{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${workerOutput(result)}` }],
                details: { mode: "single" as const, results: [result] },
                isError: true,
              };
            }
            return {
              content: [{ type: "text" as const, text: result.output || "(no output)" }],
              details: { mode: "single" as const, results: [result] },
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
            details: { mode: "single" as const, results: [] },
          };
        },
      });
    },
  };
}
